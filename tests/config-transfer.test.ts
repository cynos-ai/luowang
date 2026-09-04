import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';
import { stringify } from 'yaml';

import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { exportConfigurationYaml, parseConfigurationYaml } from '../src/server/config-transfer.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { initializeDatabase } from '../src/server/db/migrate.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('versioned YAML configuration transfer', () => {
  it('round-trips complete ordinary configuration without adding secrets', () => {
    const input = fixtureConfiguration();
    const yaml = exportConfigurationYaml(input);
    assert.equal(yaml.includes('secrets'), false);
    assert.equal(yaml.includes('token'), false);
    assert.deepEqual(parseConfigurationYaml(yaml), input);
  });

  it('rejects aliases, duplicate keys, unknown fields, versions and secrets', () => {
    for (const yaml of [
      'version: 1\nharness: &shared {}\nrepository: *shared\n',
      'version: 1\nversion: 1\nharness: {}\nrepository: {}\n',
      'version: 1\nharness: {}\nrepository: {}\nunknown: true\n',
      'version: 2\nharness: {}\nrepository: {}\n',
      'version: 1\nharness: {}\nrepository: {}\nsecrets:\n  gitToken: unsafe\n',
    ]) {
      assert.throws(() => parseConfigurationYaml(yaml), /配置|YAML|version|secrets/);
    }
  });

  it('exports through authenticated API and imports atomically without changing Secret Store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-config-transfer-'));
    cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
    const config = loadConfig({
      NODE_ENV: 'test',
      LUOWANG_DATA_DIR: dataDir,
      LUOWANG_ADMIN_PASSWORD: 'configuration-transfer-password!',
      LUOWANG_MASTER_KEY: 'configuration-transfer-master-key',
    });
    const database = initializeDatabase(config);
    const configuration = createConfigurationStore(database.sqlite, {
      repoDir: config.repoDir,
      reportDir: config.reportDir,
    });
    const app = await createApp({
      config,
      database,
      configuration,
      logger: pino({ level: 'silent' }),
      backgroundTasks: false,
    });
    cleanup.push(async () => app.close());

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/config/export' });
    assert.equal(unauthenticated.statusCode, 401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'configuration-transfer-password!' },
    });
    const cookie = firstCookie(login.headers['set-cookie']);
    const secretValue = 'provider-secret-never-exported';
    const saveSecret = await app.inject({
      method: 'PUT',
      url: '/api/config/harness',
      headers: { cookie },
      payload: { secrets: { providerApiKey: secretValue } },
    });
    assert.equal(saveSecret.statusCode, 200);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/config/export',
      headers: { cookie },
    });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.body.includes(secretValue), false);
    assert.equal(exported.body.includes('••••••••'), false);
    const ordinary = parseConfigurationYaml(exported.json().yaml);
    ordinary.harness.provider = 'deepseek';
    ordinary.repository.pollIntervalSeconds = 600;

    const imported = await app.inject({
      method: 'POST',
      url: '/api/config/import',
      headers: { cookie },
      payload: { yaml: exportConfigurationYaml(ordinary) },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().harness.provider, 'deepseek');
    assert.equal(imported.json().repository.pollIntervalSeconds, 600);
    assert.equal(imported.json().secrets.providerApiKey.configured, true);
    assert.equal(imported.body.includes(secretValue), false);

    const broken = structuredClone(ordinary) as unknown as Record<string, unknown>;
    (broken.harness as Record<string, unknown>).provider = 'must-roll-back';
    (broken.repository as Record<string, unknown>).pollIntervalSeconds = 'invalid';
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/config/import',
      headers: { cookie },
      payload: { yaml: stringify({ version: 1, ...broken }) },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(configuration.getHarness().provider, 'deepseek');
    assert.equal(configuration.getRepository().pollIntervalSeconds, 600);
  });
});

function fixtureConfiguration() {
  return {
    harness: {
      language: 'zh-CN',
      provider: 'deepseek',
      providerBaseUrl: 'https://models.example.test/v1',
      agents: {
        main: { model: 'deepseek-chat', thinking: 'medium' as const },
        runner: { model: 'deepseek-chat', thinking: 'medium' as const },
        reviewer: { model: 'deepseek-vision', thinking: 'high' as const },
      },
      local: { repoDir: '/data/repository', reportDir: '/data/reports', retentionDays: 7 },
      mcp: { enabled: true, browser: 'chromium' as const, headless: true, timeoutMs: 30_000 },
      oss: {
        endpoint: 'https://oss.example.test',
        region: 'test',
        bucket: 'evidence',
        publicBaseUrl: '',
        accessMode: 'private' as const,
        objectPrefix: 'luowang',
      },
    },
    repository: {
      repository: 'https://github.com/cynos-ai/cynos-website',
      scenarioBranch: 'scenario-testing',
      scenarioMode: 'review-all' as const,
      scenarioLabels: ['core'],
      pollIntervalSeconds: 300,
      cron: '',
      triggerOnCommit: false,
      environmentDescription: 'non-production',
      baseUrl: 'https://staging.example.test',
      externalDatabase: 'synthetic only',
    },
  };
}

function firstCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
