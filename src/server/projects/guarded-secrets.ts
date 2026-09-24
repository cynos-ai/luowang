import type Database from 'better-sqlite3';

import {
  type BoundSecretStore,
  type DeploymentSecretKey,
  type ProjectSecretKey,
  type ScopedSecretStore,
} from '../security/scoped-secret-store.js';

const PROJECT_TASK_SECRETS = new Set<ProjectSecretKey>([
  'testUsername',
  'testPassword',
  'testDataCleanupToken',
]);

/** Public mutation boundary; the low-level scoped store remains usable by offline migration. */
export function createGuardedScopedSecretStore(
  database: Database.Database,
  scoped: ScopedSecretStore,
): ScopedSecretStore {
  return {
    deployment(): BoundSecretStore<DeploymentSecretKey> {
      const store = scoped.deployment();
      return {
        ...readMethods(store),
        set(key, value) {
          guardDeployment(database, key);
          store.set(key, value);
        },
        delete(key) {
          guardDeployment(database, key);
          store.delete(key);
        },
      };
    },
    project(projectId): BoundSecretStore<ProjectSecretKey> {
      if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
        throw new Error('项目不存在');
      }
      const store = scoped.project(projectId);
      return {
        ...readMethods(store),
        set(key, value) {
          guardProject(database, projectId, key);
          store.set(key, value);
        },
        delete(key) {
          guardProject(database, projectId, key);
          store.delete(key);
        },
      };
    },
  };
}

function readMethods<K extends DeploymentSecretKey | ProjectSecretKey>(store: BoundSecretStore<K>) {
  return {
    isAvailable: () => store.isAvailable(),
    get: (key: K) => store.get(key),
    has: (key: K) => store.has(key),
    metadata: () => store.metadata(),
  };
}

function guardDeployment(database: Database.Database, key: DeploymentSecretKey): void {
  if (key !== 'providerApiKey') return;
  if (database.prepare("SELECT 1 FROM test_request_queue WHERE status = 'running' LIMIT 1").get()) {
    throw new Error('存在运行中请求，不能轮换 Provider 凭据');
  }
}

function guardProject(database: Database.Database, projectId: string, key: ProjectSecretKey): void {
  if (!PROJECT_TASK_SECRETS.has(key)) return;
  const pending = database
    .prepare(
      `SELECT count(*) AS count FROM test_request_queue
       WHERE project_id = ? AND status IN ('queued', 'running', 'waiting_archive')`,
    )
    .get(projectId) as { count: number };
  if (pending.count > 0) {
    throw new Error(`项目仍有 ${pending.count} 个待处理请求，不能替换测试或清理凭据`);
  }
}
