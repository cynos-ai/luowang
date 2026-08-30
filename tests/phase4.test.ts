import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it } from 'vitest';

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import {
  browserNeedsVision,
  browserScenarioRequested,
  createPlaywrightMcpAdapter,
  PLAYWRIGHT_MCP_VERSION,
} from '../src/server/browser/playwright-mcp.js';
import {
  createReviewerEvidenceTools,
  createRunEvidenceStore,
} from '../src/server/runs/evidence.js';
import { createTestDataManager } from '../src/server/runs/test-data.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { createOssAdapter, type OssAdapter, type S3ClientLike } from '../src/server/storage/oss.js';
import type { SecretStore } from '../src/server/security/secret-store.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 4 browser and evidence boundaries', () => {
  it('uses stable S3-compatible keys and completes put/get/head/delete', async () => {
    const fixture = await createStorageFixture();
    const object = Buffer.from('phase4 evidence', 'utf8');
    const filePath = join(fixture.directory, 'login.png');
    await writeFile(filePath, object);

    const reference = await fixture.oss.uploadFile(
      '01K00000000000000000000001',
      'login.png',
      filePath,
    );

    assert.equal(reference.objectKey, 'phase4/01K00000000000000000000001/login.png');
    assert.equal(
      reference.url,
      'https://cdn.example.test/evidence/phase4/01K00000000000000000000001/login.png',
    );
    assert.equal(reference.url.includes('?'), false);
    assert.deepEqual(await fixture.oss.getObject(reference.objectKey), {
      key: reference.objectKey,
      body: object,
      contentType: 'image/png',
      contentLength: object.byteLength,
      etag: '"phase4"',
    });
    assert.equal((await fixture.oss.headObject(reference.objectKey)).contentLength, object.length);

    await fixture.oss.deleteObject(reference.objectKey);
    await assert.rejects(() => fixture.oss.getObject(reference.objectKey));
  });

  it('returns a private stable gateway address when no public base URL is configured', async () => {
    const fixture = await createStorageFixture({ publicBaseUrl: '' });
    const key = fixture.oss.objectKey('01K00000000000000000000001', 'nested/screenshot.webp');
    const url = fixture.oss.stableUrlForKey(key);
    assert.equal(url.startsWith('/api/evidence/'), true);
    assert.equal(url.includes('?'), false);
    assert.equal(url.includes('signature'), false);
  });

  it('keeps Playwright MCP headless, isolated, snapshot-based, and without unsafe tools', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const database = initializeDatabase(config);
    cleanup.push(async () => database.close());
    const configuration = createConfigurationStore(database.sqlite, {
      repoDir: config.repoDir,
      reportDir: config.reportDir,
    });
    configuration.updateHarness({
      mcp: { enabled: true, browser: 'chromium', headless: false, timeoutMs: 12_000 },
    });
    const adapter = createPlaywrightMcpAdapter(configuration, {
      probe: async () => ({
        toolNames: ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'],
      }),
    });
    const definition = adapter.serverDefinition('C:/runs/evidence');
    assert.ok(definition.args.includes(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`));
    assert.ok(definition.args.includes('--headless'));
    assert.ok(definition.args.includes('--isolated'));
    assert.ok(definition.args.includes('--browser=chromium'));
    assert.ok(definition.args.includes('--snapshot-mode=full'));
    assert.ok(definition.args.includes('--codegen=none'));
    assert.ok(definition.args.includes('--output-dir=C:/runs/evidence'));
    assert.ok(definition.excludeTools.includes('browser_evaluate'));
    assert.ok(definition.excludeTools.includes('browser_run_code_unsafe'));
    assert.equal((await adapter.checkConnectivity()).status, 'ok');
    assert.equal(browserScenarioRequested('登录页面点击提交按钮'), true);
    assert.equal(browserNeedsVision('核对截图差异'), true);
    assert.equal(browserNeedsVision('登录成功后保存 screenshot 证据'), false);
  });

  it('blocks cleanup when data was registered without a real cleanup adapter', async () => {
    const manager = createTestDataManager();
    await manager.register('01K00000000000000000000001', { id: 'luowang-test-user-1' });

    const result = await manager.cleanup('01K00000000000000000000001');

    assert.equal(result.ok, false);
    assert.equal(result.attempted, 1);
    assert.deepEqual(result.failed, ['luowang-test-user-1']);
    assert.match(result.message, /清理适配器/);
  });

  it('passes registered data to the cleanup adapter and forgets it after success', async () => {
    const calls: Array<{ runId: string; ids: string[] }> = [];
    const manager = createTestDataManager({
      cleanup: async (runId, entries) => {
        calls.push({ runId, ids: entries.map((entry) => entry.id) });
        return [];
      },
    });
    const runId = '01K00000000000000000000001';
    await manager.register(runId, { id: 'luowang-test-user-1' });

    const first = await manager.cleanup(runId);
    const second = await manager.cleanup(runId);

    assert.equal(first.ok, true);
    assert.equal(first.attempted, 1);
    assert.equal(second.attempted, 0);
    assert.deepEqual(calls, [
      { runId, ids: ['luowang-test-user-1'] },
      { runId, ids: [] },
    ]);
  });

  it('lets Reviewer read only uploaded image evidence as image content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luowang-phase4-evidence-'));
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    const workspace = new RunWorkspace('01K00000000000000000000001', directory);
    await workspace.create();
    await writeFile(join(workspace.evidenceDirectory, 'login.png'), Buffer.from('png-bytes'));
    const store = createRunEvidenceStore(workspace, fakeOss());
    const upload = await store.uploadAll();
    assert.equal(upload.failures.length, 0);
    const tool = createReviewerEvidenceTools(store).find(
      (candidate) => candidate.name === 'read_evidence_image',
    );
    assert.ok(tool);
    const result = (await tool.execute(
      'read',
      { filename: 'login.png' } as never,
      undefined,
      undefined,
      {} as never,
    )) as AgentToolResult<Record<string, unknown>>;
    assert.equal(
      result.content.some((item) => item.type === 'image'),
      true,
    );
    assert.equal(
      createReviewerEvidenceTools(store).some((item) => item.name === 'run_fixture_command'),
      false,
    );
    assert.equal(
      (await readFile(join(workspace.evidenceDirectory, 'login.png'))).toString(),
      'png-bytes',
    );
  });
});

interface StorageFixture {
  directory: string;
  oss: OssAdapter;
}

async function createStorageFixture(
  overrides: { publicBaseUrl?: string } = {},
): Promise<StorageFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-phase4-storage-'));
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: directory });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateHarness({
    oss: {
      endpoint: 'https://oss.example.test',
      region: 'test-region',
      bucket: 'test-bucket',
      publicBaseUrl: overrides.publicBaseUrl ?? 'https://cdn.example.test/evidence',
      accessMode: 'private',
      objectPrefix: 'phase4',
    },
  });
  const client = new MemoryS3Client();
  const oss = createOssAdapter(configuration, fakeSecretStore(), {
    clientFactory: () => client,
    randomId: () => 'connectivity-test',
  });
  return { directory, oss };
}

function fakeOss(): OssAdapter {
  const objects = new Map<string, Buffer>();
  return {
    isConfigured: () => true,
    objectKey: (runId, filename) => `${runId}/${filename}`,
    stableUrlForKey: (key) => `/api/evidence/${Buffer.from(key).toString('base64url')}`,
    uploadFile: async (runId, filename, filePath) => {
      const body = await readFile(filePath);
      const key = `${runId}/${filename}`;
      objects.set(key, Buffer.from(body));
      return {
        id: Buffer.from(key).toString('base64url'),
        filename,
        objectKey: key,
        url: `/api/evidence/${Buffer.from(key).toString('base64url')}`,
        contentType: 'image/png',
        sizeBytes: body.byteLength,
        sha256: 'test-sha256',
        uploadedAt: '2026-08-30T00:00:00.000Z',
      };
    },
    putObject: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    getObject: async (key) => ({
      key,
      body: objects.get(key) ?? Buffer.from('png-bytes'),
      contentType: 'image/png',
      contentLength: (objects.get(key) ?? Buffer.from('png-bytes')).byteLength,
      etag: null,
    }),
    headObject: async (key) => ({
      key,
      contentType: 'image/png',
      contentLength: objects.get(key)?.byteLength ?? 0,
      etag: null,
    }),
    deleteObject: async (key) => {
      objects.delete(key);
    },
    getEvidenceByStableId: async (id) => ({
      key: id,
      body: objects.get(id) ?? Buffer.from('png-bytes'),
      contentType: 'image/png',
      contentLength: (objects.get(id) ?? Buffer.from('png-bytes')).byteLength,
      etag: null,
    }),
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'ok',
      checkedAt: '2026-08-30T00:00:00.000Z',
      latencyMs: 1,
    }),
  };
}

function fakeSecretStore(): SecretStore {
  const values = new Map<string, string>([
    ['ossAccessKeyId', 'test-access-id'],
    ['ossAccessKeySecret', 'test-access-secret'],
  ]);
  return {
    isAvailable: () => true,
    set: (key, value) => values.set(key, value),
    get: (key) => values.get(key),
    has: (key) => values.has(key),
    delete: (key) => values.delete(key),
    metadata: () => ({}) as SecretStore['metadata'] extends () => infer T ? T : never,
  };
}

class MemoryS3Client implements S3ClientLike {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async send(command: unknown): Promise<unknown> {
    const input = (command as { input: { Key: string; Body?: unknown; ContentType?: string } })
      .input;
    const name = (command as { constructor: { name: string } }).constructor.name;
    if (name === 'PutObjectCommand') {
      this.objects.set(input.Key, {
        body: Buffer.from(input.Body as Uint8Array),
        contentType: input.ContentType ?? 'application/octet-stream',
      });
      return {};
    }
    if (name === 'GetObjectCommand') {
      const object = this.objects.get(input.Key);
      if (!object) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return {
        Body: object.body,
        ContentType: object.contentType,
        ContentLength: object.body.byteLength,
        ETag: '"phase4"',
      };
    }
    if (name === 'HeadObjectCommand') {
      const object = this.objects.get(input.Key);
      if (!object) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {
        ContentType: object.contentType,
        ContentLength: object.body.byteLength,
        ETag: '"phase4"',
      };
    }
    if (name === 'DeleteObjectCommand') {
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error(`unsupported command ${name}`);
  }
}
