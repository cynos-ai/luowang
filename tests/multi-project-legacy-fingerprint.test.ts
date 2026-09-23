import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { fingerprintLegacyDatabase } from '../src/server/projects/legacy-fingerprint.js';

describe('legacy SQLite backup fingerprint', () => {
  it('is stable for equal content and changes when data or schema changes', () => {
    const first = new Database(':memory:');
    const second = new Database(':memory:');
    try {
      runMigrations(first);
      runMigrations(second);
      // Migration timestamps differ, so compare identical data after copying all rows.
      second.prepare('DELETE FROM schema_migrations').run();
      const insert = second.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      );
      for (const row of first
        .prepare('SELECT version, applied_at FROM schema_migrations')
        .all() as Array<{ version: string; applied_at: string }>) {
        insert.run(row.version, row.applied_at);
      }
      assert.equal(fingerprintLegacyDatabase(first), fingerprintLegacyDatabase(second));
      first
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{}', '2026-01-01');
      assert.notEqual(fingerprintLegacyDatabase(first), fingerprintLegacyDatabase(second));
      second
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{}', '2026-01-01');
      assert.equal(fingerprintLegacyDatabase(first), fingerprintLegacyDatabase(second));
      second.exec('CREATE INDEX fingerprint_test_index ON app_config (updated_at)');
      assert.notEqual(fingerprintLegacyDatabase(first), fingerprintLegacyDatabase(second));
    } finally {
      first.close();
      second.close();
    }
  });
});
