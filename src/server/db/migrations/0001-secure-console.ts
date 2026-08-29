import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

export const secureConsoleMigration: Migration = {
  version: '0001_secure_console',
  apply(database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
        ON auth_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secret_entries (
        key TEXT PRIMARY KEY NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connectivity_check_results (
        check_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        latency_ms INTEGER
      );
    `);
  },
};
