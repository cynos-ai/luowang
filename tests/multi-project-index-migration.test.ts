import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateProjectReportIndexIdentity } from '../src/server/db/migrations/0017-project-report-index-identity.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('offline project index ownership migration', () => {
  it('preserves old index facts and allows equal scenario IDs and paths in another project', () => {
    const database = makeDatabase();
    try {
      seedLegacyIndex(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      assert.equal(migrateLegacyIndexOwnership(database, a.projectId), true);
      assert.equal(migrateLegacyIndexOwnership(database, a.projectId), false);
      assert.throws(() => migrateLegacyIndexOwnership(database, b.projectId), /归属.*不一致/);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(
        database.prepare('SELECT project_id, content FROM indexed_scenarios').all(),
        [{ project_id: a.projectId, content: 'legacy-scenario' }],
      );
      assert.deepEqual(database.prepare('SELECT project_id, content FROM indexed_reports').all(), [
        { project_id: a.projectId, content: 'legacy-report' },
      ]);
      assert.equal(
        (
          database.prepare('SELECT project_id FROM repository_index_state').get() as {
            project_id: string;
          }
        ).project_id,
        a.projectId,
      );
      assert.equal(
        (
          database.prepare('SELECT project_id FROM repository_index_errors').get() as {
            project_id: string;
          }
        ).project_id,
        a.projectId,
      );

      database
        .prepare(
          `INSERT INTO indexed_scenarios
             (project_id, path, scenario_id, name, description, status, tags_json,
              content, commit_sha, indexed_at)
           SELECT ?, path, scenario_id, name, description, status, tags_json,
                  'other-scenario', commit_sha, indexed_at
           FROM indexed_scenarios WHERE project_id = ?`,
        )
        .run(b.projectId, a.projectId);
      database
        .prepare(
          `INSERT INTO indexed_reports
             (run_id, project_id, path, trigger, base_commit, target_commit,
              included_commits_json, result, started_at, finished_at,
              scenario_results_json, confirmed_bugs_json, files_json,
              content, commit_sha, indexed_at)
           SELECT 'run-b', ?, path, trigger, base_commit, target_commit,
                  included_commits_json, result, started_at, finished_at,
                  scenario_results_json, confirmed_bugs_json, files_json,
                  'other-report', commit_sha, indexed_at
           FROM indexed_reports WHERE project_id = ?`,
        )
        .run(b.projectId, a.projectId);
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM indexed_scenarios').get() as {
            count: number;
          }
        ).count,
        2,
      );
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM indexed_reports').get() as {
            count: number;
          }
        ).count,
        2,
      );
      assert.throws(() =>
        database
          .prepare(
            `INSERT INTO indexed_scenarios
               (project_id, path, scenario_id, name, description, status, tags_json,
                content, commit_sha, indexed_at)
             VALUES (?, 'other.md', 'SHARED', 'A', '', 'approved', '[]', 'duplicate', ?, ?)`,
          )
          .run(a.projectId, 'a'.repeat(40), '2026-01-01'),
      );
    } finally {
      database.close();
    }
  });

  it('preserves indexed reports while allowing an equal historical Run ID in another project', () => {
    const database = makeDatabase();
    try {
      seedLegacyIndex(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '301', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '302', owner: 'example', name: 'b' },
      });
      migrateLegacyIndexOwnership(database, a.projectId);
      assert.equal(migrateProjectReportIndexIdentity(database), true);
      assert.equal(migrateProjectReportIndexIdentity(database), false);
      database
        .prepare(
          `INSERT INTO indexed_reports
             (project_id, run_id, path, trigger, base_commit, target_commit,
              included_commits_json, result, started_at, finished_at,
              scenario_results_json, confirmed_bugs_json, files_json, content,
              commit_sha, indexed_at)
           SELECT ?, run_id, path, trigger, base_commit, target_commit,
                  included_commits_json, result, started_at, finished_at,
                  scenario_results_json, confirmed_bugs_json, files_json,
                  'other-project-report', commit_sha, indexed_at
           FROM indexed_reports WHERE project_id = ?`,
        )
        .run(b.projectId, a.projectId);
      assert.deepEqual(
        database
          .prepare('SELECT project_id, content FROM indexed_reports ORDER BY project_id')
          .all(),
        [
          { project_id: a.projectId, content: 'legacy-report' },
          { project_id: b.projectId, content: 'other-project-report' },
        ].sort((left, right) => left.project_id.localeCompare(right.project_id)),
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });

  it('rolls back when the chosen owner does not exist', () => {
    const database = makeDatabase();
    try {
      seedLegacyIndex(database);
      assert.throws(
        () => migrateLegacyIndexOwnership(database, '11111111-1111-4111-8111-111111111111'),
        /项目不存在/,
      );
      const columns = database.prepare('PRAGMA table_info(indexed_scenarios)').all() as Array<{
        name: string;
      }>;
      assert.equal(
        columns.some((column) => column.name === 'project_id'),
        false,
      );
      assert.equal(
        (database.prepare('SELECT content FROM indexed_scenarios').get() as { content: string })
          .content,
        'legacy-scenario',
      );
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

function seedLegacyIndex(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO repository_index_state
         (id, repository, scenario_branch, commit_sha, synced_at)
       VALUES (1, 'https://github.com/example/a', 'scenario-testing', ?, ?)`,
    )
    .run('a'.repeat(40), '2026-01-01');
  database
    .prepare(
      `INSERT INTO indexed_scenarios
         (path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
       VALUES ('shared.md', 'SHARED', 'Shared', '', 'approved', '[]', 'legacy-scenario', ?, ?)`,
    )
    .run('a'.repeat(40), '2026-01-01');
  database
    .prepare(
      `INSERT INTO indexed_reports
         (run_id, path, trigger, base_commit, target_commit, included_commits_json,
          result, started_at, finished_at, scenario_results_json, confirmed_bugs_json,
          files_json, content, commit_sha, indexed_at)
       VALUES ('run-a', 'shared/report', 'manual', NULL, ?, '[]', 'passed', ?, ?,
               '[]', '[]', '[]', 'legacy-report', ?, ?)`,
    )
    .run('a'.repeat(40), '2026-01-01', '2026-01-01', 'a'.repeat(40), '2026-01-01');
  database
    .prepare(
      `INSERT INTO repository_index_errors
         (path, message, commit_sha, indexed_at)
       VALUES ('bad.md', 'synthetic-error', ?, ?)`,
    )
    .run('a'.repeat(40), '2026-01-01');
}
