import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, it, vi } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { runUpgradeCli } from '../src/server/projects/upgrade-cli.js';
import { assertLegacySchema, assertProjectSchema } from '../src/server/projects/schema-mode.js';

afterEach(() => vi.unstubAllGlobals());

describe('offline multi-project upgrade command', () => {
  it('backs up an empty file database, upgrades it and blocks the legacy service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-upgrade-cli-'));
    const databasePath = join(root, 'luowang.db');
    const database = new Database(databasePath);
    const environment = { LUOWANG_DATA_DIR: root, LUOWANG_DATABASE_PATH: databasePath };
    try {
      runMigrations(database);
      assert.equal((await runUpgradeCli(['inspect'], environment)).status, 'empty');
      const backupDir = join(root, 'backup');
      assert.equal((await runUpgradeCli(['backup', backupDir], environment)).status, 'backed_up');
      assert.equal(
        (await runUpgradeCli(['upgrade-empty', backupDir], environment)).status,
        'complete',
      );
      assert.deepEqual(await runUpgradeCli(['verify'], environment), {
        status: 'complete',
        projects: 0,
      });
      assert.equal(
        (await runUpgradeCli(['upgrade-empty', backupDir], environment)).status,
        'already_complete',
      );
      assert.throws(() => assertLegacySchema(database), /旧单项目服务拒绝启动/);
      assert.doesNotThrow(() => assertProjectSchema(database));
      await assert.rejects(runUpgradeCli(['inspect'], environment), /旧单项目服务拒绝启动/);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verifies the repository identity and requires review of the exact historical snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-upgrade-cli-'));
    const databasePath = join(root, 'luowang.db');
    const database = new Database(databasePath);
    const environment = { LUOWANG_DATA_DIR: root, LUOWANG_DATABASE_PATH: databasePath };
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      database
        .prepare(
          'INSERT INTO run_store_progress (id, last_completed_target, updated_at) VALUES (1, ?, ?)',
        )
        .run('a'.repeat(40), '2026-01-01');
      const inspection = await runUpgradeCli(['inspect'], environment);
      assert.equal(inspection.status, 'blocked');
      const backupDir = join(root, 'backup');
      await runUpgradeCli(['backup', backupDir], environment);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ id: 101, full_name: 'example/old' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      await assert.rejects(
        runUpgradeCli(['upgrade-project', backupDir], environment),
        /历史归属尚未人工核对/,
      );
      const result = await runUpgradeCli(
        ['upgrade-project', backupDir, inspection.fingerprint as string],
        environment,
      );
      assert.equal(result.status, 'complete');
      assert.equal((await runUpgradeCli(['verify'], environment)).projects, 1);
      assert.equal(
        (await runUpgradeCli(['upgrade-project', backupDir], environment)).status,
        'already_complete',
      );
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete and unknown migration states', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run('0009_project_identity', '2026-01-01');
      assert.throws(() => assertLegacySchema(database), /旧单项目服务拒绝启动/);
      assert.throws(() => assertProjectSchema(database), /迁移不完整/);
    } finally {
      database.close();
    }
  });
});
