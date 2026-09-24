import { strict as assert } from 'node:assert';

import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { registerProjectAdminRoutes } from '../src/server/projects/admin-routes.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

const cookie = { cookie: 'luowang_session=valid' };

describe('project administration routes', () => {
  it('requires authentication, verifies identity and keeps project configuration and Secrets scoped', async () => {
    const database = setupDatabase();
    const app = Fastify();
    try {
      await app.register(fastifyCookie);
      const projects = createProjectStore(database);
      const configuration = createProjectConfigurationStore(database);
      const secrets = createScopedSecretStore(database, 'test-master');
      const verifiedTokens: Array<string | undefined> = [];
      await registerProjectAdminRoutes(app, {
        database,
        auth: {
          isConfigured: () => true,
          authenticate: (token) => token === 'valid',
          login: async () => null,
          logout: () => {},
          changePassword: async () => false,
          revokeAll: () => {},
        },
        deployment: createDeploymentConfigurationStore(database, {
          repoDir: '/repos',
          reportDir: '/reports',
        }),
        projects,
        configuration,
        secrets,
        verifyRepository: async (url, token) => {
          verifiedTokens.push(token);
          return {
            githubRepositoryId: url.endsWith('/a') ? '101' : '102',
            owner: 'example',
            name: url.endsWith('/a') ? 'a' : 'b',
          };
        },
      });
      assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects',
            headers: { ...cookie, origin: 'https://other.example' },
            payload: { displayName: 'A', repositoryUrl: 'https://github.com/example/a' },
          })
        ).statusCode,
        403,
      );
      const createdA = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: cookie,
        payload: {
          displayName: 'A',
          repositoryUrl: 'https://github.com/example/a',
          gitToken: 'private-token-a',
        },
      });
      assert.equal(createdA.statusCode, 201);
      assert.ok(!createdA.body.includes('private-token-a'));
      const a = createdA.json().project;
      assert.equal(a.status, 'paused');
      assert.equal(secrets.project(a.projectId).get('gitToken'), 'private-token-a');
      assert.deepEqual(verifiedTokens, ['private-token-a']);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects',
            headers: cookie,
            payload: { displayName: 'Duplicate', repositoryUrl: 'https://github.com/example/a' },
          })
        ).statusCode,
        409,
      );
      const createdB = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: cookie,
        payload: { displayName: 'B', repositoryUrl: 'https://github.com/example/b' },
      });
      assert.equal(createdB.statusCode, 201);
      const b = createdB.json().project;
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/projects', headers: cookie })).json().projects
          .length,
        2,
      );
      const aDetail = await app.inject({
        method: 'GET',
        url: `/api/projects/${a.projectId}`,
        headers: cookie,
      });
      assert.equal(aDetail.json().secrets.gitToken.configured, true);
      assert.ok(!aDetail.body.includes('private-token-a'));
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/projects/${a.projectId}/configuration`,
            headers: cookie,
            payload: { baseUrl: 'https://a.example' },
          })
        ).statusCode,
        200,
      );
      assert.equal(configuration.get(a.projectId).baseUrl, 'https://a.example');
      assert.equal(configuration.get(b.projectId).baseUrl, '');
      database
        .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
        .run(a.projectId);
      createProjectTestRequestQueue(database, a.projectId).enqueue({
        trigger: 'manual',
        request: 'test A',
      });
      const blockedConfig = await app.inject({
        method: 'PUT',
        url: `/api/projects/${a.projectId}/configuration`,
        headers: cookie,
        payload: { baseUrl: 'https://changed.example' },
      });
      assert.equal(blockedConfig.statusCode, 409);
      assert.equal(configuration.get(a.projectId).baseUrl, 'https://a.example');
      const blockedSecret = await app.inject({
        method: 'PUT',
        url: `/api/projects/${a.projectId}/secrets/testPassword`,
        headers: cookie,
        payload: { value: 'new-password-a' },
      });
      assert.equal(blockedSecret.statusCode, 409);
      const allowedSecret = await app.inject({
        method: 'PUT',
        url: `/api/projects/${b.projectId}/secrets/testPassword`,
        headers: cookie,
        payload: { value: 'password-b' },
      });
      assert.equal(allowedSecret.statusCode, 200);
      assert.ok(!allowedSecret.body.includes('password-b'));
      assert.equal(secrets.project(b.projectId).get('testPassword'), 'password-b');
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/projects/${b.projectId}/secrets/providerApiKey`,
            headers: cookie,
            payload: { value: 'wrong-scope' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/projects/missing',
            headers: cookie,
          })
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
      database.close();
    }
  });

  it('rolls back project creation if credential storage is unavailable', async () => {
    const database = setupDatabase();
    const app = Fastify();
    try {
      await app.register(fastifyCookie);
      const projects = createProjectStore(database);
      await registerProjectAdminRoutes(app, {
        database,
        auth: {
          isConfigured: () => true,
          authenticate: (token) => token === 'valid',
          login: async () => null,
          logout: () => {},
          changePassword: async () => false,
          revokeAll: () => {},
        },
        deployment: createDeploymentConfigurationStore(database, {
          repoDir: '/repos',
          reportDir: '/reports',
        }),
        projects,
        configuration: createProjectConfigurationStore(database),
        secrets: createScopedSecretStore(database, undefined),
        verifyRepository: async () => ({ githubRepositoryId: '101', owner: 'example', name: 'a' }),
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: cookie,
        payload: {
          displayName: 'A',
          repositoryUrl: 'https://github.com/example/a',
          gitToken: 'private-token-a',
        },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(projects.list(), []);
    } finally {
      await app.close();
      database.close();
    }
  });
});

function setupDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  return database;
}
