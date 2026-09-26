import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateLegacySecretOwnership } from '../src/server/db/migrations/0013-project-secret-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';

describe('staged multi-project cutover transaction', () => {
  it('rolls back identity, index, Run, config, and Secret changes together', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run('repository', '{"repository":"https://github.com/example/old"}', '2026-01-01');
      createSecretStore(database, 'correct-master').set('gitToken', 'token-value');
      const oldCiphertext = database
        .prepare("SELECT * FROM secret_entries WHERE key = 'gitToken'")
        .get();
      const cutover = (masterKey: string) =>
        database.transaction(() => {
          runMigrations(database, [projectIdentityMigration]);
          const project = createProjectStore(database).createVerified({
            displayName: 'Old project',
            repository: { githubRepositoryId: '101', owner: 'example', name: 'old' },
          });
          migrateLegacyIndexOwnership(database, project.projectId);
          migrateLegacyRunOwnership(database, project.projectId);
          migrateLegacyConfigurationOwnership(database, project.projectId);
          migrateLegacySecretOwnership(database, masterKey, project.projectId);
          return project.projectId;
        })();

      assert.throws(() => cutover('wrong-master'), /decrypt/);
      assert.equal(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get(),
        undefined,
      );
      assert.equal(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'project_config'").get(),
        undefined,
      );
      assert.deepEqual(
        database.prepare("SELECT * FROM secret_entries WHERE key = 'gitToken'").get(),
        oldCiphertext,
      );
      assert.ok(database.prepare("SELECT 1 FROM app_config WHERE key = 'repository'").get());
      assert.equal(
        database
          .prepare("SELECT 1 FROM schema_migrations WHERE version = '0009_project_identity'")
          .get(),
        undefined,
      );

      const projectId = cutover('correct-master');
      assert.equal(
        createScopedSecretStore(database, 'correct-master').project(projectId).get('gitToken'),
        'token-value',
      );
      assert.equal(
        database.prepare("SELECT 1 FROM app_config WHERE key = 'repository'").get(),
        undefined,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});
