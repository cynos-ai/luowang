import type Database from 'better-sqlite3';
import { normalizeGeneratedDefinition, type GeneratedDefinition } from './generated-definition.js';

import type { RepositoryConfig } from '../../shared/types.js';
import {
  ConfigurationError,
  mergeRepositoryConfiguration,
  normalizeRepository,
} from '../configuration.js';

export type ProjectConfiguration = Omit<RepositoryConfig, 'repository'> & {
  language: string;
  browserAllowedOrigins: string[];
  testDataCleanupUrl: string;
  /** Empty uses LuoWang's built-in executor image. */
  executionDockerfile: string;
  runtimeMode: 'managed' | 'external' | 'repository-only';
  startType: 'single-container' | 'compose';
  runtime: ProjectRuntimeDefinition;
  generatedDefinition?: GeneratedDefinition | null;
  scheduleIntervalSeconds?: number;
};

export type ProjectRuntimeDefinition = {
  workingDirectory: string;
  prepareCommand: string[];
  startCommand: string[];
  servicePort: number | null;
  healthPath: string;
  healthTimeoutSeconds: number;
  composeFile: string;
  composeServices: string[];
  applicationService: string;
  commandService: string;
  initializationSteps?: Array<{ service: string; command: string; timeoutSeconds: number }>;
};

const ALLOWED_FIELDS = new Set([
  'language',
  'browserAllowedOrigins',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'pollIntervalSeconds',
  'cron',
  'triggerOnCommit',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
  'testDataCleanupUrl',
  'executionDockerfile',
  'runtimeMode',
  'startType',
  'runtime',
  'generatedDefinition',
  'scheduleIntervalSeconds',
]);
const TASK_SEMANTIC_FIELDS = [
  'language',
  'browserAllowedOrigins',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
  'testDataCleanupUrl',
  'executionDockerfile',
  'runtimeMode',
  'startType',
  'runtime',
  'generatedDefinition',
] as const;

export interface ProjectConfigurationStore {
  get(projectId: string): ProjectConfiguration;
  repositoryUrl(projectId: string): string;
  update(projectId: string, input: unknown): ProjectConfiguration;
}

export function createProjectConfigurationStore(
  database: Database.Database,
): ProjectConfigurationStore {
  function read(projectId: string): { repository: string; config: ProjectConfiguration } {
    const project = database
      .prepare('SELECT repository_owner, repository_name FROM projects WHERE project_id = ?')
      .get(projectId) as { repository_owner: string; repository_name: string } | undefined;
    if (!project) throw new ConfigurationError('项目不存在');
    const repository = `https://github.com/${project.repository_owner}/${project.repository_name}`;
    const row = database
      .prepare('SELECT value FROM project_config WHERE project_id = ?')
      .get(projectId) as { value: string } | undefined;
    let stored: unknown = {};
    if (row) {
      try {
        stored = JSON.parse(row.value) as unknown;
      } catch {
        throw new ConfigurationError('项目配置无法解析');
      }
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new ConfigurationError('项目配置无效');
    }
    const source = stored as Record<string, unknown>;
    if ('repository' in source) throw new ConfigurationError('项目配置不能包含仓库身份');
    const { repository: ignored, ...rest } = normalizeRepository({ ...source, repository });
    void ignored;
    const language =
      typeof source.language === 'string' && source.language.length <= 4096
        ? source.language
        : 'zh-CN';
    const browserAllowedOrigins = normalizeBrowserAllowedOrigins(source.browserAllowedOrigins);
    const executionDockerfile = normalizeExecutionDockerfile(source.executionDockerfile);
    const testDataCleanupUrl = normalizeTestDataCleanupUrl(source.testDataCleanupUrl);
    const runtimeMode = normalizeRuntimeMode(source.runtimeMode, row ? 'external' : 'managed');
    const startType = normalizeStartType(source.startType);
    const runtime = normalizeRuntimeDefinition(source.runtime);
    return {
      repository,
      config: {
        ...rest,
        language,
        browserAllowedOrigins,
        executionDockerfile,
        testDataCleanupUrl,
        runtimeMode,
        startType,
        runtime,
        generatedDefinition: normalizeGeneratedDefinition(source.generatedDefinition),
        scheduleIntervalSeconds: normalizeScheduleInterval(source.scheduleIntervalSeconds),
      },
    };
  }

  return {
    get(projectId) {
      return read(projectId).config;
    },
    repositoryUrl(projectId) {
      return read(projectId).repository;
    },
    update(projectId, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ConfigurationError('项目配置必须是对象');
      }
      const patch = input as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        if (!ALLOWED_FIELDS.has(key))
          throw new ConfigurationError(`项目配置包含不支持的字段：${key}`);
      }
      return database.transaction(() => {
        const current = read(projectId);
        const {
          language: languagePatch,
          browserAllowedOrigins: browserAllowedOriginsPatch,
          executionDockerfile: executionDockerfilePatch,
          testDataCleanupUrl: cleanupUrlPatch,
          runtimeMode: runtimeModePatch,
          startType: startTypePatch,
          runtime: runtimePatch,
          generatedDefinition: generatedPatch,
          scheduleIntervalSeconds: schedulePatch,
          ...repositoryPatch
        } = patch;
        const merged = mergeRepositoryConfiguration(
          { repository: current.repository, ...current.config },
          repositoryPatch,
        );
        const language = languagePatch === undefined ? current.config.language : languagePatch;
        if (typeof language !== 'string' || language.length > 4096) {
          throw new ConfigurationError('language must be a string');
        }
        const browserAllowedOrigins = normalizeBrowserAllowedOrigins(
          browserAllowedOriginsPatch === undefined
            ? current.config.browserAllowedOrigins
            : browserAllowedOriginsPatch,
        );
        const { repository: ignored, ...rest } = merged;
        void ignored;
        const executionDockerfile = normalizeExecutionDockerfile(
          executionDockerfilePatch === undefined
            ? current.config.executionDockerfile
            : executionDockerfilePatch,
        );
        const testDataCleanupUrl = normalizeTestDataCleanupUrl(
          cleanupUrlPatch === undefined ? current.config.testDataCleanupUrl : cleanupUrlPatch,
        );
        const runtimeMode = normalizeRuntimeMode(
          runtimeModePatch === undefined ? current.config.runtimeMode : runtimeModePatch,
          current.config.runtimeMode,
        );
        const startType = normalizeStartType(
          startTypePatch === undefined ? current.config.startType : startTypePatch,
        );
        const runtime = normalizeRuntimeDefinition(
          runtimePatch === undefined ? current.config.runtime : runtimePatch,
        );
        const config = {
          ...rest,
          language,
          browserAllowedOrigins,
          executionDockerfile,
          testDataCleanupUrl,
          runtimeMode,
          startType,
          runtime,
          generatedDefinition: normalizeGeneratedDefinition(
            generatedPatch === undefined ? current.config.generatedDefinition : generatedPatch,
          ),
          scheduleIntervalSeconds: normalizeScheduleInterval(
            schedulePatch === undefined ? current.config.scheduleIntervalSeconds : schedulePatch,
          ),
        };
        if (config.cron.trim() && config.scheduleIntervalSeconds > 0)
          throw new ConfigurationError('定时间隔与 Cron 只能启用一种');
        const semanticChange = TASK_SEMANTIC_FIELDS.some(
          (key) => JSON.stringify(config[key]) !== JSON.stringify(current.config[key]),
        );
        if (semanticChange) {
          const pending = database
            .prepare(
              `SELECT count(*) AS count FROM test_request_queue
               WHERE project_id = ? AND status IN ('queued', 'running', 'waiting_archive')`,
            )
            .get(projectId) as { count: number };
          if (pending.count > 0) {
            throw new ConfigurationError(
              `项目仍有 ${pending.count} 个待处理请求，不能修改测试语义配置`,
            );
          }
        }
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO project_config (project_id, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(projectId, JSON.stringify(config), now);
        database
          .prepare(
            'UPDATE projects SET config_revision = config_revision + 1, updated_at = ? WHERE project_id = ?',
          )
          .run(now, projectId);
        return config;
      })();
    },
  };
}

export function normalizeScheduleInterval(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 7 * 86400)
    throw new ConfigurationError('定时间隔须为 0–604800 秒');
  return value as number;
}

export function normalizeBrowserAllowedOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    throw new ConfigurationError('浏览器额外来源无效');
  const origins = value.map((item) => {
    if (typeof item !== 'string' || item.length > 2048)
      throw new ConfigurationError('浏览器额外来源无效');
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new ConfigurationError('浏览器额外来源无效');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      (item !== parsed.origin && item !== `${parsed.origin}/`)
    )
      throw new ConfigurationError('浏览器额外来源必须是完整的 HTTP(S) origin');
    return parsed.origin;
  });
  return [...new Set(origins)];
}

export function normalizeRuntimeMode(
  value: unknown,
  fallback: ProjectConfiguration['runtimeMode'] = 'managed',
): ProjectConfiguration['runtimeMode'] {
  if (value === undefined) return fallback;
  if (value !== 'managed' && value !== 'external' && value !== 'repository-only')
    throw new ConfigurationError('项目运行模式无效');
  return value;
}

export function normalizeStartType(value: unknown): ProjectConfiguration['startType'] {
  if (value === undefined) return 'single-container';
  if (value !== 'single-container' && value !== 'compose')
    throw new ConfigurationError('项目启动方式无效');
  return value;
}

export function normalizeRuntimeDefinition(value: unknown): ProjectRuntimeDefinition {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const path = (input: unknown, fallback: string) => {
    const result = input === undefined ? fallback : input;
    if (
      typeof result !== 'string' ||
      result.length > 255 ||
      result.includes('\\') ||
      result.startsWith('/') ||
      result.split('/').some((part) => part === '..')
    )
      throw new ConfigurationError('运行路径无效');
    return result;
  };
  const command = (input: unknown) => {
    if (input === undefined) return [];
    if (
      !Array.isArray(input) ||
      input.length > 64 ||
      input.some(
        (item) =>
          typeof item !== 'string' ||
          item.length === 0 ||
          item.length > 4096 ||
          item.includes('\0'),
      )
    )
      throw new ConfigurationError('运行命令必须是参数数组');
    return input as string[];
  };
  const services = source.composeServices === undefined ? [] : source.composeServices;
  if (
    !Array.isArray(services) ||
    services.length > 32 ||
    services.some(
      (item) => typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(item),
    )
  )
    throw new ConfigurationError('Compose 服务列表无效');
  if (new Set(services).size !== services.length)
    throw new ConfigurationError('Compose 服务列表不能重复');
  const servicePort =
    source.servicePort === undefined || source.servicePort === null ? null : source.servicePort;
  if (
    servicePort !== null &&
    (!Number.isInteger(servicePort) ||
      (servicePort as number) < 1 ||
      (servicePort as number) > 65535)
  )
    throw new ConfigurationError('服务端口无效');
  const timeout = source.healthTimeoutSeconds ?? 60;
  if (!Number.isInteger(timeout) || (timeout as number) < 5 || (timeout as number) > 600)
    throw new ConfigurationError('健康检查超时无效');
  const applicationService = serviceName(source.applicationService);
  const commandService = serviceName(source.commandService);
  if (
    (applicationService && !services.includes(applicationService)) ||
    (commandService && !services.includes(commandService))
  ) {
    throw new ConfigurationError('应用和测试服务必须包含在 Compose 服务列表中');
  }
  return {
    workingDirectory: path(source.workingDirectory, '.'),
    prepareCommand: command(source.prepareCommand),
    startCommand: command(source.startCommand),
    servicePort: servicePort as number | null,
    healthPath: httpPath(source.healthPath),
    healthTimeoutSeconds: timeout as number,
    composeFile: path(source.composeFile, 'compose.yml'),
    composeServices: services as string[],
    applicationService,
    commandService,
    initializationSteps: normalizeInitializationSteps(
      source.initializationSteps,
      services as string[],
      applicationService,
    ),
  };
}

function normalizeInitializationSteps(
  value: unknown,
  services: string[],
  applicationService: string,
): ProjectRuntimeDefinition['initializationSteps'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new ConfigurationError('初始化步骤无效');
  return value.map((entry: unknown) => {
    const step = entry as Record<string, unknown> | null;
    if (
      !step ||
      typeof step.service !== 'string' ||
      !services.includes(step.service) ||
      step.service === applicationService ||
      typeof step.command !== 'string' ||
      !step.command.trim() ||
      step.command.length > 16_384 ||
      step.command.includes('\0') ||
      !Number.isInteger(step.timeoutSeconds) ||
      (step.timeoutSeconds as number) < 1 ||
      (step.timeoutSeconds as number) > 900
    )
      throw new ConfigurationError('初始化步骤须指定非应用服务、命令和 1–900 秒超时');
    return {
      service: step.service,
      command: step.command,
      timeoutSeconds: step.timeoutSeconds as number,
    };
  });
}

function httpPath(value: unknown): string {
  const path = value ?? '/';
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length > 512 ||
    /[?#\\\s]/.test(path)
  )
    throw new ConfigurationError('健康检查路径无效');
  return path;
}
function serviceName(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value))
    throw new ConfigurationError('Compose 服务名无效');
  return value;
}

export function normalizeExecutionDockerfile(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 255 || value.includes('\\')) {
    throw new ConfigurationError('项目 Dockerfile 路径无效');
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment),
    )
  ) {
    throw new ConfigurationError('项目 Dockerfile 路径无效');
  }
  return value;
}

export function normalizeTestDataCleanupUrl(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) {
    throw new ConfigurationError('测试数据清理地址无效');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('测试数据清理地址无效');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigurationError('测试数据清理地址无效');
  }
  return parsed.href;
}
