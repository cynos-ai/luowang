import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const runArchiveMigration: Migration = {
  version: '0003_run_archive',
  apply(database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS run_store_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        request TEXT NOT NULL,
        base_commit TEXT,
        target_commit TEXT NOT NULL,
        included_commits_json TEXT NOT NULL,
        result TEXT NOT NULL,
        scenario_results_json TEXT NOT NULL,
        confirmed_bugs_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        completed_directory TEXT NOT NULL,
        report_path TEXT NOT NULL,
        report_status TEXT NOT NULL,
        report_commit_sha TEXT,
        archive_status TEXT NOT NULL,
        archive_error TEXT,
        progressed INTEGER NOT NULL DEFAULT 0,
        progressed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS run_store_runs_finished_at_idx
        ON run_store_runs (finished_at DESC);

      CREATE TABLE IF NOT EXISTS run_store_artifacts (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, name),
        FOREIGN KEY (run_id) REFERENCES run_store_runs (run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS run_store_issues (
        run_id TEXT NOT NULL,
        bug_key TEXT NOT NULL,
        title TEXT NOT NULL,
        scenario_ids_json TEXT NOT NULL,
        issue_action TEXT NOT NULL,
        requested_issue_url TEXT,
        status TEXT NOT NULL,
        issue_number INTEGER,
        issue_url TEXT,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, bug_key),
        FOREIGN KEY (run_id) REFERENCES run_store_runs (run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS run_store_issues_status_idx
        ON run_store_issues (status);

      CREATE TABLE IF NOT EXISTS run_store_progress (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        last_completed_target TEXT,
        run_id TEXT,
        updated_at TEXT
      );
    `);
  },
};
