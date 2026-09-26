import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

// Staged for the offline v0.6.0 -> v0.6.1 cutover. Do not register this in
// migrations/index.ts before legacy rows and Secrets have a verified owner.
export const projectIdentityMigration: Migration = {
  version: '0009_project_identity',
  apply(database: Database.Database) {
    database.exec(
      "ALTER TABLE admin_credentials ADD COLUMN display_name TEXT NOT NULL DEFAULT '管理员'",
    );
    database.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
        github_repository_id TEXT NOT NULL UNIQUE,
        repository_owner TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        config_revision INTEGER NOT NULL DEFAULT 1 CHECK (config_revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX projects_repository_name_idx
        ON projects (repository_owner COLLATE NOCASE, repository_name COLLATE NOCASE);
    `);
  },
};
