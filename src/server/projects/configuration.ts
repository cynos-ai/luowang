import type Database from 'better-sqlite3';

import type { RepositoryConfig } from '../../shared/types.js';
import {
  ConfigurationError,
  mergeRepositoryConfiguration,
  normalizeRepository,
} from '../configuration.js';

export type ProjectConfiguration = Omit<RepositoryConfig, 'repository'> & {
  language: string;
  /** Empty uses LuoWang's built-in executor image. */
  executionDockerfile: string;
};

const ALLOWED_FIELDS = new Set([
  'language',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'pollIntervalSeconds',
  'cron',
  'triggerOnCommit',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
  'executionDockerfile',
]);
const TASK_SEMANTIC_FIELDS = [
  'language',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
  'executionDockerfile',
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
    const executionDockerfile = normalizeExecutionDockerfile(source.executionDockerfile);
    return { repository, config: { ...rest, language, executionDockerfile } };
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
          executionDockerfile: executionDockerfilePatch,
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
        const { repository: ignored, ...rest } = merged;
        void ignored;
        const executionDockerfile = normalizeExecutionDockerfile(
          executionDockerfilePatch === undefined
            ? current.config.executionDockerfile
            : executionDockerfilePatch,
        );
        const config = { ...rest, language, executionDockerfile };
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

function normalizeExecutionDockerfile(value: unknown): string {
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
