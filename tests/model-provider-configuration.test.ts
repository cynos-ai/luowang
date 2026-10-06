import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import {
  globalSettingSectionPatch,
  globalSettingSectionValue,
  withoutModelProviderSource,
} from '../src/web/pages/global-settings-section.js';
import type { HarnessConfig } from '../src/shared/types.js';

describe('model provider configuration', () => {
  it('includes new model sources in the models section save payload and dirty value', () => {
    const configuration: HarnessConfig = {
      language: 'zh-CN',
      provider: '',
      providerBaseUrl: '',
      modelProviders: [],
      agents: {
        main: { model: '', thinking: 'low' },
        runner: { model: '', thinking: 'off' },
        reviewer: { model: '', thinking: 'low' },
      },
      local: { repoDir: '/repo', reportDir: '/reports', retentionDays: 1 },
      mcp: { enabled: false, browser: 'chromium', headless: true, timeoutMs: 30_000 },
      oss: {
        endpoint: '',
        region: '',
        bucket: '',
        publicBaseUrl: '',
        accessMode: 'private',
        objectPrefix: '',
      },
    };
    const modelProviders = [
      {
        id: 'deepseek',
        name: 'deepseek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        verifiedAt: null,
        models: [],
      },
    ];
    const draft = { ...configuration, modelProviders };

    assert.deepEqual(globalSettingSectionPatch('models', draft).modelProviders, modelProviders);
    assert.deepEqual(globalSettingSectionValue('models', draft).modelProviders, modelProviders);
    assert.notDeepEqual(
      globalSettingSectionValue('models', draft),
      globalSettingSectionValue('models', configuration),
    );

    const selectedDraft: HarnessConfig = {
      ...draft,
      provider: 'deepseek',
      providerBaseUrl: 'https://api.deepseek.com',
      agents: {
        ...draft.agents,
        main: { providerSourceId: 'deepseek', model: 'deepseek-chat', thinking: 'low' },
      },
    };
    const removed = withoutModelProviderSource(selectedDraft, 'deepseek');
    assert.deepEqual(removed.modelProviders, []);
    assert.equal(removed.provider, '');
    assert.deepEqual(removed.agents.main, {
      providerSourceId: '',
      model: '',
      thinking: 'low',
    });
  });

  it('migrates one legacy provider and persists independent role sources', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run(
          'harness',
          JSON.stringify({ provider: 'openai', providerBaseUrl: 'https://one.example/v1' }),
          '2026-10-04',
        );
      const configuration = createConfigurationStore(database, {
        repoDir: '/repo',
        reportDir: '/reports',
      });
      const migrated = configuration.getHarness();
      assert.deepEqual(migrated.modelProviders, [
        {
          id: 'default',
          name: 'openai',
          provider: 'openai',
          baseUrl: 'https://one.example/v1',
          verifiedAt: null,
          models: [],
        },
      ]);

      const updated = configuration.updateHarness({
        modelProviders: [
          migrated.modelProviders[0],
          {
            id: 'secondary',
            name: '备用来源',
            provider: 'deepseek',
            baseUrl: 'https://two.example/v1',
            verifiedAt: null,
            models: [],
          },
        ],
        agents: {
          main: { providerSourceId: 'default', model: 'gpt', thinking: 'low' },
          runner: { providerSourceId: 'secondary', model: 'deepseek-chat', thinking: 'off' },
        },
      });
      assert.equal(updated.agents.runner.providerSourceId, 'secondary');
      assert.equal(updated.modelProviders.length, 2);
      assert.throws(
        () =>
          configuration.updateHarness({
            agents: { main: { providerSourceId: 'missing', model: 'gpt', thinking: 'low' } },
          }),
        /不存在的模型来源/,
      );
    } finally {
      database.close();
    }
  });
});
