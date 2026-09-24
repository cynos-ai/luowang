import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { loadConfig } from '../config.js';
import { GitHubClient } from '../repository/github.js';
import { createSecretStore } from '../security/secret-store.js';
import { createLegacyBackup, verifyLegacyBackup } from './legacy-backup.js';
import { applyEmptyLegacyCutover, applyLegacyProjectCutover } from './legacy-cutover.js';
import { fingerprintLegacyDatabase } from './legacy-fingerprint.js';
import { inspectLegacyProject } from './legacy-preflight.js';
import { assertLegacySchema, assertProjectSchema } from './schema-mode.js';

/** Requires the server and all background workers to be stopped. Never creates a missing database. */
export async function runUpgradeCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const [command, backupDir, reviewedHistoryFingerprint] = args;
  if (
    !['inspect', 'backup', 'upgrade-empty', 'upgrade-project', 'verify'].includes(command ?? '') ||
    (['backup', 'upgrade-empty'].includes(command ?? '') && args.length !== 2) ||
    (command === 'upgrade-project' && (args.length < 2 || args.length > 3)) ||
    (['inspect', 'verify'].includes(command ?? '') && args.length !== 1)
  ) {
    throw new Error(
      '用法: db:multi-project inspect | backup <new-dir> | upgrade-empty <backup-dir> | upgrade-project <backup-dir> [reviewed-history-fingerprint] | verify',
    );
  }
  const config = loadConfig(environment);
  if (config.databasePath === ':memory:' || !existsSync(config.databasePath)) {
    throw new Error('离线升级要求已存在的文件数据库');
  }
  const database = new Database(config.databasePath, { fileMustExist: true });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  try {
    if (command === 'verify') {
      assertProjectSchema(database);
      return {
        status: 'complete',
        projects: (
          database.prepare('SELECT count(*) AS count FROM projects').get() as { count: number }
        ).count,
      };
    }
    if (
      !database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_metadata'")
        .get()
    ) {
      throw new Error('数据库尚未完成旧版本初始化');
    }
    const cutover = database
      .prepare(
        "SELECT key, value FROM system_metadata WHERE key IN ('v061_legacy_cutover_project_id', 'v061_empty_cutover')",
      )
      .all() as Array<{ key: string; value: string }>;
    if (cutover.length > 0 && (command === 'upgrade-empty' || command === 'upgrade-project')) {
      assertProjectSchema(database);
      if (
        (command === 'upgrade-empty' && cutover[0].key !== 'v061_empty_cutover') ||
        (command === 'upgrade-project' && cutover[0].key !== 'v061_legacy_cutover_project_id')
      ) {
        throw new Error('数据库已按另一种离线升级路径完成');
      }
      return { status: 'already_complete', projectId: cutover[0].value };
    }
    assertLegacySchema(database);
    if (command === 'inspect') {
      const result = inspectLegacyProject(database);
      return { ...result, fingerprint: fingerprintLegacyDatabase(database) };
    }
    const path = resolve(backupDir!);
    if (command === 'backup') {
      const manifest = await createLegacyBackup({
        database,
        databasePath: config.databasePath,
        repoDir: config.repoDir,
        reportDir: config.reportDir,
        backupDir: path,
      });
      return { status: 'backed_up', backupDir: path, manifest };
    }
    await verifyLegacyBackup(path);
    if (command === 'upgrade-empty') {
      await applyEmptyLegacyCutover({
        database,
        databasePath: config.databasePath,
        backupDir: path,
        masterKey: config.masterKey,
      });
      assertProjectSchema(database);
      return { status: 'complete', projects: 0 };
    }
    const preflight = inspectLegacyProject(database);
    if (!preflight.configuredRepository) throw new Error('旧实例没有可验证的仓库身份');
    const legacySecrets = createSecretStore(database, config.masterKey);
    const token = legacySecrets.get('gitToken');
    const verifiedRepository = await new GitHubClient({
      repositoryUrl: `https://github.com/${preflight.configuredRepository.owner}/${preflight.configuredRepository.name}`,
      tokenProvider: () => token,
    }).verifyIdentity();
    const projectId = await applyLegacyProjectCutover({
      database,
      databasePath: config.databasePath,
      backupDir: path,
      masterKey: config.masterKey,
      verifiedRepository,
      reviewedHistoryFingerprint,
    });
    assertProjectSchema(database);
    return { status: 'complete', projectId, repository: verifiedRepository };
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpgradeCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : '升级失败');
      process.exitCode = 1;
    });
}
