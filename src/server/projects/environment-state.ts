import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createProjectAutomationStateStore } from '../automation/state.js';
import { ConfigurationError } from '../configuration.js';

export function environmentFingerprint(...values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Opaque encrypted-entry revisions, never plaintext or a password hash. */
export function preparationCredentialRevision(
  database: Database.Database,
  projectId: string,
): unknown {
  if (
    !database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='secret_entries'")
      .get()
  )
    return [];
  return database
    .prepare('SELECT key, nonce FROM secret_entries WHERE key IN (?, ?) ORDER BY key')
    .all(`project:${projectId}:testUsername`, `project:${projectId}:testPassword`);
}

/** Latest preparation facts share the project's existing persistent state and deletion owner. */
export function environmentState<T>(
  database: Database.Database,
  projectId: string,
  kind: 'generation' | 'validation',
) {
  const state = createProjectAutomationStateStore(database, projectId);
  const key = `environment.${kind}`;
  return {
    get(): T | null {
      const value = state.get(key);
      return value ? (JSON.parse(value) as T) : null;
    },
    set(value: T) {
      state.set(key, JSON.stringify(value));
    },
  };
}

export function assertEnvironmentIdle(database: Database.Database, projectId: string): void {
  if (
    database
      .prepare(
        "SELECT 1 FROM test_request_queue WHERE project_id=? AND status IN ('queued','running','waiting_archive')",
      )
      .get(projectId)
  )
    throw new ConfigurationError('项目有待处理测试，请结束后再操作环境配置');
  if (
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_ledger'",
      )
      .get() &&
    database
      .prepare("SELECT 1 FROM execution_resource_ledger WHERE project_id=? AND state <> 'released'")
      .get(projectId)
  )
    throw new ConfigurationError('项目正在准备环境或资源尚未清理，请结束后再操作');
}
