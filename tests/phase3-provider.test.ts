import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it } from 'vitest';

import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import {
  createProviderAdapter,
  supportedThinkingLevels,
  type PiModel,
} from '../src/server/runs/provider.js';
import type { SecretStore } from '../src/server/security/secret-store.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 3 Provider connectivity', () => {
  it('distinguishes missing configuration, unknown Provider, missing model, and unsupported thinking', async () => {
    const notConfigured = await makeAdapter({ provider: '' });
    const notConfiguredResult = await notConfigured.checkConnectivity();
    assert.equal(notConfiguredResult.status, 'not_configured');
    assert.equal(notConfiguredResult.code, 'AUTH_NOT_CONFIGURED');

    const unknownProvider = await makeAdapter({
      provider: 'provider-does-not-exist',
      key: 'synthetic-key',
    });
    const unknownProviderResult = await unknownProvider.checkConnectivity();
    assert.equal(unknownProviderResult.status, 'failed');
    assert.equal(unknownProviderResult.code, 'PROVIDER_NOT_FOUND');

    const missingModel = await makeAdapter({
      provider: 'openai',
      key: 'synthetic-key',
      model: 'model-does-not-exist',
    });
    const missingModelResult = await missingModel.checkConnectivity();
    assert.equal(missingModelResult.status, 'failed');
    assert.equal(missingModelResult.code, 'MODEL_NOT_FOUND');

    const unsupportedThinking = await makeAdapter({
      provider: 'openai',
      key: 'synthetic-key',
      model: 'gpt-4',
      thinking: 'medium',
    });
    const unsupportedThinkingResult = await unsupportedThinking.checkConnectivity();
    assert.equal(unsupportedThinkingResult.status, 'failed');
    assert.equal(unsupportedThinkingResult.code, 'THINKING_UNSUPPORTED');

    const unsupportedVision = await makeAdapter({
      provider: 'openai',
      key: 'synthetic-key',
      model: 'gpt-4',
    });
    const unsupportedVisionResult = await unsupportedVision.checkConnectivity();
    assert.equal(unsupportedVisionResult.status, 'failed');
    assert.equal(unsupportedVisionResult.code, 'VISION_UNSUPPORTED');
    assert.match(unsupportedVisionResult.message, /Reviewer.*图像输入/);
  });

  it('reports an unconfigured API key before attempting a model request', async () => {
    const adapter = await makeAdapter({ provider: 'openai', model: 'gpt-4' });
    const result = await adapter.checkConnectivity();
    assert.equal(result.status, 'not_configured');
    assert.equal(result.code, 'AUTH_NOT_CONFIGURED');
  });

  it('lists the static Provider catalog, filters models, and applies a configured base URL', async () => {
    const adapter = await makeAdapter({
      provider: 'openai',
      baseUrl: 'https://trusted-model-gateway.example.test/v1',
      model: 'gpt-4',
    });

    const providers = await adapter.listProviders?.();
    assert.ok(providers?.some((provider) => provider.id === 'openai'));
    const models = await adapter.listModels('openai');
    assert.ok(models.some((model) => model.id === 'gpt-4'));
    assert.ok(models.every((model) => model.provider === 'openai'));

    const runtime = await adapter.getRuntime();
    assert.equal(
      runtime.getModel('openai', 'gpt-4')?.baseUrl,
      'https://trusted-model-gateway.example.test/v1',
    );
  });

  it('treats omitted extended thinking mappings as unsupported and null as unsupported', () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: { off: null, high: 'high', max: 'max' },
    } as unknown as PiModel;
    assert.deepEqual(supportedThinkingLevels(model), ['minimal', 'low', 'medium', 'high', 'max']);
    assert.deepEqual(supportedThinkingLevels({ reasoning: false } as unknown as PiModel), ['off']);
  });
});

async function makeAdapter(options: {
  provider: string;
  key?: string;
  model?: string;
  baseUrl?: string;
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase3-provider-'));
  cleanup.push(async () => rm(dataDirectory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: dataDirectory });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  const model = options.model ?? 'gpt-4';
  const thinking = options.thinking ?? 'off';
  configuration.updateHarness({
    provider: options.provider,
    providerBaseUrl: options.baseUrl,
    agents: {
      main: { model, thinking },
      runner: { model, thinking },
      reviewer: { model, thinking },
    },
  });
  return createProviderAdapter(configuration, fakeSecretStore(options.key));
}

function fakeSecretStore(providerApiKey: string | undefined): SecretStore {
  return {
    isAvailable: () => true,
    set: () => undefined,
    get: (key) => (key === 'providerApiKey' ? providerApiKey : undefined),
    has: (key) => key === 'providerApiKey' && providerApiKey !== undefined,
    delete: () => undefined,
    metadata: () => ({}) as SecretStore['metadata'] extends () => infer T ? T : never,
  };
}
