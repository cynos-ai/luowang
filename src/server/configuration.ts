import type Database from 'better-sqlite3';

import type {
  AgentConfig,
  HarnessConfig,
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

    const next: HarnessConfig = {
      language: readText(patch.language, current.language, 'language'),
      provider: readText(patch.provider, current.provider, 'provider'),
      providerBaseUrl: readProviderBaseUrl(patch.providerBaseUrl, current.providerBaseUrl),
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
          0,
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
          100,
          300_000,
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
    this.write(HARNESS_KEY, next);
    return next;
  }

  updateRepository(input: unknown): RepositoryConfig {
    const current = this.getRepository();
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
      triggerOnCommit: readBoolean(
        patch.triggerOnCommit,
        current.triggerOnCommit,
        'triggerOnCommit',
      ),
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
    agents: {
      main: { model: '', thinking: 'medium' },
      runner: { model: '', thinking: 'medium' },
      reviewer: { model: '', thinking: 'medium' },
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

  return {
    language: normalizeText(source.language, defaults.language),
    provider: normalizeText(source.provider, defaults.provider),
    providerBaseUrl: normalizeProviderBaseUrl(source.providerBaseUrl),
    agents: {
      main: normalizeAgent(agents.main, defaults.agents.main),
      runner: normalizeAgent(agents.runner, defaults.agents.runner),
      reviewer: normalizeAgent(agents.reviewer, defaults.agents.reviewer),
    },
    local: {
      repoDir: normalizeText(local.repoDir, defaults.local.repoDir),
      reportDir: normalizeText(local.reportDir, defaults.local.reportDir),
      retentionDays: normalizeInteger(local.retentionDays, defaults.local.retentionDays, 0, 36_500),
    },
    mcp: {
      enabled: normalizeBoolean(mcp.enabled, defaults.mcp.enabled),
      browser: normalizeChoice(mcp.browser, defaults.mcp.browser, [
        'chromium',
        'firefox',
        'webkit',
      ]),
      headless: normalizeBoolean(mcp.headless, defaults.mcp.headless),
      timeoutMs: normalizeInteger(mcp.timeoutMs, defaults.mcp.timeoutMs, 100, 300_000),
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

function normalizeRepository(value: unknown): RepositoryConfig {
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
    model: readText(source.model, fallback.model, `${field}.model`),
    thinking: readChoice(
      source.thinking,
      fallback.thinking,
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      `${field}.thinking`,
    ),
  };
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
