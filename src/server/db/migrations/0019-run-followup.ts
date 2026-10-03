import type Database from 'better-sqlite3';
import { migrateRunStop } from './0018-run-stop.js';

export const RUN_FOLLOWUP_VERSION = '0019_run_followup';

export function migrateRunFollowup(database: Database.Database): void {
  migrateRunStop(database);
  if (
    database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(RUN_FOLLOWUP_VERSION)
  )
    return;
  database.transaction(() => {
    database.exec(`
      ALTER TABLE test_request_queue ADD COLUMN source_run_id TEXT;
      ALTER TABLE test_request_queue ADD COLUMN retest_key TEXT;
      CREATE UNIQUE INDEX test_request_retest_key ON test_request_queue(project_id, retest_key) WHERE retest_key IS NOT NULL;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(RUN_FOLLOWUP_VERSION, new Date().toISOString());
  })();
}
