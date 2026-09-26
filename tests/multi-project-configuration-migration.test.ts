import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('offline project configuration migration', () => {
  it('separates project settings, state, and checks from deployment settings', () => {
    const database = makeDatabase();
    try {
      seedConfiguration(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      assert.equal(migrateLegacyConfigurationOwnership(database, a.projectId), true);
      assert.equal(migrateLegacyConfigurationOwnership(database, a.projectId), false);
      assert.throws(
        () => migrateLegacyConfigurationOwnership(database, b.projectId),
        /归属.*不一致/,
      );
      const projectRow = database
        .prepare('SELECT value FROM project_config WHERE project_id = ?')
        .get(a.projectId) as { value: string };
      assert.deepEqual(JSON.parse(projectRow.value), {
        scenarioBranch: 'scenario-testing',
        baseUrl: 'https://testing.example',
        language: 'en-US',
      });
      assert.equal(
        database.prepare("SELECT value FROM app_config WHERE key = 'repository'").get(),
        undefined,
      );
      assert.equal(
        (
          database.prepare("SELECT value FROM app_config WHERE key = 'harness'").get() as {
            value: string;
          }
        ).value,
        '{"language":"en-US","provider":"synthetic"}',
      );
      assert.deepEqual(
        database.prepare('SELECT project_id, key, value FROM project_automation_state').all(),
        [
          {
            project_id: a.projectId,
            key: 'git-poller.repository',
            value: 'https://github.com/example/a',
          },
        ],
      );
      assert.deepEqual(
        database
          .prepare('SELECT project_id, check_id FROM project_connectivity_check_results')
          .all(),
        [{ project_id: a.projectId, check_id: 'github-repository-read' }],
      );
      assert.deepEqual(database.prepare('SELECT check_id FROM connectivity_check_results').all(), [
        { check_id: 'provider-model' },
      ]);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });

  it('stops before mutation when repository config is malformed', () => {
    const database = makeDatabase();
    try {
      const project = createProjectStore(database).createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{invalid', '2026-01-01');
      assert.throws(
        () => migrateLegacyConfigurationOwnership(database, project.projectId),
        /无法解析/,
      );
      assert.equal(
        (
          database
            .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'project_config'")
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      database.close();
    }
  });

  it('rejects a project belonging to a different repository', () => {
    const database = makeDatabase();
    try {
      seedConfiguration(database);
      const project = createProjectStore(database).createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      assert.throws(
        () => migrateLegacyConfigurationOwnership(database, project.projectId),
        /仓库配置与目标项目身份不一致/,
      );
      assert.equal(
        (
          database
            .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'project_config'")
            .get() as { count: number }
        ).count,
        0,
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

function seedConfiguration(database: Database.Database): void {
  const insert = database.prepare(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)',
  );
  insert.run(
    'repository',
    JSON.stringify({
      repository: 'https://github.com/example/a',
      scenarioBranch: 'scenario-testing',
      baseUrl: 'https://testing.example',
    }),
    '2026-01-01',
  );
  insert.run('harness', '{"language":"en-US","provider":"synthetic"}', '2026-01-01');
  database
    .prepare('INSERT INTO automation_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('git-poller.repository', 'https://github.com/example/a', '2026-01-01');
  const check = database.prepare(
    `INSERT INTO connectivity_check_results
       (check_id, status, message, checked_at, latency_ms)
     VALUES (?, 'ok', 'synthetic', '2026-01-01', 1)`,
  );
  check.run('github-repository-read');
  check.run('provider-model');
}
