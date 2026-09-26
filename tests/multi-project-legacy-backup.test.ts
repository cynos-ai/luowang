import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { createLegacyBackup, verifyLegacyBackup } from '../src/server/projects/legacy-backup.js';

describe('offline legacy instance backup', () => {
  it('copies a consistent SQLite snapshot and both work trees without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-upgrade-backup-'));
    const databasePath = join(root, 'data', 'luowang.db');
    const repoDir = join(root, 'data', 'repo');
    const reportDir = join(root, 'data', 'report');
    const backupDir = join(root, 'backups', 'snapshot-1');
    await mkdir(repoDir, { recursive: true });
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(repoDir, 'marker.txt'), 'repository-before');
    await writeFile(join(reportDir, 'marker.txt'), 'report-before');
    const database = new Database(databasePath);
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/project"}', '2026-01-01');
      const input = { database, databasePath, repoDir, reportDir, backupDir };
      const manifest = await createLegacyBackup(input);
      assert.equal(manifest.format, 1);
      assert.match(manifest.databaseSha256, /^[0-9a-f]{64}$/);
      assert.equal(manifest.repository?.entries, 1);
      assert.equal(manifest.reports?.entries, 1);
      assert.deepEqual(await verifyLegacyBackup(backupDir), manifest);
      assert.equal(
        await readFile(join(backupDir, 'repo', 'marker.txt'), 'utf8'),
        'repository-before',
      );
      assert.equal(
        await readFile(join(backupDir, 'report', 'marker.txt'), 'utf8'),
        'report-before',
      );
      const copied = new Database(join(backupDir, 'luowang.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        assert.equal(
          (
            copied.prepare("SELECT value FROM app_config WHERE key = 'repository'").get() as {
              value: string;
            }
          ).value,
          '{"repository":"https://github.com/example/project"}',
        );
      } finally {
        copied.close();
      }
      await writeFile(join(repoDir, 'marker.txt'), 'repository-after');
      assert.equal(
        await readFile(join(backupDir, 'repo', 'marker.txt'), 'utf8'),
        'repository-before',
      );
      await writeFile(join(backupDir, 'repo', 'marker.txt'), 'tampered');
      await assert.rejects(() => verifyLegacyBackup(backupDir), /摘要不匹配/);
      await assert.rejects(() => createLegacyBackup(input), /EEXIST/);
      await assert.rejects(
        () => createLegacyBackup({ ...input, backupDir: join(repoDir, 'nested-backup') }),
        /备份目标不能位于/,
      );
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
