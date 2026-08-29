import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { loadConfig } from '../src/server/config.js';
import { ensureSystemMetadata, initializeDatabase } from '../src/server/db/migrate.js';

describe('SQLite foundation', () => {
  it('runs versioned migrations and preserves system metadata across restarts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-db-'));
    const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: dataDir });

    const first = initializeDatabase(config);
    const firstInstance = first.sqlite
      .prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'")
      .get() as { value: string };
    const migration = first.sqlite
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get('0000_foundation') as { version: string };
    first.close();

    const second = initializeDatabase(config);
    const secondInstance = second.sqlite
      .prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'")
      .get() as { value: string };
    second.close();

    assert.equal(migration.version, '0000_foundation');
    assert.equal(secondInstance.value, firstInstance.value);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('does not overwrite a persisted instance id when metadata is refreshed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-meta-'));
    const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: dataDir });
    const database = initializeDatabase(config);

    ensureSystemMetadata(database.sqlite, {
      appVersion: 'test-version',
      now: () => '2026-01-01T00:00:00.000Z',
      id: () => 'new-id-that-must-not-win',
    });
    const rows = database.sqlite
      .prepare(
        "SELECT key, value FROM system_metadata WHERE key IN ('instance_id', 'app_version') ORDER BY key",
      )
      .all() as Array<{ key: string; value: string }>;
    database.close();

    assert.equal(rows[0]?.key, 'app_version');
    assert.equal(rows[0]?.value, 'test-version');
    assert.equal(rows[1]?.key, 'instance_id');
    assert.notEqual(rows[1]?.value, 'new-id-that-must-not-win');
    await rm(dataDir, { recursive: true, force: true });
  });
});
