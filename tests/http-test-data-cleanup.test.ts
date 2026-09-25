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
import { createTestDataManager, createTestDataTools } from '../src/server/runs/test-data.js';
import { createRunEvidenceStore } from '../src/server/runs/evidence.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';

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
  it('observes only a registered current-Run account through the fixed read-only route', async () => {
    const calls: string[] = [];
    const request = (async (url, options) => {
      calls.push(String(url));
      assert.equal(options?.method, 'GET');
      assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${TOKEN}`);
      return Response.json({ runId: RUN, accounts: 1, argon2id: 1, other: 0 });
    }) as typeof fetch;
    const manager = createTestDataManager({
      cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, secrets, request),
    });
    const captures: unknown[] = [];
    const tools = createTestDataTools(manager, RUN, undefined, async (observation) => {
      captures.push(observation);
      return 'operation-1.json';
    });
    const tool = tools.find((candidate) => candidate.name === 'inspect_test_account_storage')!;
    const execute = () => tool.execute('inspect', {}, undefined, undefined, {} as never);
    assert.equal((await execute()).details?.error, true);
    assert.deepEqual(calls, []);
    await manager.register(RUN, entry);
    const result = await execute();
    assert.equal(result.details?.error, undefined);
    assert.deepEqual(calls, [endpoint + '/' + RUN + '/storage']);
    assert.deepEqual(captures, [{ runId: RUN, accounts: 1, argon2id: 1, other: 0 }]);
    assert.match(JSON.stringify(result.content), /operation-1\.json/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  });

  it('keeps a storage observation in the current Run evidence for independent review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'storage-observation-'));
    try {
      const workspace = new RunWorkspace(RUN, directory);
      await workspace.create();
      const transport = localEvidenceTransport();
      const evidence = createRunEvidenceStore(workspace, transport.oss);
      const manager = createTestDataManager({
        cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, secrets, (async () =>
          Response.json({ runId: RUN, accounts: 1, argon2id: 1, other: 0 })) as typeof fetch),
      });
      await manager.register(RUN, entry);
      const tool = createTestDataTools(manager, RUN, undefined, (observation) =>
        evidence.captureObservation!('a'.repeat(40), {
          source: 'controlled-test-account-storage',
          ...observation,
        }),
      ).find((candidate) => candidate.name === 'inspect_test_account_storage')!;
      const result = await tool.execute('inspect', {}, undefined, undefined, {} as never);
      assert.equal(result.details?.error, undefined);
      assert.deepEqual(evidence.commandEvidenceIds(), ['operation-1.json']);
      await evidence.uploadAll();
      const original = JSON.parse(await evidence.readCommandEvidence('operation-1.json'));
      assert.deepEqual(original.observation, {
        source: 'controlled-test-account-storage',
        runId: RUN,
        accounts: 1,
        argon2id: 1,
        other: 0,
      });
      assert.doesNotMatch(JSON.stringify(original), new RegExp(TOKEN));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['wrong-run', 'bad-count', 'denied', 'oversized'])(
    'rejects %s storage observations without creating evidence',
    async (mode) => {
      let captures = 0;
      const manager = createTestDataManager({
        cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, secrets, (async () => {
          if (mode === 'denied') return new Response(TOKEN, { status: 403 });
          if (mode === 'oversized') return new Response(TOKEN.repeat(100));
          return Response.json({
            runId: mode === 'wrong-run' ? 'other' : RUN,
            accounts: 1,
            argon2id: mode === 'bad-count' ? 0 : 1,
            other: 0,
          });
        }) as typeof fetch),
      });
      await manager.register(RUN, entry);
      const tool = createTestDataTools(manager, RUN, undefined, async () => {
        captures++;
        return 'operation-1.json';
      }).find((candidate) => candidate.name === 'inspect_test_account_storage')!;
      const result = await tool.execute('inspect', {}, undefined, undefined, {} as never);
      assert.equal(result.details?.error, true);
      assert.equal(captures, 0);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
    },
  );
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
