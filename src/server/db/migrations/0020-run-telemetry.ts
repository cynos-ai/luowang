import type Database from 'better-sqlite3';
import { migrateRunFollowup } from './0019-run-followup.js';

export const RUN_TELEMETRY_VERSION = '0020_run_telemetry';

export function migrateRunTelemetry(database: Database.Database): void {
  migrateRunFollowup(database);
  if (
    database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(RUN_TELEMETRY_VERSION)
  )
    return;
  database.transaction(() => {
    database.exec('ALTER TABLE run_store_runs ADD COLUMN telemetry_json TEXT');
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(RUN_TELEMETRY_VERSION, new Date().toISOString());
  })();
}
