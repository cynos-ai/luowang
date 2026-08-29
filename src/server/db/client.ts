import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { AppConfig } from '../config.js';
import * as schema from './schema.js';

export type DrizzleDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseContext {
  sqlite: Database.Database;
  db: DrizzleDatabase;
  close: () => void;
  isHealthy: () => boolean;
}

export function openDatabase(
  options: Pick<AppConfig, 'databasePath' | 'dataDir' | 'repoDir' | 'reportDir'>,
): DatabaseContext {
  if (options.databasePath !== ':memory:') {
    mkdirSync(options.dataDir, { recursive: true });
    mkdirSync(dirname(options.databasePath), { recursive: true });
    mkdirSync(options.repoDir, { recursive: true });
    mkdirSync(options.reportDir, { recursive: true });
  }

  const sqlite = new Database(options.databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  let closed = false;
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close() {
      if (!closed) {
        sqlite.close();
        closed = true;
      }
    },
    isHealthy() {
      if (closed) {
        return false;
      }
      try {
        sqlite.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
  };
}
