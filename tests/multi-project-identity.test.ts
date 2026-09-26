import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { createProjectStore, ProjectStoreError } from '../src/server/projects/store.js';

describe('staged project identity', () => {
  it('does not silently migrate an existing single-project database on startup', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/cynos-ai/example"}', '2026-01-01');
      database
        .prepare(
          'INSERT INTO admin_credentials (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)',
        )
        .run('synthetic-hash', '2026-01-01', '2026-01-01');
      database
        .prepare(
          `INSERT INTO indexed_scenarios
             (path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'docs/scenario-testing/scenarios/A.md',
          'A',
          'A',
          '',
          'approved',
          '[]',
          'old',
          'a'.repeat(40),
          '2026-01-01',
        );

      const before = database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
        )
        .get() as { count: number };
      assert.equal(before.count, 0);

      assert.deepEqual(runMigrations(database, [projectIdentityMigration]).applied, [
        '0009_project_identity',
      ]);
      assert.equal(
        (database.prepare('SELECT count(*) AS count FROM projects').get() as { count: number })
          .count,
        0,
      );
      assert.equal(
        (
          database
            .prepare('SELECT content FROM indexed_scenarios WHERE scenario_id = ?')
            .get('A') as { content: string }
        ).content,
        'old',
      );
      assert.equal(
        (
          database.prepare('SELECT value FROM app_config WHERE key = ?').get('repository') as {
            value: string;
          }
        ).value,
        '{"repository":"https://github.com/cynos-ai/example"}',
      );
      assert.deepEqual(
        database.prepare('SELECT password_hash, display_name FROM admin_credentials').get(),
        { password_hash: 'synthetic-hash', display_name: '管理员' },
      );
      assert.deepEqual(runMigrations(database, [projectIdentityMigration]).applied, []);
    } finally {
      database.close();
    }
  });

  it('starts verified projects paused and rejects repository aliases', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      const store = createProjectStore(database);
      const first = store.createVerified({
        displayName: ' Website ',
        repository: { githubRepositoryId: '123', owner: 'Cynos-AI', name: 'Website' },
      });
      assert.equal(first.displayName, 'Website');
      assert.equal(first.status, 'paused');
      assert.equal(first.configRevision, 1);
      assert.equal(store.get(first.projectId)?.githubRepositoryId, '123');

      assert.throws(
        () =>
          store.createVerified({
            displayName: 'Same ID',
            repository: { githubRepositoryId: '123', owner: 'another', name: 'repo' },
          }),
        (error: unknown) =>
          error instanceof ProjectStoreError && error.code === 'PROJECT_ALREADY_EXISTS',
      );
      assert.throws(
        () =>
          store.createVerified({
            displayName: 'Same name',
            repository: { githubRepositoryId: '456', owner: 'cynos-ai', name: 'website' },
          }),
        (error: unknown) =>
          error instanceof ProjectStoreError && error.code === 'PROJECT_ALREADY_EXISTS',
      );
      assert.equal(store.list().length, 1);
    } finally {
      database.close();
    }
  });
});
