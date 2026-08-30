import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import type { RunOrchestrator } from '../src/server/runs/orchestrator.js';
import type { RunInput } from '../src/server/runs/types.js';
import type { RunDetail, RunSummary } from '../src/shared/types.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 3 Run API', () => {
  it('requires authentication and accepts an authenticated manual/API Run request', async () => {
    const started: RunInput[] = [];
    const { app } = await makeApp({
      runs: fakeRuns(started),
      provider: fakeProvider(),
    });

    const anonymousList = await app.inject({ method: 'GET', url: '/api/runs' });
    assert.equal(anonymousList.statusCode, 401);
    const anonymousStart = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { request: '未认证请求' },
    });
    assert.equal(anonymousStart.statusCode, 401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase3-api-password!' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = firstCookie(login.headers['set-cookie']);

    const list = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { runs: [] });

    const start = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { cookie },
      payload: { request: '验证测试项目', trigger: 'api', targetCommit: 'a'.repeat(40) },
    });
    assert.equal(start.statusCode, 202);
    assert.equal(start.json().runId, '01K00000000000000000000001');
    assert.deepEqual(started, [
      { request: '验证测试项目', trigger: 'api', targetCommit: 'a'.repeat(40) },
    ]);

    const models = await app.inject({
      method: 'GET',
      url: '/api/provider/models',
      headers: { cookie },
    });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.json(), { provider: '', models: [] });
  });
});

async function makeApp(options: { runs: RunOrchestrator; provider: ProviderAdapter }) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase3-api-'));
  cleanup.push(async () => rm(dataDirectory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDirectory,
    LUOWANG_ADMIN_PASSWORD: 'phase3-api-password!',
    LUOWANG_MASTER_KEY: 'phase3-api-master-key',
  });
  const database = initializeDatabase(config);
  const app = await createApp({
    config,
    database,
    logger: pino({ level: 'silent' }),
    runs: options.runs,
    provider: options.provider,
  });
  cleanup.push(async () => app.close());
  return { app };
}

function fakeRuns(started: RunInput[]): RunOrchestrator {
  const summary = emptySummary();
  return {
    start: async (input) => {
      started.push(input);
      return summary;
    },
    run: async () => emptyDetail(),
    wait: async () => null,
    current: async () => null,
    list: async () => [],
    get: async () => null,
    recover: async () => undefined,
  };
}

function fakeProvider(): ProviderAdapter {
  return {
    getRuntime: async () => {
      throw new Error('not used');
    },
    resolveModel: async () => {
      throw new Error('not used');
    },
    listModels: async () => [],
    checkConnectivity: async () => ({
      status: 'not_available',
      message: 'not used',
      checkedAt: null,
      latencyMs: null,
    }),
  };
}

function emptySummary(): RunSummary {
  return {
    runId: '01K00000000000000000000001',
    status: 'queued',
    phase: 'preparing',
    result: null,
    trigger: 'api',
    request: '验证测试项目',
    baseCommit: null,
    targetCommit: 'a'.repeat(40),
    includedCommits: [],
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: null,
    errorMessage: null,
    artifactNames: [],
  };
}

function emptyDetail(): RunDetail {
  return { ...emptySummary(), artifacts: {} };
}

function firstCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
