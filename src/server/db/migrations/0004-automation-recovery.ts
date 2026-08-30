import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const automationRecoveryMigration: Migration = {
  version: '0004_automation_recovery',
  apply(database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS test_request_queue (
        queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        trigger TEXT NOT NULL,
        request TEXT NOT NULL,
        target_ref TEXT,
        trigger_sources_json TEXT NOT NULL,
        request_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        claimed_at TEXT,
        waiting_archive_at TEXT,
        completed_at TEXT,
        error_message TEXT,
        archive_status TEXT,
        progressed INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS test_request_queue_status_idx
        ON test_request_queue (status, queue_id);

      CREATE TABLE IF NOT EXISTS automation_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interrupted_run_records (
        run_id TEXT PRIMARY KEY NOT NULL,
        trigger TEXT NOT NULL,
        request TEXT NOT NULL,
        base_commit TEXT,
        target_commit TEXT,
        included_commits_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        interrupted_at TEXT NOT NULL,
        running_directory TEXT,
        artifact_names_json TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
