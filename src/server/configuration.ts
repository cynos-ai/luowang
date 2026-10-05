import type Database from 'better-sqlite3';

import type {
  AgentConfig,
  HarnessConfig,
  ModelProviderSource,
  ProviderModelInfo,
  RepositoryConfig,
  ScenarioMode,
} from '../shared/types.js';
import type { AppConfig } from './config.js';

const HARNESS_KEY = 'harness';
const REPOSITORY_KEY = 'repository';
const MAX_TEXT_LENGTH = 4_096;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface ConfigurationStore {
  getHarness(): HarnessConfig;
  getRepository(): RepositoryConfig;
  updateHarness(input: unknown): HarnessConfig;
  updateRepository(input: unknown): RepositoryConfig;
}

export function createConfigurationStore(
  database: Database.Database,
  config: Pick<AppConfig, 'repoDir' | 'reportDir'>,
): ConfigurationStore {
  return new SqliteConfigurationStore(database, config);
}

class SqliteConfigurationStore implements ConfigurationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly paths: Pick<AppConfig, 'repoDir' | 'reportDir'>,
  ) {}

  getHarness(): HarnessConfig {
    const stored = this.read(HARNESS_KEY);
    return normalizeHarness(stored, this.paths);
  }

  getRepository(): RepositoryConfig {
    return normalizeRepository(this.read(REPOSITORY_KEY));
  }

  updateHarness(input: unknown): HarnessConfig {
    const current = this.getHarness();
    const patch = asRecord(input, 'Harness configuration must be an object');
    const agents = asOptionalRecord(patch.agents, 'agents must be an object');
    const local = asOptionalRecord(patch.local, 'local must be an object');
    const mcp = asOptionalRecord(patch.mcp, 'mcp must be an object');
    const oss = asOptionalRecord(patch.oss, 'oss must be an object');
    const modelProviders =
      patch.modelProviders === undefined
        ? syncLegacyModelProvider(current.modelProviders, patch)
        : readModelProviders(patch.modelProviders);
    const primary = modelProviders[0];

    const next: HarnessConfig = {
      language: readText(patch.language, current.language, 'language'),
      provider: primary?.provider ?? readText(patch.provider, current.provider, 'provider'),
      providerBaseUrl:
        primary?.baseUrl ?? readProviderBaseUrl(patch.providerBaseUrl, current.providerBaseUrl),
      modelProviders,
      agents: {
        main: readAgent(agents?.main, current.agents.main, 'agents.main'),
        runner: readAgent(agents?.runner, current.agents.runner, 'agents.runner'),
        reviewer: readAgent(agents?.reviewer, current.agents.reviewer, 'agents.reviewer'),
      },
      local: {
        repoDir: readText(local?.repoDir, current.local.repoDir, 'local.repoDir'),
        reportDir: readText(local?.reportDir, current.local.reportDir, 'local.reportDir'),
        retentionDays: readInteger(
          local?.retentionDays,
          current.local.retentionDays,
          'local.retentionDays',
          1,
          36_500,
        ),
      },
      mcp: {
        enabled: readBoolean(mcp?.enabled, current.mcp.enabled, 'mcp.enabled'),
        browser: readChoice(
          mcp?.browser,
          current.mcp.browser,
          ['chromium', 'firefox', 'webkit'],
          'mcp.browser',
        ),
        headless: readBoolean(mcp?.headless, current.mcp.headless, 'mcp.headless'),
        timeoutMs: readInteger(
          mcp?.timeoutMs,
          current.mcp.timeoutMs,
          'mcp.timeoutMs',
          5_000,
          120_000,
        ),
      },
      oss: {
        endpoint: readText(oss?.endpoint, current.oss.endpoint, 'oss.endpoint'),
        region: readText(oss?.region, current.oss.region, 'oss.region'),
        bucket: readText(oss?.bucket, current.oss.bucket, 'oss.bucket'),
        publicBaseUrl: readText(oss?.publicBaseUrl, current.oss.publicBaseUrl, 'oss.publicBaseUrl'),
        accessMode: readChoice(
          oss?.accessMode,
          current.oss.accessMode,
          ['public', 'private'],
          'oss.accessMode',
        ),
        objectPrefix: readText(oss?.objectPrefix, current.oss.objectPrefix, 'oss.objectPrefix'),
      },
    };
    for (const [role, agent] of Object.entries(next.agents)) {
      if (
        agent.providerSourceId &&
        !next.modelProviders.some((source) => source.id === agent.providerSourceId)
      ) {
        throw new ConfigurationError(`${role} 引用了不存在的模型来源`);
      }
    }
    this.write(HARNESS_KEY, next);
    return next;
  }

  updateRepository(input: unknown): RepositoryConfig {
    const next = mergeRepositoryConfiguration(this.getRepository(), input);
    this.write(REPOSITORY_KEY, next);
    return next;
  }

  private read(key: string): unknown {
    const row = this.database.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) {
      return undefined;
    }
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.database
      .prepare(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}

export function mergeRepositoryConfiguration(
  current: RepositoryConfig,
  input: unknown,
): RepositoryConfig {
  const patch = asRecord(input, 'Repository configuration must be an object');
  const labels = patch.scenarioLabels;
  const next: RepositoryConfig = {
    repository: readText(patch.repository, current.repository, 'repository'),
    scenarioBranch: readText(patch.scenarioBranch, current.scenarioBranch, 'scenarioBranch'),
    scenarioMode: readChoice(
      patch.scenarioMode,
      current.scenarioMode,
      ['autonomous', 'add-only', 'review-all'],
      'scenarioMode',
    ),
    scenarioLabels:
      labels === undefined ? current.scenarioLabels : readStringArray(labels, 'scenarioLabels'),
    pollIntervalSeconds: readInteger(
      patch.pollIntervalSeconds,
      current.pollIntervalSeconds,
      'pollIntervalSeconds',
      0,
      31_536_000,
    ),
    cron: readText(patch.cron, current.cron, 'cron'),
    triggerOnCommit: readBoolean(patch.triggerOnCommit, current.triggerOnCommit, 'triggerOnCommit'),
    environmentDescription: readText(
      patch.environmentDescription,
      current.environmentDescription,
      'environmentDescription',
    ),
    baseUrl: readText(patch.baseUrl, current.baseUrl, 'baseUrl'),
    externalDatabase: readText(
      patch.externalDatabase,
      current.externalDatabase,
      'externalDatabase',
    ),
  };
  if (next.triggerOnCommit && next.pollIntervalSeconds < 300) {
    next.pollIntervalSeconds = 300;
  }
  return next;
}

function normalizeHarness(
  value: unknown,
  paths: Pick<AppConfig, 'repoDir' | 'reportDir'>,
): HarnessConfig {
  const source = isRecord(value) ? value : {};
  const agents = isRecord(source.agents) ? source.agents : {};
  const local = isRecord(source.local) ? source.local : {};
  const mcp = isRecord(source.mcp) ? source.mcp : {};
  const oss = isRecord(source.oss) ? source.oss : {};
  const defaults: HarnessConfig = {
    language: 'zh-CN',
    provider: '',
    providerBaseUrl: '',
    modelProviders: [],
    agents: {
      main: { model: '', thinking: 'low' },
      runner: { model: '', thinking: 'off' },
      reviewer: { model: '', thinking: 'low' },
    },
    local: { repoDir: paths.repoDir, reportDir: paths.reportDir, retentionDays: 1 },
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

  const provider = normalizeText(source.provider, defaults.provider);
  const providerBaseUrl = normalizeProviderBaseUrl(source.providerBaseUrl);
  const modelProviders = normalizeModelProviders(source.modelProviders, provider, providerBaseUrl);
  const primary = modelProviders[0];
  return {
    language: normalizeText(source.language, defaults.language),
    provider: primary?.provider ?? provider,
    providerBaseUrl: primary?.baseUrl ?? providerBaseUrl,
    modelProviders,
    agents: {
      main: normalizeAgent(agents.main, defaults.agents.main),
      runner: normalizeAgent(agents.runner, defaults.agents.runner),
      reviewer: normalizeAgent(agents.reviewer, defaults.agents.reviewer),
    },
    local: {
      repoDir: normalizeText(local.repoDir, defaults.local.repoDir),
      reportDir: normalizeText(local.reportDir, defaults.local.reportDir),
      retentionDays: normalizeInteger(local.retentionDays, defaults.local.retentionDays, 1, 36_500),
    },
    mcp: {
      enabled: normalizeBoolean(mcp.enabled, defaults.mcp.enabled),
      browser: normalizeChoice(mcp.browser, defaults.mcp.browser, [
        'chromium',
        'firefox',
        'webkit',
      ]),
      headless: normalizeBoolean(mcp.headless, defaults.mcp.headless),
      timeoutMs: normalizeInteger(mcp.timeoutMs, defaults.mcp.timeoutMs, 5_000, 120_000),
    },
    oss: {
      endpoint: normalizeText(oss.endpoint, defaults.oss.endpoint),
      region: normalizeText(oss.region, defaults.oss.region),
      bucket: normalizeText(oss.bucket, defaults.oss.bucket),
      publicBaseUrl: normalizeText(oss.publicBaseUrl, defaults.oss.publicBaseUrl),
      accessMode: normalizeChoice(oss.accessMode, defaults.oss.accessMode, ['public', 'private']),
      objectPrefix: normalizeText(oss.objectPrefix, defaults.oss.objectPrefix),
    },
  };
}

export function normalizeRepository(value: unknown): RepositoryConfig {
  const source = isRecord(value) ? value : {};
  const storedMode = source.scenarioMode === 'pr-required' ? 'review-all' : source.scenarioMode;
  const triggerOnCommit = normalizeBoolean(source.triggerOnCommit, false);
  const storedPollInterval = normalizeInteger(source.pollIntervalSeconds, 300, 0, 31_536_000);
  return {
    repository: normalizeText(source.repository, ''),
    scenarioBranch: normalizeText(source.scenarioBranch, 'scenario-testing'),
    scenarioMode: normalizeChoice(storedMode, 'review-all', [
      'autonomous',
      'add-only',
      'review-all',
    ]) as ScenarioMode,
    scenarioLabels: normalizeStringArray(source.scenarioLabels),
    pollIntervalSeconds: triggerOnCommit && storedPollInterval < 300 ? 300 : storedPollInterval,
    cron: normalizeText(source.cron, ''),
    triggerOnCommit,
    environmentDescription: normalizeText(source.environmentDescription, ''),
    baseUrl: normalizeText(source.baseUrl, ''),
    externalDatabase: normalizeText(source.externalDatabase, ''),
  };
}

function normalizeAgent(value: unknown, fallback: AgentConfig): AgentConfig {
  const source = isRecord(value) ? value : {};
  return {
    providerSourceId: normalizeText(source.providerSourceId, fallback.providerSourceId ?? ''),
    model: normalizeText(source.model, fallback.model),
    thinking: normalizeChoice(source.thinking, fallback.thinking, [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]),
  };
}

function readAgent(value: unknown, fallback: AgentConfig, field: string): AgentConfig {
  const source = asOptionalRecord(value, `${field} must be an object`) ?? {};
  return {
    providerSourceId: readText(
      source.providerSourceId,
      fallback.providerSourceId ?? '',
      `${field}.providerSourceId`,
    ),
    model: readText(source.model, fallback.model, `${field}.model`),
    thinking: readChoice(
      source.thinking,
      fallback.thinking,
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      `${field}.thinking`,
    ),
  };
}

const PROVIDER_SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function normalizeModelProviders(
  value: unknown,
  legacyProvider: string,
  legacyBaseUrl: string,
): ModelProviderSource[] {
  if (!Array.isArray(value)) {
    return legacyProvider
      ? [
          {
            id: 'default',
            name: legacyProvider,
            provider: legacyProvider,
            baseUrl: legacyBaseUrl,
            verifiedAt: null,
            models: [],
          },
        ]
      : [];
  }
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = normalizeText(item.id, '');
    const provider = normalizeText(item.provider, '');
    if (!PROVIDER_SOURCE_ID.test(id) || !provider || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: normalizeText(item.name, provider),
        provider,
        baseUrl: normalizeProviderBaseUrl(item.baseUrl),
        verifiedAt:
          typeof item.verifiedAt === 'string' && item.verifiedAt.trim()
            ? item.verifiedAt.trim()
            : null,
        models: normalizeProviderModels(item.models, provider),
      },
    ];
  });
}

function readModelProviders(value: unknown): ModelProviderSource[] {
  if (!Array.isArray(value)) throw new ConfigurationError('modelProviders must be an array');
  if (value.length > 20) throw new ConfigurationError('模型来源不能超过 20 个');
  const normalized = normalizeModelProviders(value, '', '');
  if (normalized.length !== value.length)
    throw new ConfigurationError('模型来源配置无效或 ID 重复');
  return normalized;
}

function syncLegacyModelProvider(
  sources: ModelProviderSource[],
  patch: Record<string, unknown>,
): ModelProviderSource[] {
  if (patch.provider === undefined && patch.providerBaseUrl === undefined) return sources;
  const provider = readText(patch.provider, sources[0]?.provider ?? '', 'provider');
  const baseUrl = readProviderBaseUrl(patch.providerBaseUrl, sources[0]?.baseUrl ?? '');
  if (!provider) return [];
  const first = sources[0];
  const changed = first?.provider !== provider || first?.baseUrl !== baseUrl;
  const primary: ModelProviderSource = {
    id: first?.id ?? 'default',
    name: first?.name || provider,
    provider,
    baseUrl,
    verifiedAt: changed ? null : (first?.verifiedAt ?? null),
    models: changed ? [] : (first?.models ?? []),
  };
  return [primary, ...sources.slice(1)];
}

function normalizeProviderModels(value: unknown, provider: string): ProviderModelInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = normalizeText(item.id, '');
    if (!id) return [];
    const input = Array.isArray(item.input)
      ? item.input.filter((entry): entry is string => typeof entry === 'string').slice(0, 10)
      : [];
    const levels = Array.isArray(item.thinkingLevels)
      ? item.thinkingLevels.filter(
          (entry): entry is ProviderModelInfo['thinkingLevels'][number] =>
            typeof entry === 'string' &&
            ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(entry),
        )
      : [];
    return [
      {
        provider,
        id,
        name: normalizeText(item.name, id),
        reasoning: item.reasoning === true,
        input,
        thinkingLevels: levels,
        available: item.available === true,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConfigurationError(message);
  }
  return value;
}

function asOptionalRecord(value: unknown, message: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value, message);
}

function readText(value: unknown, fallback: string, field: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
    throw new ConfigurationError(`${field} must be a string`);
  }
  return value;
}

function readProviderBaseUrl(value: unknown, fallback: string): string {
  const candidate = readText(value, fallback, 'providerBaseUrl').trim();
  if (candidate === '') return '';
  if (!isSafeHttpUrl(candidate)) {
    throw new ConfigurationError(
      'providerBaseUrl must be an HTTP(S) URL without embedded credentials',
    );
  }
  return candidate;
}

function readBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigurationError(`${field} must be a boolean`);
  }
  return value;
}

function readInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${field} must be an integer in the supported range`);
  }
  return value;
}

function readChoice<T extends string>(
  value: unknown,
  fallback: T,
  choices: readonly T[],
  field: string,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new ConfigurationError(`${field} has an unsupported value`);
  }
  return value as T;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigurationError(`${field} must be an array of strings`);
  }
  if (value.length > 100 || value.some((item) => item.length > 200)) {
    throw new ConfigurationError(`${field} is too large`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH ? value : fallback;
}

function normalizeProviderBaseUrl(value: unknown): string {
  const candidate = normalizeText(value, '').trim();
  return candidate !== '' && isSafeHttpUrl(candidate) ? candidate : '';
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function normalizeChoice<T extends string>(value: unknown, fallback: T, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? (value as T) : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 100)
    : [];
}
