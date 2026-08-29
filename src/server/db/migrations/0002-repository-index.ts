import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const repositoryIndexMigration: Migration = {
  version: '0002_repository_index',
  apply(database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS repository_index_state (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        repository TEXT NOT NULL,
        scenario_branch TEXT NOT NULL,
        commit_sha TEXT,
        synced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS indexed_scenarios (
        path TEXT PRIMARY KEY NOT NULL,
        scenario_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        content TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS indexed_reports (
        run_id TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL UNIQUE,
        trigger TEXT NOT NULL,
        base_commit TEXT,
        target_commit TEXT NOT NULL,
        included_commits_json TEXT NOT NULL,
        result TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        scenario_results_json TEXT NOT NULL,
        confirmed_bugs_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        content TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repository_index_errors (
        path TEXT PRIMARY KEY NOT NULL,
        message TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
    `);
  },
};
