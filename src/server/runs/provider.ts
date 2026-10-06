import type {
  ConnectivityResult,
  HarnessConfig,
  ModelProviderSource,
  ProviderInfo,
  ProviderModelInfo,
  ThinkingLevel,
} from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { SecretStore } from '../security/secret-store.js';
import { getProviderApiKey } from '../security/provider-secrets.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentRole } from './types.js';

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export interface ProviderAdapter {
  getRuntime(): Promise<ModelRuntime>;
  resolveModel(role: AgentRole): Promise<PiModel>;
  listModels(provider?: string): Promise<ProviderModelInfo[]>;
  listProviders?(): Promise<ProviderInfo[]>;
  verifySource?(sourceId: string): Promise<ProviderModelInfo[]>;
  checkConnectivity(): Promise<ConnectivityResult>;
}

export class ProviderError extends Error {
  readonly code:
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PROVIDER_NOT_FOUND'
    | 'MODEL_NOT_FOUND'
    | 'VISION_UNSUPPORTED'
    | 'THINKING_UNSUPPORTED'
    | 'AUTHENTICATION_FAILED';

  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export function createProviderAdapter(
  configuration: ConfigurationStore,
  secretStore: SecretStore,
): ProviderAdapter {
  return new PiProviderAdapter(configuration, secretStore);
}

class PiProviderAdapter implements ProviderAdapter {
  private readonly sourceRuntimes = new Map<
    string,
    {
      provider: string;
      baseUrl: string;
      runtime: ModelRuntime;
      credentials: MemoryCredentialStore;
    }
  >();
  private catalogRuntime: ModelRuntime | undefined;

  constructor(
    private readonly configuration: ConfigurationStore,
    private readonly secretStore: SecretStore,
  ) {}

  async getRuntime(): Promise<ModelRuntime> {
    const harness = this.configuration.getHarness();
    const source = primarySource(harness);
    if (!source) throw new ProviderError('PROVIDER_NOT_CONFIGURED', '模型来源尚未配置');
    return this.getRuntimeForSource(source);
  }

  private async getRuntimeForSource(source: ModelProviderSource): Promise<ModelRuntime> {
    const provider = source.provider.trim();
    const providerBaseUrl = source.baseUrl.trim();
    let entry = this.sourceRuntimes.get(source.id);
    if (!entry || entry.provider !== provider || entry.baseUrl !== providerBaseUrl) {
      const credentials = new MemoryCredentialStore();
      await this.syncCredential(credentials, provider, source.id);
      const runtime = await this.createStaticRuntime(credentials);
      if (providerBaseUrl !== '') {
        if (!runtime.getProvider(provider)) {
          throw new ProviderError('PROVIDER_NOT_FOUND', `模型 Provider 不存在：${provider}`);
        }
        runtime.registerProvider(provider, { baseUrl: providerBaseUrl });
      }
      entry = { provider, baseUrl: providerBaseUrl, runtime, credentials };
      this.sourceRuntimes.set(source.id, entry);
    } else {
      await this.syncCredential(entry.credentials, provider, source.id);
    }
    return entry.runtime;
  }

  async resolveModel(role: AgentRole): Promise<PiModel> {
    const harness = this.configuration.getHarness();
    const agent = harness.agents[configuredRole(role)];
    const source = sourceForAgent(harness, agent.providerSourceId);
    if (!source) throw new ProviderError('PROVIDER_NOT_CONFIGURED', `${role} 模型来源尚未配置`);
    const provider = source.provider.trim();
    const runtime = await this.getRuntimeForSource(source);
    if (!runtime.getProvider(provider)) {
      throw new ProviderError('PROVIDER_NOT_FOUND', `模型 Provider 不存在：${provider}`);
    }
    const model = this.resolveConfiguredModel(runtime, provider, harness, role);
    if (!getProviderApiKey(this.secretStore, source.id)) {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型 Provider API Key 尚未配置');
    }
    const auth = await runtime.checkAuth(provider);
    if (!auth) {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型 Provider 认证不可用');
    }
    return model;
  }

  async listModels(requestedProvider?: string): Promise<ProviderModelInfo[]> {
    const configuredProvider =
      primarySource(this.configuration.getHarness())?.provider.trim() ?? '';
    const provider = requestedProvider?.trim() || configuredProvider;
    if (!provider) return [];
    const runtime =
      provider === configuredProvider ? await this.getRuntime() : await this.getCatalogRuntime();
    if (!runtime.getProvider(provider)) return [];
    const auth =
      provider === configuredProvider &&
      getProviderApiKey(this.secretStore, primarySource(this.configuration.getHarness())?.id ?? '')
        ? await runtime.checkAuth(provider)
        : undefined;
    return runtime.getModels(provider).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      thinkingLevels: supportedThinkingLevels(model),
      available: auth !== undefined,
    }));
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const runtime = await this.getCatalogRuntime();
    return runtime
      .getProviders()
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async verifySource(sourceId: string): Promise<ProviderModelInfo[]> {
    const harness = this.configuration.getHarness();
    const source = harness.modelProviders.find((item) => item.id === sourceId);
    if (!source) throw new ProviderError('PROVIDER_NOT_FOUND', '模型来源不存在');
    const key = getProviderApiKey(this.secretStore, source.id);
    if (!key) throw new ProviderError('AUTHENTICATION_FAILED', '模型来源 API Key 尚未配置');
    const runtime = await this.getRuntimeForSource(source);
    if (!runtime.getProvider(source.provider)) {
      throw new ProviderError('PROVIDER_NOT_FOUND', `模型 Provider 不存在：${source.provider}`);
    }
    if (!(await runtime.checkAuth(source.provider))) {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型 Provider 认证失败或 API Key 不可用');
    }
    const models = runtime.getModels(source.provider);
    const configuredModel = Object.values(harness.agents).find(
      (agent) => sourceForAgent(harness, agent.providerSourceId)?.id === source.id && agent.model,
    )?.model;
    const probe =
      (configuredModel ? runtime.getModel(source.provider, configuredModel) : undefined) ??
      models[0];
    if (!probe) throw new ProviderError('MODEL_NOT_FOUND', '该来源没有可用模型');
    const response = await runtime.completeSimple(
      probe,
      {
        messages: [
          { role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() },
        ],
      },
      { timeoutMs: 15_000, maxRetries: 0 },
    );
    if (response.stopReason !== 'stop') {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型来源探测未正常完成');
    }
    return models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      thinkingLevels: supportedThinkingLevels(model),
      available: true,
    }));
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    const startedAt = Date.now();
    const harness = this.configuration.getHarness();
    const source = primarySource(harness);
    if (!source) {
      return result('not_configured', '模型来源尚未配置', startedAt, 'AUTH_NOT_CONFIGURED');
    }
    for (const role of ['main', 'runner', 'reviewer'] as const) {
      const roleSource = sourceForAgent(harness, harness.agents[role].providerSourceId);
      if (!roleSource || !getProviderApiKey(this.secretStore, roleSource.id)) {
        return result(
          'not_configured',
          `${role} 模型来源 API Key 尚未配置`,
          startedAt,
          'AUTH_NOT_CONFIGURED',
        );
      }
    }
    try {
      const models: Array<{ role: 'main-a' | 'runner' | 'reviewer'; model: PiModel }> = [];
      for (const role of ['main-a', 'runner', 'reviewer'] as const) {
        models.push({ role, model: await this.resolveModel(role) });
      }
      const mainModel = models.find((item) => item.role === 'main-a')?.model;
      if (!mainModel) {
        return result('failed', 'Main 模型不存在', startedAt, 'MODEL_NOT_FOUND');
      }

      const reviewerModel = models.find((item) => item.role === 'reviewer')?.model;
      if (!reviewerModel?.input.some((input) => input.toLowerCase() === 'image')) {
        return result(
          'failed',
          'Reviewer 模型不支持图像输入，无法审核截图证据',
          startedAt,
          'VISION_UNSUPPORTED',
        );
      }

      const mainSource = sourceForAgent(harness, harness.agents.main.providerSourceId) ?? source;
      const mainRuntime = await this.getRuntimeForSource(mainSource);
      const response = await mainRuntime.completeSimple(
        mainModel,
        {
          messages: [
            { role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() },
          ],
        },
        { timeoutMs: 15_000, maxRetries: 0 },
      );
      // Pi can resolve with an error message instead of rejecting the request.
      // Never expose the response body, which may contain credentials from a gateway.
      if (response.stopReason !== 'stop') {
        return result('failed', '模型 Provider 探测未正常完成', startedAt, 'REQUEST_FAILED');
      }
      return result('ok', '三个角色的模型来源与模型均可用', startedAt);
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.code === 'MODEL_NOT_FOUND') {
          return result('failed', error.message, startedAt, 'MODEL_NOT_FOUND');
        }
        if (error.code === 'VISION_UNSUPPORTED') {
          return result('failed', error.message, startedAt, 'VISION_UNSUPPORTED');
        }
        if (error.code === 'THINKING_UNSUPPORTED') {
          return result('failed', error.message, startedAt, 'THINKING_UNSUPPORTED');
        }
        if (error.code === 'AUTHENTICATION_FAILED') {
          return result('failed', error.message, startedAt, 'AUTHENTICATION_FAILED');
        }
        if (error.code === 'PROVIDER_NOT_FOUND') {
          return result('failed', error.message, startedAt, 'PROVIDER_NOT_FOUND');
        }
        return result('not_configured', error.message, startedAt, 'AUTH_NOT_CONFIGURED');
      }
      return classifyProviderRequestError(error, startedAt);
    }
  }

  private resolveConfiguredModel(
    runtime: ModelRuntime,
    provider: string,
    harness: HarnessConfig,
    role: AgentRole,
  ): PiModel {
    const agent = harness.agents[configuredRole(role)];
    if (!agent.model.trim()) {
      throw new ProviderError('MODEL_NOT_FOUND', `${role} 模型尚未配置`);
    }
    const model = runtime.getModel(provider, agent.model.trim());
    if (!model) {
      throw new ProviderError(
        'MODEL_NOT_FOUND',
        `${role} 模型不存在：${provider}/${agent.model.trim()}`,
      );
    }
    selectStageThinking(model, role, agent.thinking);
    return model;
  }

  private async getCatalogRuntime(): Promise<ModelRuntime> {
    this.catalogRuntime ??= await this.createStaticRuntime(new MemoryCredentialStore());
    return this.catalogRuntime;
  }

  private async createStaticRuntime(credentials: MemoryCredentialStore): Promise<ModelRuntime> {
    return ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
  }

  private async syncCredential(
    credentials: MemoryCredentialStore,
    provider: string,
    sourceId: string,
  ): Promise<void> {
    const key = getProviderApiKey(this.secretStore, sourceId);
    if (key) {
      await credentials.modify(provider, async () => ({ type: 'api_key', key }));
    } else {
      await credentials.delete(provider);
    }
  }
}

class MemoryCredentialStore {
  private readonly values = new Map<string, { type: 'api_key'; key: string }>();
  private readonly chains = new Map<string, Promise<unknown>>();

  async read(providerId: string): Promise<{ type: 'api_key'; key: string } | undefined> {
    return this.values.get(providerId);
  }

  async list(): Promise<readonly { providerId: string; type: 'api_key' }[]> {
    return [...this.values.keys()].map((providerId) => ({ providerId, type: 'api_key' as const }));
  }

  async modify(
    providerId: string,
    fn: (
      current: { type: 'api_key'; key: string } | undefined,
    ) => Promise<{ type: 'api_key'; key: string } | undefined>,
  ): Promise<{ type: 'api_key'; key: string } | undefined> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const next = await fn(this.values.get(providerId));
      if (next) this.values.set(providerId, next);
      return next;
    });
    this.chains.set(providerId, operation);
    try {
      return await operation;
    } finally {
      if (this.chains.get(providerId) === operation) this.chains.delete(providerId);
    }
  }

  async delete(providerId: string): Promise<void> {
    await this.modify(providerId, async () => undefined);
    this.values.delete(providerId);
  }
}

/** Default used when a role has no valid persisted preference for its selected model. */
export function effectiveStageThinking(role: AgentRole): ThinkingLevel {
  return role === 'runner' ? 'off' : 'low';
}

/** Keep a supported preference, otherwise map the role default to the model's levels. */
export function selectStageThinking(
  model: PiModel,
  role: AgentRole,
  configured?: ThinkingLevel,
): ThinkingLevel {
  const levels = supportedThinkingLevels(model);
  if (configured && levels.includes(configured)) return configured;
  const relativeIndex = effectiveStageThinking(role) === 'low' ? 1 : 0;
  const selected = levels[Math.min(relativeIndex, levels.length - 1)];
  if (!selected) {
    throw new ProviderError('THINKING_UNSUPPORTED', `${role} 模型没有可用的 thinking level`);
  }
  return selected;
}

export function supportedThinkingLevels(model: PiModel): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => isThinkingSupported(model, level));
}

export function isThinkingSupported(model: PiModel, level: ThinkingLevel): boolean {
  if (!model.reasoning) return level === 'off';
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if ((level === 'xhigh' || level === 'max') && mapped === undefined) return false;
  return true;
}

function configuredRole(role: AgentRole): 'main' | 'runner' | 'reviewer' {
  return role === 'main-a' || role === 'main-b' ? 'main' : role;
}

function primarySource(harness: HarnessConfig): ModelProviderSource | undefined {
  return (
    harness.modelProviders[0] ??
    (harness.provider.trim()
      ? {
          id: 'default',
          name: harness.provider.trim(),
          provider: harness.provider.trim(),
          baseUrl: harness.providerBaseUrl.trim(),
          verifiedAt: null,
          models: [],
        }
      : undefined)
  );
}

function sourceForAgent(
  harness: HarnessConfig,
  sourceId: string | undefined,
): ModelProviderSource | undefined {
  return harness.modelProviders.find((item) => item.id === sourceId) ?? primarySource(harness);
}

function result(
  status: ConnectivityResult['status'],
  message: string,
  startedAt: number,
  code?: ConnectivityResult['code'],
): ConnectivityResult {
  return {
    status,
    message,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    ...(code ? { code } : {}),
  };
}

function classifyProviderRequestError(error: unknown, startedAt: number): ConnectivityResult {
  const possible = (error !== null && typeof error === 'object' ? error : {}) as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status = typeof possible.status === 'number' ? possible.status : undefined;
  if (
    status === 401 ||
    status === 403 ||
    possible.code === 'auth' ||
    possible.code === 'invalid_api_key'
  ) {
    return result(
      'failed',
      '模型 Provider 认证失败或 API Key 不可用',
      startedAt,
      'AUTHENTICATION_FAILED',
    );
  }
  if (possible.code === 'model_not_found') {
    return result('failed', '模型不存在或 Provider 不支持该模型', startedAt, 'MODEL_NOT_FOUND');
  }
  if (possible.name === 'TimeoutError' || possible.code === 'ETIMEDOUT') {
    return result('timeout', '模型 Provider 请求超时', startedAt);
  }
  return result('failed', '模型 Provider 请求失败', startedAt, 'REQUEST_FAILED');
}
