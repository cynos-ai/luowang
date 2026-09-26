import { strict as assert } from 'node:assert';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, it } from 'vitest';

import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db/client.js';
import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { createProjectApp } from '../src/server/projects/app.js';
import { createLegacyBackup, verifyLegacyBackup } from '../src/server/projects/legacy-backup.js';
import {
  applyEmptyLegacyCutover,
  applyLegacyProjectCutover,
} from '../src/server/projects/legacy-cutover.js';
import { fingerprintLegacyDatabase } from '../src/server/projects/legacy-fingerprint.js';
import { assertLegacySchema, assertProjectSchema } from '../src/server/projects/schema-mode.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';
import type { EvidenceReference } from '../src/shared/types.js';

const verifiedRepository = { githubRepositoryId: '101', owner: 'example', name: 'old' };

describe('offline legacy project cutover', () => {
  it('rehearses backup, historical ownership, a second project, rollback and repeat upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-upgrade-rehearsal-'));
    const databasePath = join(root, 'legacy.db');
    const backupDir = join(root, 'backup');
    const repoDir = join(root, 'repository');
    const reportDir = join(root, 'reports');
    const runId = '01K00000000000000000000088';
    const targetCommit = 'a'.repeat(40);
    const evidenceUrl = 'https://oss.example.test/projects/old/runs/88/evidence.png';
    const evidence: EvidenceReference = {
      id: 'legacy-evidence',
      filename: 'evidence.png',
      objectKey: `${runId}/evidence.png`,
      url: evidenceUrl,
      contentType: 'image/png',
      sizeBytes: 12,
      sha256: 'c'.repeat(64),
      uploadedAt: '2026-01-01',
    };
    const reportPath = `docs/scenario-testing/reports/${runId}/report.md`;
    const scenarioPath = 'docs/scenario-testing/scenarios/CHECK-001.md';
    const oldReport = '# Historical report\n';
    const oldScenario =
      '---\nid: CHECK-001\nname: Old\ndescription: Old project\nstatus: approved\ntags: []\n---\n';
    const masterKey = 'rehearsal-only-master';
    let database: Database.Database | undefined = new Database(databasePath);
    try {
      database.pragma('foreign_keys = ON');
      runMigrations(database);
      ensureSystemMetadata(database, { appVersion: '0.6.0' });
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      createSecretStore(database, masterKey).set('gitToken', 'synthetic-git-token');
      createSecretStore(database, masterKey).set('providerApiKey', 'synthetic-provider-key');
      await mkdir(join(repoDir, 'docs'), { recursive: true });
      await mkdir(join(reportDir, 'completed', runId), { recursive: true });
      await writeFile(join(repoDir, 'docs', 'PROJECT.md'), '# Original project\n');
      await writeFile(join(reportDir, 'completed', runId, 'report.md'), oldReport);
      database
        .prepare(
          `INSERT INTO indexed_scenarios
        (path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
        VALUES (?, 'CHECK-001', 'Old', 'Old project', 'approved', '[]', ?, ?, '2026-01-01')`,
        )
        .run(scenarioPath, oldScenario, targetCommit);
      database
        .prepare(
          `INSERT INTO indexed_reports
        (run_id, path, trigger, target_commit, included_commits_json, result,
         started_at, finished_at, scenario_results_json, confirmed_bugs_json, files_json,
         content, commit_sha, indexed_at)
        VALUES (?, ?, 'manual', ?, '[]', 'passed', '2026-01-01', '2026-01-01',
                '[]', '[]', '[]', ?, ?, '2026-01-01')`,
        )
        .run(runId, reportPath, targetCommit, oldReport, targetCommit);
      database
        .prepare(
          `INSERT INTO run_store_runs
        (run_id, status, trigger, request, target_commit, included_commits_json, result,
         scenario_results_json, confirmed_bugs_json, started_at, finished_at,
         completed_directory, report_path, report_status, archive_status,
         evidence_json, created_at, updated_at)
        VALUES (?, 'completed', 'manual', 'historical', ?, '[]', 'passed',
                '[]', '[]', '2026-01-01', '2026-01-01', ?, ?, 'completed',
                'completed', ?, '2026-01-01', '2026-01-01')`,
        )
        .run(
          runId,
          targetCommit,
          join(reportDir, 'completed', runId),
          reportPath,
          JSON.stringify([evidence]),
        );
      database
        .prepare(
          `INSERT INTO run_store_artifacts
        (run_id, name, content, created_at, updated_at) VALUES (?, 'report.md', ?, '2026-01-01', '2026-01-01')`,
        )
        .run(runId, oldReport);
      database
        .prepare(
          `INSERT INTO run_store_progress
        (id, last_completed_target, run_id, updated_at) VALUES (1, ?, ?, '2026-01-01')`,
        )
        .run(targetCommit, runId);
      const legacyFingerprint = fingerprintLegacyDatabase(database);
      const manifest = await createLegacyBackup({
        database,
        databasePath,
        repoDir,
        reportDir,
        backupDir,
      });
      assert.deepEqual(await verifyLegacyBackup(backupDir), manifest);

      const projectId = await applyLegacyProjectCutover({
        database,
        databasePath,
        backupDir,
        masterKey,
        verifiedRepository,
        reviewedHistoryFingerprint: legacyFingerprint,
      });
      assertProjectSchema(database);
      assert.equal(createProjectStore(database).get(projectId)?.status, 'paused');
      assert.equal(
        createScopedSecretStore(database, masterKey).project(projectId).get('gitToken'),
        'synthetic-git-token',
      );
      assert.equal(
        createScopedSecretStore(database, masterKey).deployment().get('providerApiKey'),
        'synthetic-provider-key',
      );
      const migratedRun = database
        .prepare(
          'SELECT project_id, target_commit, evidence_json, completed_directory, report_path FROM run_store_runs WHERE run_id = ?',
        )
        .get(runId) as {
        project_id: string;
        target_commit: string;
        evidence_json: string;
        completed_directory: string;
        report_path: string;
      };
      assert.deepEqual(migratedRun, {
        project_id: projectId,
        target_commit: targetCommit,
        evidence_json: JSON.stringify([evidence]),
        completed_directory: join(reportDir, 'completed', runId),
        report_path: reportPath,
      });
      assert.equal(
        (
          database
            .prepare('SELECT project_id FROM indexed_reports WHERE run_id = ?')
            .get(runId) as { project_id: string }
        ).project_id,
        projectId,
      );
      assert.equal(
        (
          database
            .prepare('SELECT content FROM run_store_artifacts WHERE run_id = ? AND name = ?')
            .get(runId, 'report.md') as { content: string }
        ).content,
        oldReport,
      );
      assert.equal(
        (
          database
            .prepare('SELECT last_completed_target FROM run_store_progress WHERE project_id = ?')
            .get(projectId) as { last_completed_target: string }
        ).last_completed_target,
        targetCommit,
      );
      assert.equal(
        await applyLegacyProjectCutover({
          database,
          databasePath,
          backupDir,
          masterKey,
          verifiedRepository,
          reviewedHistoryFingerprint: legacyFingerprint,
        }),
        projectId,
      );

      const second = createProjectStore(database).createVerified({
        displayName: 'Second',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'second' },
      });
      database
        .prepare(
          `INSERT INTO indexed_scenarios
        (project_id, path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
        VALUES (?, ?, 'CHECK-001', 'Second', 'Second project', 'approved', '[]', 'second-content', ?, '2026-01-02')`,
        )
        .run(second.projectId, scenarioPath, 'b'.repeat(40));
      assert.equal(
        (
          database
            .prepare('SELECT count(*) AS count FROM indexed_scenarios WHERE scenario_id = ?')
            .get('CHECK-001') as { count: number }
        ).count,
        2,
      );
      assert.deepEqual(database.pragma('foreign_key_check'), []);
      database.close();
      database = undefined;

      const config = loadConfig({
        NODE_ENV: 'test',
        LUOWANG_DATA_DIR: root,
        LUOWANG_DATABASE_PATH: databasePath,
        LUOWANG_REPO_DIR: repoDir,
        LUOWANG_REPORT_DIR: reportDir,
        LUOWANG_ADMIN_PASSWORD: 'rehearsal-admin-password',
        LUOWANG_MASTER_KEY: masterKey,
      });
      const appDatabase = openDatabase(config);
      try {
        const app = await createProjectApp({
          config,
          database: appDatabase,
          logger: pino({ level: 'silent' }),
          backgroundTasks: false,
        });
        try {
          const login = await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { password: 'rehearsal-admin-password' },
          });
          assert.equal(login.statusCode, 200);
          const cookie = login.headers['set-cookie']?.toString().split(';')[0];
          assert.ok(cookie);
          const headers = { cookie };
          const owned = await app.inject({
            method: 'GET',
            url: `/api/projects/${projectId}/runs/${runId}`,
            headers,
          });
          assert.equal(owned.statusCode, 200);
          assert.equal(owned.json().run.targetCommit, targetCommit);
          assert.deepEqual(owned.json().run.evidence, [evidence]);
          assert.equal(
            (
              await app.inject({
                method: 'GET',
                url: `/api/projects/${second.projectId}/runs/${runId}`,
                headers,
              })
            ).statusCode,
            404,
          );
        } finally {
          await app.close();
        }
      } finally {
        appDatabase.close();
      }

      // Roll back all three matching artifacts together, never the migrated DB alone.
      await copyFile(join(backupDir, 'luowang.db'), databasePath);
      await rm(repoDir, { recursive: true });
      await rm(reportDir, { recursive: true });
      await cp(join(backupDir, 'repo'), repoDir, { recursive: true });
      await cp(join(backupDir, 'report'), reportDir, { recursive: true });
      database = new Database(databasePath, { fileMustExist: true });
      database.pragma('foreign_keys = ON');
      assertLegacySchema(database);
      assert.equal(fingerprintLegacyDatabase(database), legacyFingerprint);
      assert.equal(
        await readFile(join(repoDir, 'docs', 'PROJECT.md'), 'utf8'),
        '# Original project\n',
      );
      assert.equal(
        await readFile(join(reportDir, 'completed', runId, 'report.md'), 'utf8'),
        oldReport,
      );
      assert.equal(createSecretStore(database, masterKey).get('gitToken'), 'synthetic-git-token');
      assert.equal(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get(),
        undefined,
      );
      const repeatedProjectId = await applyLegacyProjectCutover({
        database,
        databasePath,
        backupDir,
        masterKey,
        verifiedRepository,
        reviewedHistoryFingerprint: legacyFingerprint,
      });
      assert.equal(createProjectStore(database).get(repeatedProjectId)?.status, 'paused');
      assert.deepEqual(database.pragma('foreign_key_check'), []);
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
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
      database
        .prepare(
          `INSERT INTO test_request_queue
           (request_id, trigger, request, trigger_sources_json, request_ids_json,
            status, request_kind, created_at, updated_at)
           VALUES (?, 'manual', 'historical request', '["manual"]', '["old-request"]',
                   'queued', 'manual-current-head', '2026-01-01', '2026-01-01')`,
        )
        .run('old-request');
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
      const queued = database
        .prepare(
          'SELECT project_id, config_revision, github_repository_id, config_snapshot_json FROM test_request_queue',
        )
        .get() as {
        project_id: string;
        config_revision: number;
        github_repository_id: string;
        config_snapshot_json: string;
      };
      assert.equal(queued.project_id, projectId);
      assert.equal(queued.config_revision, 1);
      assert.equal(queued.github_repository_id, '101');
      assert.equal(typeof JSON.parse(queued.config_snapshot_json), 'object');
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
