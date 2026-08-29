import type Database from 'better-sqlite3';

export interface Migration {
  version: string;
  apply: (database: Database.Database) => void;
}

export const foundationMigration: Migration = {
  version: '0000_foundation',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
