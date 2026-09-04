import { parseDocument, stringify } from 'yaml';

import type { HarnessConfig, RepositoryConfig } from '../shared/types.js';
import { ConfigurationError } from './configuration.js';

const CONFIG_VERSION = 1;
export const MAX_CONFIG_YAML_BYTES = 128 * 1024;

const ROOT_KEYS = ['version', 'harness', 'repository'] as const;
const HARNESS_KEYS = ['language', 'provider', 'providerBaseUrl', 'agents', 'local', 'mcp', 'oss'];
const AGENT_GROUP_KEYS = ['main', 'runner', 'reviewer'];
const AGENT_KEYS = ['model', 'thinking'];
const LOCAL_KEYS = ['repoDir', 'reportDir', 'retentionDays'];
const MCP_KEYS = ['enabled', 'browser', 'headless', 'timeoutMs'];
const OSS_KEYS = ['endpoint', 'region', 'bucket', 'publicBaseUrl', 'accessMode', 'objectPrefix'];
const REPOSITORY_KEYS = [
  'repository',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'pollIntervalSeconds',
  'cron',
  'triggerOnCommit',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
];

export interface ImportedConfiguration {
  harness: HarnessConfig;
  repository: RepositoryConfig;
}

export function exportConfigurationYaml(configuration: ImportedConfiguration): string {
  const body = stringify(
    {
      version: CONFIG_VERSION,
      harness: configuration.harness,
      repository: configuration.repository,
    },
    { lineWidth: 0 },
  );
  return [
    '# LuoWang configuration export',
    '# Secrets and connectivity results are intentionally excluded.',
    body.trimEnd(),
    '',
  ].join('\n');
}

export function parseConfigurationYaml(source: unknown): ImportedConfiguration {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_CONFIG_YAML_BYTES) {
    throw new ConfigurationError('配置文件必须是小于 128 KiB 的 YAML 文本');
  }
  let value: unknown;
  try {
    const document = parseDocument(source, {
      merge: false,
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
      version: '1.2',
    });
    if (document.errors.length > 0) throw document.errors[0];
    value = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    throw new ConfigurationError('配置 YAML 无效，不能包含重复键或 alias');
  }

  const root = requireObject(value, '配置 YAML 根节点');
  if (containsSecretsKey(root)) {
    throw new ConfigurationError('配置 YAML 不允许包含 secrets；Secret 只能通过页面安全保存');
  }
  assertExactKeys(root, ROOT_KEYS, '配置 YAML 根节点');
  if (root.version !== CONFIG_VERSION) {
    throw new ConfigurationError(`不支持的配置 YAML version：${String(root.version)}`);
  }

  const harness = requireObject(root.harness, 'harness');
  const repository = requireObject(root.repository, 'repository');
  assertExactKeys(harness, HARNESS_KEYS, 'harness');
  assertExactKeys(repository, REPOSITORY_KEYS, 'repository');

  const agents = requireObject(harness.agents, 'harness.agents');
  const local = requireObject(harness.local, 'harness.local');
  const mcp = requireObject(harness.mcp, 'harness.mcp');
  const oss = requireObject(harness.oss, 'harness.oss');
  assertExactKeys(agents, AGENT_GROUP_KEYS, 'harness.agents');
  assertExactKeys(local, LOCAL_KEYS, 'harness.local');
  assertExactKeys(mcp, MCP_KEYS, 'harness.mcp');
  assertExactKeys(oss, OSS_KEYS, 'harness.oss');
  for (const role of AGENT_GROUP_KEYS) {
    assertExactKeys(
      requireObject(agents[role], `harness.agents.${role}`),
      AGENT_KEYS,
      `harness.agents.${role}`,
    );
  }

  return {
    harness: harness as unknown as HarnessConfig,
    repository: repository as unknown as RepositoryConfig,
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const expected = new Set(expectedKeys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !(key in value));
  if (unknown.length > 0) {
    throw new ConfigurationError(`${field} 包含未知字段：${unknown.join(', ')}`);
  }
  if (missing.length > 0) {
    throw new ConfigurationError(`${field} 缺少字段：${missing.join(', ')}`);
  }
}

function containsSecretsKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretsKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key.toLowerCase() === 'secrets' || containsSecretsKey(child),
  );
}
