import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { OssError, type OssAdapter } from '../src/server/storage/oss.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 4 evidence Gateway', () => {
  it('requires authentication and serves only the requested OSS evidence object', async () => {
    const { app } = await makeApp();
    const anonymous = await app.inject({ method: 'GET', url: '/api/evidence/evidence-id' });
    assert.equal(anonymous.statusCode, 401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase4-api-password!' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = firstCookie(login.headers['set-cookie']);

    const response = await app.inject({
      method: 'GET',
      url: '/api/evidence/evidence-id',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'phase4-image');
    assert.match(response.headers['content-type'] ?? '', /^image\/png/);
    assert.equal(response.headers['cache-control'], 'private, no-store');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/evidence/missing-id',
      headers: { cookie },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'OSS_OBJECT_NOT_FOUND');
  });
});

async function makeApp(): Promise<{ app: Awaited<ReturnType<typeof createApp>> }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase4-api-'));
  cleanup.push(async () => rm(dataDirectory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDirectory,
    LUOWANG_ADMIN_PASSWORD: 'phase4-api-password!',
    LUOWANG_MASTER_KEY: 'phase4-api-master-key',
  });
  const database = initializeDatabase(config);
  const app = await createApp({
    config,
    database,
    logger: pino({ level: 'silent' }),
    oss: fakeOss(),
  });
  cleanup.push(async () => app.close());
  return { app };
}

function fakeOss(): OssAdapter {
  return {
    isConfigured: () => true,
    objectKey: (_runId, filename) => filename,
    stableUrlForKey: (key) => `/api/evidence/${key}`,
    uploadFile: async () => {
      throw new Error('not used');
    },
    putObject: async () => undefined,
    getObject: async () => ({
      key: 'phase4-image',
      body: Buffer.from('phase4-image'),
      contentType: 'image/png',
      contentLength: 12,
      etag: null,
    }),
    headObject: async () => ({
      key: 'phase4-image',
      contentType: 'image/png',
      contentLength: 12,
      etag: null,
    }),
    deleteObject: async () => undefined,
    getEvidenceByStableId: async (stableId) => {
      if (stableId === 'missing-id') {
        throw new OssError('OSS_OBJECT_NOT_FOUND', 'OSS 对象不存在');
      }
      if (stableId !== 'evidence-id') {
        throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象标识无效');
      }
      return {
        key: 'phase4-image',
        body: Buffer.from('phase4-image'),
        contentType: 'image/png',
        contentLength: 12,
        etag: null,
      };
    },
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'ok',
      checkedAt: null,
      latencyMs: 1,
    }),
  };
}

function firstCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
