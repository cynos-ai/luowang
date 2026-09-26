import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectRepositoryService } from '../src/server/repository/service.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

describe('project-bound repository service', () => {
  it('uses fixed repository identity and separate clone roots', async () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyConfigurationOwnership(database, null);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const configuration = createProjectConfigurationStore(database);
      const secrets = createScopedSecretStore(database, 'synthetic-master');
      secrets.project(a.projectId).set('gitToken', 'token-a');
      secrets.project(b.projectId).set('gitToken', 'token-b');
      const root = resolve('/tmp/luowang-repositories');
      const serviceA = createProjectRepositoryService(
        database,
        a.projectId,
        configuration,
        secrets,
        root,
      );
      const serviceB = createProjectRepositoryService(
        database,
        b.projectId,
        configuration,
        secrets,
        root,
      );
      assert.equal(serviceA.getRepositoryUrl(), 'https://github.com/example/a');
      assert.equal(serviceB.getRepositoryUrl(), 'https://github.com/example/b');
      assert.equal(
        (await serviceA.getRepository()).directory,
        resolve(root, 'projects', a.projectId, 'repo'),
      );
      assert.equal(
        (await serviceB.getRepository()).directory,
        resolve(root, 'projects', b.projectId, 'repo'),
      );
      assert.notEqual(
        (await serviceA.getRepository()).directory,
        (await serviceB.getRepository()).directory,
      );
      assert.throws(
        () => createProjectRepositoryService(database, 'missing', configuration, secrets, root),
        /项目不存在/,
      );
    } finally {
      database.close();
    }
  });
});
