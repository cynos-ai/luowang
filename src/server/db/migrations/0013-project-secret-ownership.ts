import type Database from 'better-sqlite3';

import {
  createScopedSecretStore,
  type DeploymentSecretKey,
  type ProjectSecretKey,
} from '../../security/scoped-secret-store.js';
import { createSecretStore, isSecretKey, type SecretStore } from '../../security/secret-store.js';

const VERSION = '0013_project_secret_ownership';
const OWNER_KEY = 'legacy_secret_owner_project_id';
const DEPLOYMENT_KEYS = new Set<DeploymentSecretKey>([
  'providerApiKey',
  'ossAccessKeyId',
  'ossAccessKeySecret',
]);

/** Staged offline migration. The final cutover must wrap this with all ownership migrations. */
export function migrateLegacySecretOwnership(
  database: Database.Database,
  masterKey: string | undefined,
  legacyProjectId: string,
): boolean {
  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(VERSION);
  if (applied) {
    const owner = database
      .prepare('SELECT value FROM system_metadata WHERE key = ?')
      .get(OWNER_KEY) as { value: string } | undefined;
    if (owner?.value !== legacyProjectId) throw new Error('旧 Secret 迁移归属与已有记录不一致');
    return false;
  }
  if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(legacyProjectId)) {
    throw new Error('旧 Secret 迁移的项目不存在');
  }
  const legacyKeys = (
    database.prepare('SELECT key FROM secret_entries').all() as Array<{ key: string }>
  ).map((row) => row.key);
  if (legacyKeys.some((key) => !isSecretKey(key))) {
    throw new Error('旧 Secret 表包含未知或已作用域化的键');
  }
  const oldStore: SecretStore = createSecretStore(database, masterKey);
  const plaintext = legacyKeys.map((key) => {
    if (!isSecretKey(key)) throw new Error('旧 Secret 键无效');
    const value = oldStore.get(key);
    if (value === undefined) throw new Error('旧 Secret 读取不完整');
    return { key, value };
  });
  const scoped = createScopedSecretStore(database, masterKey);
  database.transaction(() => {
    for (const { key, value } of plaintext) {
      if (DEPLOYMENT_KEYS.has(key as DeploymentSecretKey)) {
        scoped.deployment().set(key as DeploymentSecretKey, value);
      } else {
        scoped.project(legacyProjectId).set(key as ProjectSecretKey, value);
      }
    }
    database
      .prepare(
        `DELETE FROM secret_entries WHERE key NOT LIKE 'deployment:%' AND key NOT LIKE 'project:%'`,
      )
      .run();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO system_metadata (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(OWNER_KEY, legacyProjectId, now, now);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, now);
  })();
  return true;
}
