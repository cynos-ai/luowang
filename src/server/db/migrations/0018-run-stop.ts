import type Database from 'better-sqlite3';

export const RUN_STOP_VERSION = '0018_run_stop';

/** Additive upgrade; no historical result or configuration is rewritten. */
export function migrateRunStop(database: Database.Database): void {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(RUN_STOP_VERSION))
    return;
  if (
    !database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0014_project_queue_context'")
      .get()
  ) {
    throw new Error('停止功能需要已迁移的项目队列');
  }
  database.transaction(() => {
    database.exec(`
      ALTER TABLE test_request_queue ADD COLUMN stop_requested_at TEXT;
      ALTER TABLE test_request_queue ADD COLUMN stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason = 'user_requested');
      ALTER TABLE interrupted_run_records ADD COLUMN snapshot_json TEXT;
      CREATE TABLE active_run_snapshots (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        snapshot_json TEXT NOT NULL
      );
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(RUN_STOP_VERSION, new Date().toISOString());
  })();
}
