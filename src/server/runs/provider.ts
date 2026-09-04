import type {
  ConnectivityResult,
  HarnessConfig,
  ProviderInfo,
  ProviderModelInfo,
  ThinkingLevel,
} from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { SecretStore } from '../security/secret-store.js';
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
  private runtime: ModelRuntime | undefined;
  private runtimeProvider: string | undefined;
  private runtimeProviderBaseUrl: string | undefined;
  private catalogRuntime: ModelRuntime | undefined;
  private readonly credentials = new MemoryCredentialStore();

  constructor(
    private readonly configuration: ConfigurationStore,
    private readonly secretStore: SecretStore,
  ) {}

  async getRuntime(): Promise<ModelRuntime> {
    const harness = this.configuration.getHarness();
    const provider = harness.provider.trim();
    const providerBaseUrl = harness.providerBaseUrl.trim();
    if (!provider) throw new ProviderError('PROVIDER_NOT_CONFIGURED', '模型 Provider 尚未配置');
    if (this.runtimeProvider && this.runtimeProvider !== provider) {
      await this.credentials.delete(this.runtimeProvider);
    }
    await this.syncCredential(provider);
    if (
      !this.runtime ||
      this.runtimeProvider !== provider ||
      this.runtimeProviderBaseUrl !== providerBaseUrl
    ) {
      const runtime = await this.createStaticRuntime(this.credentials);
      if (providerBaseUrl !== '') {
        if (!runtime.getProvider(provider)) {
          throw new ProviderError('PROVIDER_NOT_FOUND', `模型 Provider 不存在：${provider}`);
        }
        runtime.registerProvider(provider, { baseUrl: providerBaseUrl });
      }
      this.runtime = runtime;
      this.runtimeProvider = provider;
      this.runtimeProviderBaseUrl = providerBaseUrl;
    }
    return this.runtime;
  }

  async resolveModel(role: AgentRole): Promise<PiModel> {
    const harness = this.configuration.getHarness();
    const provider = harness.provider.trim();
    if (!provider) throw new ProviderError('PROVIDER_NOT_CONFIGURED', '模型 Provider 尚未配置');
    const runtime = await this.getRuntime();
    if (!runtime.getProvider(provider)) {
      throw new ProviderError('PROVIDER_NOT_FOUND', `模型 Provider 不存在：${provider}`);
    }
    const model = this.resolveConfiguredModel(runtime, provider, harness, role);
    if (!this.secretStore.get('providerApiKey')) {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型 Provider API Key 尚未配置');
    }
    const auth = await runtime.checkAuth(provider);
    if (!auth) {
      throw new ProviderError('AUTHENTICATION_FAILED', '模型 Provider 认证不可用');
    }
    return model;
  }

  async listModels(requestedProvider?: string): Promise<ProviderModelInfo[]> {
    const configuredProvider = this.configuration.getHarness().provider.trim();
    const provider = requestedProvider?.trim() || configuredProvider;
    if (!provider) return [];
    const runtime =
      provider === configuredProvider ? await this.getRuntime() : await this.getCatalogRuntime();
    if (!runtime.getProvider(provider)) return [];
    const auth =
      provider === configuredProvider && this.secretStore.get('providerApiKey')
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
      .map((provider) => ({ id: provider.id, name: provider.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    const startedAt = Date.now();
    const harness = this.configuration.getHarness();
    const provider = harness.provider.trim();
    if (!provider) {
      return result('not_configured', '模型 Provider 尚未配置', startedAt, 'AUTH_NOT_CONFIGURED');
    }

    try {
      const runtime = await this.getRuntime();
      if (!runtime.getProvider(provider)) {
        return result(
          'failed',
          `模型 Provider 不存在：${provider}`,
          startedAt,
          'PROVIDER_NOT_FOUND',
        );
      }
      const models = (['main-a', 'runner', 'reviewer'] as const).map((role) => ({
        role,
        model: this.resolveConfiguredModel(runtime, provider, harness, role),
      }));
      const mainModel = models.find((item) => item.role === 'main-a')?.model;
      if (!mainModel) {
        return result('failed', 'Main 模型不存在', startedAt, 'MODEL_NOT_FOUND');
      }

      if (!this.secretStore.get('providerApiKey')) {
        return result(
          'not_configured',
          '模型 Provider API Key 尚未配置',
          startedAt,
          'AUTH_NOT_CONFIGURED',
        );
      }
      const auth = await runtime.checkAuth(provider);
      if (!auth) {
        return result(
          'failed',
          '模型 Provider 认证失败或 API Key 不可用',
          startedAt,
          'AUTHENTICATION_FAILED',
        );
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

      await runtime.completeSimple(
        mainModel,
        {
          messages: [
            { role: 'user', content: 'Reply with the single word OK.', timestamp: Date.now() },
          ],
        },
        { timeoutMs: 15_000, maxRetries: 0 },
      );
      return result('ok', `Provider ${provider} 与三个角色模型均可用`, startedAt);
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
    assertThinkingSupported(model, agent.thinking, role);
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

  private async syncCredential(provider: string): Promise<void> {
    const key = this.secretStore.get('providerApiKey');
    if (key) {
      await this.credentials.modify(provider, async () => ({ type: 'api_key', key }));
    } else {
      await this.credentials.delete(provider);
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

function assertThinkingSupported(model: PiModel, level: ThinkingLevel, role: AgentRole): void {
  if (!isThinkingSupported(model, level)) {
    throw new ProviderError('THINKING_UNSUPPORTED', `${role} 模型不支持 thinking level：${level}`);
  }
}

function configuredRole(role: AgentRole): 'main' | 'runner' | 'reviewer' {
  return role === 'main-a' || role === 'main-b' ? 'main' : role;
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
  const possible = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const status = typeof possible.status === 'number' ? possible.status : undefined;
  const message = typeof possible.message === 'string' ? possible.message.toLowerCase() : '';
  if (
    status === 401 ||
    status === 403 ||
    possible.code === 'auth' ||
    /auth|api key|credential|unauthori[sz]ed|forbidden|invalid key/.test(message)
  ) {
    return result(
      'failed',
      '模型 Provider 认证失败或 API Key 不可用',
      startedAt,
      'AUTHENTICATION_FAILED',
    );
  }
  if (
    status === 404 ||
    /model.{0,20}(not found|does not exist|unknown)|unknown.{0,20}model/.test(message)
  ) {
    return result('failed', '模型不存在或 Provider 不支持该模型', startedAt, 'MODEL_NOT_FOUND');
  }
  if (/thinking|reasoning|unsupported/.test(message)) {
    return result(
      'failed',
      'Provider 不支持所选 thinking level',
      startedAt,
      'THINKING_UNSUPPORTED',
    );
  }
  if (possible.name === 'AbortError' || /timeout|timed out/.test(message)) {
    return result('timeout', '模型 Provider 请求超时', startedAt);
  }
  return result('failed', '模型 Provider 请求失败', startedAt, 'REQUEST_FAILED');
}
