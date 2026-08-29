import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe('Fastify application', () => {
  it('serves health, status, and the console shell', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-app-'));
    const webRoot = await mkdtemp(join(tmpdir(), 'luowang-web-'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><html>LuoWang shell</html>');
    cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
    cleanup.push(async () => rm(webRoot, { recursive: true, force: true }));

    const config = loadConfig({
      NODE_ENV: 'test',
      LUOWANG_DATA_DIR: dataDir,
      LUOWANG_WEB_ROOT: webRoot,
    });
    const database = initializeDatabase(config);
    const app = await createApp({ config, database, logger: pino({ level: 'silent' }) });
    cleanup.push(async () => app.close());

    const healthResponse = await app.inject({ method: 'GET', url: '/health' });
    const health = healthResponse.json();
    assert.equal(healthResponse.statusCode, 200);
    assert.equal(health.status, 'ok');
    assert.equal(health.database, 'ok');

    const statusResponse = await app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.json().service, 'luowang');

    const shellResponse = await app.inject({ method: 'GET', url: '/' });
    assert.equal(shellResponse.statusCode, 200);
    assert.match(shellResponse.body, /LuoWang shell/);
  });

  it('returns a stable error envelope for missing API resources', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-error-'));
    cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
    const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: dataDir });
    const database = initializeDatabase(config);
    const app = await createApp({ config, database, logger: pino({ level: 'silent' }) });
    cleanup.push(async () => app.close());

    const response = await app.inject({ method: 'GET', url: '/api/missing' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(Object.keys(response.json()), ['error']);
    assert.equal(response.json().error.code, 'NOT_FOUND');
    assert.equal(typeof response.json().error.requestId, 'string');
  });
});
