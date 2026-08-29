import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { openDatabase, type DatabaseContext } from './client.js';
import { migrations, type Migration } from './migrations/index.js';

export interface MigrationResult {
  applied: string[];
}

export function runMigrations(
  database: Database.Database,
  pendingMigrations: Migration[] = migrations,
): MigrationResult {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => String((row as { version: string }).version)),
  );
  const applied: string[] = [];

  for (const migration of pendingMigrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      migration.apply(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    })();
    applied.push(migration.version);
  }

  return { applied };
}

export function ensureSystemMetadata(
  database: Database.Database,
  options: { appVersion: string; now?: () => string; id?: () => string },
): void {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  const timestamp = now();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO system_metadata (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  insert.run('instance_id', id(), timestamp, timestamp);

  const update = database.prepare(`
    INSERT INTO system_metadata (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  update.run('app_version', options.appVersion, timestamp, timestamp);
  update.run('last_started_at', timestamp, timestamp, timestamp);
}

export function initializeDatabase(config: AppConfig): DatabaseContext {
  const database = openDatabase(config);
  try {
    runMigrations(database.sqlite);
    ensureSystemMetadata(database.sqlite, { appVersion: config.version });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
