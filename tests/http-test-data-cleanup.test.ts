import { strict as assert } from 'node:assert';
import { afterEach, describe, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { createSecretStore } from '../src/server/security/secret-store.js';
import * as orchestration from '../src/server/runs/orchestrator.js';
import type { TestDataManager } from '../src/server/runs/test-data.js';
import { createHttpTestDataCleanupAdapter } from '../src/server/runs/http-test-data-cleanup.js';
import { createTestDataManager } from '../src/server/runs/test-data.js';

const RUN = '01K00000000000000000000000';
const TOKEN = 'synthetic-cleanup-token-12345678901234567890';
const secrets = { get: () => TOKEN };
const entry = { id: `luowang-${RUN}-account`, cleanupScope: 'website-accounts' as const };
const endpoint = 'http://website:3100/api/luowang/test-data';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Run-scoped HTTP cleanup adapter', () => {
  it.each([false, true])(
    'wires the default application manager from deployment configuration: %s',
    async (enabled) => {
      const directory = await mkdtemp(join(tmpdir(), 'cleanup-app-'));
      const config = loadConfig({
        NODE_ENV: 'test',
        LUOWANG_DATA_DIR: directory,
        LUOWANG_MASTER_KEY: 'synthetic-app-cleanup-master',
        ...(enabled ? { LUOWANG_TEST_DATA_CLEANUP_URL: endpoint } : {}),
      });
      const database = initializeDatabase(config);
      const secretStore = createSecretStore(database.sqlite, config.masterKey);
      secretStore.set('testDataCleanupToken', TOKEN);
      const holder: { manager?: TestDataManager } = {};
      const original = orchestration.createRunOrchestrator;
      vi.spyOn(orchestration, 'createRunOrchestrator').mockImplementation((options) => {
        holder.manager = options.testData;
        return original(options);
      });
      const methods: string[] = [];
      vi.stubGlobal('fetch', (async (url, options) => {
        assert.equal(url, endpoint + '/' + RUN);
        assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${TOKEN}`);
        methods.push(options!.method!);
        return Response.json({ runId: RUN, remaining: 0 });
      }) as typeof fetch);
      const app = await createApp({
        config,
        database,
        secretStore,
        logger: pino({ level: 'silent' }),
        backgroundTasks: false,
      });
      try {
        assert.ok(holder.manager);
        assert.equal(holder.manager.cleanupAvailable, enabled);
        await holder.manager.register(RUN, entry);
        assert.equal((await holder.manager.cleanup(RUN)).ok, enabled);
        assert.deepEqual(methods, enabled ? ['DELETE', 'GET'] : []);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('deletes only the bound Run, then independently queries, without returning remote content', async () => {
    const calls: string[] = [];
    const request = (async (url, options) => {
      assert.equal(url, endpoint + '/' + RUN);
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${TOKEN}`);
      calls.push(options!.method!);
      return Response.json({ runId: RUN, remaining: 0, untrustedExtra: TOKEN });
    }) as typeof fetch;
    const adapter = createHttpTestDataCleanupAdapter(endpoint, secrets, request);
    const result = await adapter.cleanupAndVerify({ runId: RUN, entry });
    assert.deepEqual(calls, ['DELETE', 'GET']);
    assert.equal(result.absent, true);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it('leaves unbound registrations pending and does not upgrade their domain by duplicate registration', async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return Response.json({ runId: RUN, remaining: 0 });
    }) as typeof fetch;
    const adapter = createHttpTestDataCleanupAdapter(endpoint, secrets, request);
    const manager = createTestDataManager({ cleanupAdapter: adapter });
    await manager.register(RUN, { id: entry.id });
    await manager.register(RUN, entry);
    assert.equal((await manager.cleanup(RUN)).ok, false);
    assert.match(manager.finalize(RUN).pending[0]!.rejectionReason!, /残留待人工处理/);
    await assert.rejects(
      adapter.cleanupAndVerify({
        runId: RUN,
        entry: { ...entry, cleanupScope: 'other' as 'website-accounts' },
      }),
    );
    assert.equal(calls, 0);
  });

  it('does not repeat verified cleanup and independently verifies an already empty namespace', async () => {
    let calls = 0;
    const adapter = createHttpTestDataCleanupAdapter(endpoint, secrets, (async () => {
      calls++;
      return Response.json({ runId: RUN, remaining: 0 });
    }) as typeof fetch);
    const manager = createTestDataManager({ cleanupAdapter: adapter });
    await manager.register(RUN, entry);
    assert.equal((await manager.cleanup(RUN)).ok, true);
    assert.equal((await manager.cleanup(RUN)).attempted, 0);
    assert.equal((await adapter.cleanupAndVerify({ runId: RUN, entry })).absent, true);
    assert.equal(calls, 4);
  });

  it('rejects invalid URLs, scope and absent credentials before sending a request', async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch;
    for (const url of [
      'file:///data/db',
      'not-a-url',
      'https://user:password@host/api',
      'https://host/api?token=x',
      'https://host/api#x',
    ]) {
      assert.throws(() => createHttpTestDataCleanupAdapter(url, secrets, request));
    }
    const adapter = createHttpTestDataCleanupAdapter(endpoint, secrets, request);
    await assert.rejects(adapter.cleanupAndVerify({ runId: '../other', entry }));
    await assert.rejects(adapter.cleanupAndVerify({ runId: RUN, entry: { id: 'other' } }));
    const missing = createHttpTestDataCleanupAdapter(endpoint, { get: () => undefined }, request);
    await assert.rejects(missing.cleanupAndVerify({ runId: RUN, entry }));
    assert.equal(calls, 0);
  });

  it.each(['denied', 'wrong-run', 'oversized', 'invalid-json', 'network', 'remaining'])(
    'keeps %s failures pending without exposing credentials',
    async (mode) => {
      let calls = 0;
      const request = (async () => {
        calls++;
        if (calls === 1) return Response.json({ runId: RUN, remaining: 0 });
        if (mode === 'network') throw new Error(TOKEN);
        if (mode === 'denied') return new Response(TOKEN, { status: 403 });
        if (mode === 'oversized') return new Response(TOKEN.repeat(200));
        if (mode === 'invalid-json') return new Response(TOKEN);
        return Response.json({
          runId: mode === 'wrong-run' ? 'other' : RUN,
          remaining: mode === 'remaining' ? 1 : 0,
        });
      }) as typeof fetch;
      const manager = createTestDataManager({
        cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, secrets, request),
      });
      await manager.register(RUN, entry);
      const result = await manager.cleanup(RUN);
      assert.equal(result.ok, false);
      assert.equal(manager.finalize(RUN).ok, false);
      assert.ok(!JSON.stringify({ result, final: manager.finalize(RUN) }).includes(TOKEN));
      assert.equal(calls, 2);
    },
  );
});
