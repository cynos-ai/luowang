import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const runObservabilityMigration: Migration = {
  version: '0007_run_observability',
  apply(database: Database.Database) {
    const columns = database.prepare(`PRAGMA table_info(run_store_runs)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('evidence_json')) {
      database.exec(
        `ALTER TABLE run_store_runs ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
    if (!names.has('blocking_reasons_json')) {
      database.exec(
        `ALTER TABLE run_store_runs ADD COLUMN blocking_reasons_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
  },
};
