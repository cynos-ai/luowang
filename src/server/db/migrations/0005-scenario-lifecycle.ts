import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const scenarioLifecycleMigration: Migration = {
  version: '0005_scenario_lifecycle',
  apply(database: Database.Database) {
    addColumn(database, 'run_store_runs', 'scenario_mode', "TEXT NOT NULL DEFAULT 'review-all'");
    addColumn(
      database,
      'run_store_runs',
      'scenario_status',
      "TEXT NOT NULL DEFAULT 'not_applicable'",
    );
    addColumn(database, 'run_store_runs', 'scenario_commit_sha', 'TEXT');
    addColumn(database, 'run_store_runs', 'scenario_pr_url', 'TEXT');
    addColumn(database, 'run_store_runs', 'scenario_error', 'TEXT');
    addColumn(database, 'run_store_runs', 'initialization', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(database, 'test_request_queue', 'initialization', 'INTEGER NOT NULL DEFAULT 0');
  },
};

function addColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
