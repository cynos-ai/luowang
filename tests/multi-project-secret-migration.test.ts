import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacySecretOwnership } from '../src/server/db/migrations/0013-project-secret-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';

describe('offline Secret ownership migration', () => {
  it('re-encrypts each old Secret into its owner scope without changing plaintext', () => {
    const database = makeDatabase();
    try {
      const projectId = createProject(database);
      const old = createSecretStore(database, 'synthetic-master');
      old.set('providerApiKey', 'provider-value');
      old.set('gitToken', 'git-value');
      old.set('testPassword', 'password-value');
      const before = database
        .prepare('SELECT key, ciphertext FROM secret_entries ORDER BY key')
        .all();
      assert.equal(migrateLegacySecretOwnership(database, 'synthetic-master', projectId), true);
      assert.equal(migrateLegacySecretOwnership(database, 'synthetic-master', projectId), false);
      const scoped = createScopedSecretStore(database, 'synthetic-master');
      assert.equal(scoped.deployment().get('providerApiKey'), 'provider-value');
      assert.equal(scoped.project(projectId).get('gitToken'), 'git-value');
      assert.equal(scoped.project(projectId).get('testPassword'), 'password-value');
      assert.equal(old.get('gitToken'), undefined);
      assert.deepEqual(
        (
          database.prepare('SELECT key FROM secret_entries ORDER BY key').all() as Array<{
            key: string;
          }>
        ).map((row) => row.key),
        [
          'deployment:providerApiKey',
          `project:${projectId}:gitToken`,
          `project:${projectId}:testPassword`,
        ],
      );
      assert.notDeepEqual(
        database.prepare('SELECT key, ciphertext FROM secret_entries ORDER BY key').all(),
        before,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });

  it('leaves old ciphertext untouched with the wrong master key', () => {
    const database = makeDatabase();
    try {
      const projectId = createProject(database);
      createSecretStore(database, 'correct-master').set('gitToken', 'secret-value');
      const before = database.prepare('SELECT * FROM secret_entries').all();
      assert.throws(
        () => migrateLegacySecretOwnership(database, 'wrong-master', projectId),
        /decrypt/,
      );
      assert.deepEqual(database.prepare('SELECT * FROM secret_entries').all(), before);
      assert.equal(
        database
          .prepare(
            "SELECT 1 FROM schema_migrations WHERE version = '0013_project_secret_ownership'",
          )
          .get(),
        undefined,
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

function createProject(database: Database.Database): string {
  return createProjectStore(database).createVerified({
    displayName: 'Old project',
    repository: { githubRepositoryId: '101', owner: 'example', name: 'old' },
  }).projectId;
}
