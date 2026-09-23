import { resolve, join } from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../db/migrate.js';
import { projectIdentityMigration } from '../db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../db/migrations/0012-project-configuration-ownership.js';
import { migrateLegacySecretOwnership } from '../db/migrations/0013-project-secret-ownership.js';
import type { VerifiedGitHubRepositoryIdentity } from '../repository/github.js';
import { verifyLegacyBackup } from './legacy-backup.js';
import { fingerprintLegacyDatabase } from './legacy-fingerprint.js';
import { inspectLegacyProject } from './legacy-preflight.js';
import { createProjectStore } from './store.js';

const CUTOVER_KEY = 'v061_legacy_cutover_project_id';
const HISTORY_BLOCKER = '旧 Run/请求没有逐条仓库 ID，数据库本身无法证明全部历史的唯一归属';

export interface LegacyCutoverInput {
  database: Database.Database;
  databasePath: string;
  backupDir: string;
  masterKey: string | undefined;
  verifiedRepository: VerifiedGitHubRepositoryIdentity;
  /** Supplied only after manual review of every historical Run/request against this repository. */
  reviewedHistoryFingerprint?: string;
}

/** Offline only: caller must stop all LuoWang processes before making and verifying the backup. */
export async function applyLegacyProjectCutover(input: LegacyCutoverInput): Promise<string> {
  if (
    input.database.name === ':memory:' ||
    resolve(input.database.name) !== resolve(input.databasePath)
  ) {
    throw new Error('离线升级数据库路径不匹配');
  }
  const previous = input.database
    .prepare('SELECT value FROM system_metadata WHERE key = ?')
    .get(CUTOVER_KEY) as { value: string } | undefined;
  if (previous) {
    const project = createProjectStore(input.database).get(previous.value);
    if (!project) throw new Error('升级标记对应项目不存在');
    const completed = input.database
      .prepare(
        "SELECT version FROM schema_migrations WHERE version IN ('0009_project_identity', '0010_project_index_ownership', '0011_project_run_ownership', '0012_project_configuration_ownership', '0013_project_secret_ownership')",
      )
      .all() as Array<{ version: string }>;
    if (completed.length !== 5) throw new Error('升级标记对应迁移不完整');
    if (project.githubRepositoryId !== input.verifiedRepository.githubRepositoryId) {
      throw new Error('重复升级的 GitHub 仓库身份不一致');
    }
    return previous.value;
  }

  await verifyLegacyBackup(input.backupDir);
  const backup = new Database(join(resolve(input.backupDir), 'luowang.db'), {
    readonly: true,
    fileMustExist: true,
  });
  let backupFingerprint: string;
  try {
    backupFingerprint = fingerprintLegacyDatabase(backup);
  } finally {
    backup.close();
  }
  const currentFingerprint = fingerprintLegacyDatabase(input.database);
  if (currentFingerprint !== backupFingerprint) {
    throw new Error('当前数据库与已核验备份内容不一致');
  }
  const preflight = inspectLegacyProject(input.database);
  if (!preflight.configuredRepository || preflight.status === 'empty') {
    throw new Error('此升级入口需要唯一且已配置的旧仓库');
  }
  const remainingBlockers = preflight.blockers.filter((reason) => reason !== HISTORY_BLOCKER);
  if (remainingBlockers.length > 0)
    throw new Error(`旧实例预检失败：${remainingBlockers.join('；')}`);
  if (
    preflight.requiresHistoryOwnershipReview &&
    input.reviewedHistoryFingerprint !== currentFingerprint
  ) {
    throw new Error('旧历史归属尚未人工核对当前数据库摘要');
  }
  if (
    preflight.configuredRepository.owner.toLowerCase() !==
      input.verifiedRepository.owner.toLowerCase() ||
    preflight.configuredRepository.name.toLowerCase() !==
      input.verifiedRepository.name.toLowerCase()
  ) {
    throw new Error('GitHub 已验证仓库身份与旧配置不一致');
  }

  return input.database.transaction(() => {
    if (fingerprintLegacyDatabase(input.database) !== currentFingerprint) {
      throw new Error('升级期间旧数据库已变化');
    }
    runMigrations(input.database, [projectIdentityMigration]);
    const project = createProjectStore(input.database).createVerified({
      displayName: '旧项目',
      repository: input.verifiedRepository,
    });
    migrateLegacyIndexOwnership(input.database, project.projectId);
    migrateLegacyRunOwnership(input.database, project.projectId);
    migrateLegacyConfigurationOwnership(input.database, project.projectId);
    migrateLegacySecretOwnership(input.database, input.masterKey, project.projectId);
    if ((input.database.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('升级后的数据库外键检查失败');
    }
    const now = new Date().toISOString();
    input.database
      .prepare(
        'INSERT INTO system_metadata (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(CUTOVER_KEY, project.projectId, now, now);
    return project.projectId;
  })();
}
