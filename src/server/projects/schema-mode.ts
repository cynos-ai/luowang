import type Database from 'better-sqlite3';

const LEGACY_VERSIONS = new Set([
  '0000_foundation',
  '0001_secure_console',
  '0002_repository_index',
  '0003_run_archive',
  '0004_automation_recovery',
  '0005_scenario_lifecycle',
  '0006_closure_merge_queue',
  '0007_run_observability',
  '0008_run_activity',
]);

const PROJECT_VERSIONS = [
  '0009_project_identity',
  '0010_project_index_ownership',
  '0011_project_run_ownership',
  '0012_project_configuration_ownership',
  '0013_project_secret_ownership',
  '0014_project_queue_context',
  '0015_project_image_state',
  '0016_project_run_image',
  '0017_project_report_index_identity',
];

export function assertLegacySchema(database: Database.Database): void {
  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!existing) {
    const otherTables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (otherTables.length === 0) return;
    throw new Error('数据库无迁移记录，拒绝以旧单项目模式启动');
  }
  const versions = database.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: string;
  }>;
  if (versions.some(({ version }) => !LEGACY_VERSIONS.has(version))) {
    throw new Error('数据库已升级或迁移状态未知，旧单项目服务拒绝启动');
  }
}

export function assertProjectSchema(database: Database.Database): void {
  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!existing) throw new Error('多项目数据库尚未离线升级');
  const versions = new Set(
    (
      database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>
    ).map(({ version }) => version),
  );
  if (
    versions.size !== LEGACY_VERSIONS.size + PROJECT_VERSIONS.length ||
    [...LEGACY_VERSIONS, ...PROJECT_VERSIONS].some((version) => !versions.has(version))
  ) {
    throw new Error('多项目数据库迁移不完整或包含未知版本');
  }
  const markers = database
    .prepare(
      "SELECT key FROM system_metadata WHERE key IN ('v061_legacy_cutover_project_id', 'v061_empty_cutover')",
    )
    .all() as Array<{ key: string }>;
  if (markers.length !== 1) throw new Error('多项目数据库缺少唯一离线切换标记');
}
