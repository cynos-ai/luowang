import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const runActivityMigration: Migration = {
  version: '0008_run_activity',
  apply(database: Database.Database) {
    const columns = database.prepare(`PRAGMA table_info(run_store_runs)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('scenario_progress_json')) {
      database.exec(
        `ALTER TABLE run_store_runs ADD COLUMN scenario_progress_json TEXT NOT NULL DEFAULT 'null'`,
      );
    }
    if (!names.has('activities_json')) {
      database.exec(
        `ALTER TABLE run_store_runs ADD COLUMN activities_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
  },
};
