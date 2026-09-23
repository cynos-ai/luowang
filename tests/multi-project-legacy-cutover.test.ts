import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { createLegacyBackup } from '../src/server/projects/legacy-backup.js';
import {
  applyEmptyLegacyCutover,
  applyLegacyProjectCutover,
} from '../src/server/projects/legacy-cutover.js';
import { fingerprintLegacyDatabase } from '../src/server/projects/legacy-fingerprint.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';

const verifiedRepository = { githubRepositoryId: '101', owner: 'example', name: 'old' };

describe('offline legacy project cutover', () => {
  it('keeps a backed-up empty instance at zero projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-cutover-'));
    const databasePath = join(root, 'old.db');
    const backupDir = join(root, 'backup');
    const database = new Database(databasePath);
    try {
      runMigrations(database);
      createSecretStore(database, 'empty-master').set('providerApiKey', 'provider-value');
      await createLegacyBackup({
        database,
        databasePath,
        repoDir: join(root, 'repo'),
        reportDir: join(root, 'reports'),
        backupDir,
      });
      const input = { database, databasePath, backupDir, masterKey: 'empty-master' };
      await applyEmptyLegacyCutover(input);
      await applyEmptyLegacyCutover(input);
      assert.deepEqual(createProjectStore(database).list(), []);
      assert.equal(
        createScopedSecretStore(database, 'empty-master').deployment().get('providerApiKey'),
        'provider-value',
      );
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM project_config').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM run_store_runs').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a matching backup and rolls back bad Secrets before a successful retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-cutover-'));
    const databasePath = join(root, 'old.db');
    const backupDir = join(root, 'backup');
    const database = new Database(databasePath);
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      createSecretStore(database, 'correct-master').set('gitToken', 'old-value');
      await createLegacyBackup({
        database,
        databasePath,
        repoDir: join(root, 'repo'),
        reportDir: join(root, 'reports'),
        backupDir,
      });
      const fingerprint = fingerprintLegacyDatabase(database);
      const input = { database, databasePath, backupDir, verifiedRepository };
      await assert.rejects(
        applyLegacyProjectCutover({ ...input, masterKey: 'wrong-master' }),
        /decrypt/,
      );
      assert.equal(fingerprintLegacyDatabase(database), fingerprint);
      const projectId = await applyLegacyProjectCutover({ ...input, masterKey: 'correct-master' });
      assert.equal(createProjectStore(database).get(projectId)?.status, 'paused');
      assert.equal(
        createScopedSecretStore(database, 'correct-master').project(projectId).get('gitToken'),
        'old-value',
      );
      assert.equal(
        await applyLegacyProjectCutover({ ...input, masterKey: 'correct-master' }),
        projectId,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects source changes made after the backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-cutover-'));
    const databasePath = join(root, 'old.db');
    const backupDir = join(root, 'backup');
    const database = new Database(databasePath);
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      await createLegacyBackup({
        database,
        databasePath,
        repoDir: join(root, 'repo'),
        reportDir: join(root, 'reports'),
        backupDir,
      });
      database
        .prepare('UPDATE app_config SET updated_at = ? WHERE key = ?')
        .run('2026-01-02', 'repository');
      await assert.rejects(
        applyLegacyProjectCutover({
          database,
          databasePath,
          backupDir,
          verifiedRepository,
          masterKey: undefined,
        }),
        /备份内容不一致/,
      );
      assert.equal(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get(),
        undefined,
      );
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires an exact reviewed snapshot before assigning historical progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-cutover-'));
    const databasePath = join(root, 'old.db');
    const backupDir = join(root, 'backup');
    const database = new Database(databasePath);
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      database
        .prepare(
          'INSERT INTO run_store_progress (id, last_completed_target, run_id, updated_at) VALUES (1, ?, NULL, ?)',
        )
        .run('a'.repeat(40), '2026-01-01');
      await createLegacyBackup({
        database,
        databasePath,
        repoDir: join(root, 'repo'),
        reportDir: join(root, 'reports'),
        backupDir,
      });
      const input = { database, databasePath, backupDir, verifiedRepository, masterKey: undefined };
      await assert.rejects(applyLegacyProjectCutover(input), /历史归属尚未人工核对/);
      await assert.rejects(
        applyLegacyProjectCutover({ ...input, reviewedHistoryFingerprint: 'bad' }),
        /历史归属尚未人工核对/,
      );
      const projectId = await applyLegacyProjectCutover({
        ...input,
        reviewedHistoryFingerprint: fingerprintLegacyDatabase(database),
      });
      assert.equal(
        (
          database
            .prepare('SELECT project_id, last_completed_target FROM run_store_progress')
            .get() as { project_id: string; last_completed_target: string }
        ).project_id,
        projectId,
      );
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
