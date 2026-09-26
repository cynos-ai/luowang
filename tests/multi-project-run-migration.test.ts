import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createTestRequestQueue } from '../src/server/automation/queue.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createRunStore } from '../src/server/runs/store.js';

describe('offline Run and request ownership migration', () => {
  it('assigns legacy Run, queue, interruption, and progress to one paused project', () => {
    const database = makeDatabase();
    try {
      seedLegacyRuns(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      assert.equal(migrateLegacyRunOwnership(database, a.projectId), true);
      assert.equal(migrateLegacyRunOwnership(database, a.projectId), false);
      assert.throws(() => migrateLegacyRunOwnership(database, b.projectId), /归属.*不一致/);
      assert.equal(
        (database.prepare('SELECT project_id FROM run_store_runs').get() as { project_id: string })
          .project_id,
        a.projectId,
      );
      assert.equal(
        (
          database.prepare('SELECT project_id FROM test_request_queue').get() as {
            project_id: string;
          }
        ).project_id,
        a.projectId,
      );
      assert.equal(
        (
          database.prepare('SELECT project_id FROM interrupted_run_records').get() as {
            project_id: string;
          }
        ).project_id,
        a.projectId,
      );
      assert.deepEqual(
        database.prepare('SELECT project_id, last_completed_target FROM run_store_progress').get(),
        { project_id: a.projectId, last_completed_target: 'a'.repeat(40) },
      );
      assert.equal(
        (database.prepare('SELECT content FROM run_store_artifacts').get() as { content: string })
          .content,
        'legacy-report',
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() =>
        database
          .prepare('UPDATE run_store_runs SET project_id = ? WHERE run_id = ?')
          .run(b.projectId, 'legacy-run'),
      );
      assert.throws(() =>
        createTestRequestQueue(database).enqueue({ request: 'new', trigger: 'manual' }),
      );
    } finally {
      database.close();
    }
  });

  it('leaves legacy tables unchanged for a nonexistent owner', () => {
    const database = makeDatabase();
    try {
      seedLegacyRuns(database);
      assert.throws(
        () => migrateLegacyRunOwnership(database, '11111111-1111-4111-8111-111111111111'),
        /项目不存在/,
      );
      const columns = database.prepare('PRAGMA table_info(run_store_runs)').all() as Array<{
        name: string;
      }>;
      assert.equal(
        columns.some((column) => column.name === 'project_id'),
        false,
      );
      assert.equal(createRunStore(database).get('legacy-run')?.targetCommit, 'a'.repeat(40));
    } finally {
      database.close();
    }
  });
});

function makeDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  return database;
}

function seedLegacyRuns(database: Database.Database): void {
  createRunStore(database).importCompleted({
    runId: 'legacy-run',
    trigger: 'manual',
    request: 'synthetic',
    baseCommit: null,
    targetCommit: 'a'.repeat(40),
    includedCommits: [],
    result: 'passed',
    startedAt: '2026-01-01',
    finishedAt: '2026-01-01',
    completedDirectory: '/synthetic/legacy-run',
    artifacts: { 'report.md': 'legacy-report' },
    scenarioResults: [],
    confirmedBugs: [],
  });
  createTestRequestQueue(database).enqueue({ request: 'synthetic', trigger: 'manual' });
  database
    .prepare(
      `INSERT INTO interrupted_run_records
         (run_id, trigger, request, base_commit, target_commit, included_commits_json,
          started_at, interrupted_at, running_directory, artifact_names_json,
          error_message, created_at, updated_at)
       VALUES ('interrupted-run', 'manual', 'synthetic', NULL, ?, '[]', ?, ?,
               '/synthetic/interrupted-run', '[]', 'synthetic interruption', ?, ?)`,
    )
    .run('a'.repeat(40), '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01');
  database
    .prepare(
      'INSERT INTO run_store_progress (id, last_completed_target, run_id, updated_at) VALUES (1, ?, ?, ?)',
    )
    .run('a'.repeat(40), 'legacy-run', '2026-01-01');
}
