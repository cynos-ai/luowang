import type Database from 'better-sqlite3';

import { parseGitHubRepository } from '../../repository/github.js';

const VERSION = '0012_project_configuration_ownership';
const OWNER_KEY = 'legacy_config_owner_project_id';
const PROJECT_CHECKS = [
  'test-environment-url',
  'github-repository-read',
  'github-scenario-branch-write',
  'github-pull-request',
  'github-issue',
] as const;
const TEXT_FIELDS = [
  'scenarioBranch',
  'scenarioMode',
  'cron',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
] as const;
const ALLOWED_REPOSITORY_KEYS = new Set([
  'repository',
  ...TEXT_FIELDS,
  'scenarioLabels',
  'pollIntervalSeconds',
  'triggerOnCommit',
]);

/** Staged offline migration; the final cutover must wrap all ownership changes together. */
export function migrateLegacyConfigurationOwnership(
  database: Database.Database,
  legacyProjectId: string | null,
): boolean {
  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(VERSION);
  if (applied) {
    const owner = database
      .prepare('SELECT value FROM system_metadata WHERE key = ?')
      .get(OWNER_KEY) as { value: string } | undefined;
    if (owner?.value !== (legacyProjectId ?? '')) throw new Error('旧配置迁移归属与已有记录不一致');
    return false;
  }
  const project = database
    .prepare('SELECT repository_owner, repository_name FROM projects WHERE project_id = ?')
    .get(legacyProjectId) as { repository_owner: string; repository_name: string } | undefined;
  if (legacyProjectId !== null && !project) throw new Error('旧配置迁移的项目不存在');
  const repositoryRow = database
    .prepare("SELECT value, updated_at FROM app_config WHERE key = 'repository'")
    .get() as { value: string; updated_at: string } | undefined;
  if (legacyProjectId !== null && !repositoryRow) throw new Error('旧仓库配置不存在');
  if (legacyProjectId === null && repositoryRow) throw new Error('空实例包含旧仓库配置');
  const repository = repositoryRow ? parseStoredObject(repositoryRow.value, '旧仓库配置') : null;
  if (repository && typeof repository.repository !== 'string')
    throw new Error('旧仓库配置缺少仓库身份');
  if (repository && project) {
    const configuredRepository = parseGitHubRepository(repository.repository as string);
    if (
      configuredRepository.owner.toLowerCase() !== project.repository_owner.toLowerCase() ||
      configuredRepository.name.toLowerCase() !== project.repository_name.toLowerCase()
    ) {
      throw new Error('旧仓库配置与目标项目身份不一致');
    }
  }
  for (const [key, value] of Object.entries(repository ?? {})) {
    if (!ALLOWED_REPOSITORY_KEYS.has(key)) throw new Error('旧仓库配置包含未知字段');
    if (
      ((TEXT_FIELDS as readonly string[]).includes(key) && typeof value !== 'string') ||
      (key === 'scenarioLabels' &&
        (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) ||
      (key === 'pollIntervalSeconds' && (!Number.isInteger(value) || (value as number) < 0)) ||
      (key === 'triggerOnCommit' && typeof value !== 'boolean')
    ) {
      throw new Error('旧仓库配置字段类型无效');
    }
  }
  const harnessRow = database
    .prepare("SELECT value FROM app_config WHERE key = 'harness'")
    .get() as { value: string } | undefined;
  const harness = harnessRow ? parseStoredObject(harnessRow.value, '旧部署配置') : {};
  const language =
    typeof harness.language === 'string' && harness.language.trim()
      ? harness.language.trim()
      : 'zh-CN';
  const projectFields = { ...repository };
  delete projectFields.repository;
  const projectConfiguration = JSON.stringify({ ...projectFields, language });
  if (legacyProjectId === null) {
    for (const table of ['automation_state']) {
      if (
        (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
          .count > 0
      ) {
        throw new Error('空实例包含旧自动化状态');
      }
    }
    const placeholders = PROJECT_CHECKS.map(() => '?').join(', ');
    if (
      (
        database
          .prepare(
            `SELECT count(*) AS count FROM connectivity_check_results WHERE check_id IN (${placeholders})`,
          )
          .get(...PROJECT_CHECKS) as { count: number }
      ).count > 0
    ) {
      throw new Error('空实例包含旧项目连通性结果');
    }
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE project_config (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(project_id),
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_automation_state (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );

      CREATE TABLE project_connectivity_check_results (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        latency_ms INTEGER,
        PRIMARY KEY (project_id, check_id)
      );
    `);
    if (repositoryRow && legacyProjectId !== null)
      database
        .prepare('INSERT INTO project_config (project_id, value, updated_at) VALUES (?, ?, ?)')
        .run(legacyProjectId, projectConfiguration, repositoryRow.updated_at);
    database
      .prepare(
        `INSERT INTO project_automation_state (project_id, key, value, updated_at)
         SELECT ?, key, value, updated_at FROM automation_state`,
      )
      .run(legacyProjectId);
    const placeholders = PROJECT_CHECKS.map(() => '?').join(', ');
    database
      .prepare(
        `INSERT INTO project_connectivity_check_results
           (project_id, check_id, status, message, checked_at, latency_ms)
         SELECT ?, check_id, status, message, checked_at, latency_ms
         FROM connectivity_check_results WHERE check_id IN (${placeholders})`,
      )
      .run(legacyProjectId, ...PROJECT_CHECKS);
    database.prepare("DELETE FROM app_config WHERE key = 'repository'").run();
    database.prepare('DELETE FROM automation_state').run();
    database
      .prepare(`DELETE FROM connectivity_check_results WHERE check_id IN (${placeholders})`)
      .run(...PROJECT_CHECKS);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO system_metadata (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(OWNER_KEY, legacyProjectId ?? '', now, now);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, now);
  })();
  return true;
}

function parseStoredObject(value: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${source}无法解析`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source}必须是对象`);
  }
  return parsed as Record<string, unknown>;
}
