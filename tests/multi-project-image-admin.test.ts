import { strict as assert } from 'node:assert';

import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { registerProjectAdminRoutes } from '../src/server/projects/admin-routes.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { createProjectImageAdminService } from '../src/server/projects/image-admin.js';
import { ProjectImagePreparationError } from '../src/server/projects/image-preparation.js';
import { BUILTIN_IMAGE_DEFINITION } from '../src/server/projects/image-source.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createProjectReadinessService } from '../src/server/projects/readiness.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

const COMMIT = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const cookie = { cookie: 'luowang_session=valid' };

it('prepares only the authenticated project image at the resolved fixed commit', async () => {
  const database = new Database(':memory:');
  const app = Fastify();
  try {
    database.pragma('foreign_keys = ON');
    runMigrations(database);
    ensureSystemMetadata(database, { appVersion: 'test' });
    runMigrations(database, [projectIdentityMigration]);
    migrateLegacyRunOwnership(database, null);
    migrateLegacyConfigurationOwnership(database, null);
    migrateProjectQueueContext(database);
    migrateProjectImageState(database);
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
    configuration.update(a.projectId, {});
    configuration.update(b.projectId, {});
    const secrets = createScopedSecretStore(database, 'test-master');
    secrets.project(a.projectId).set('gitToken', 'token-a');
    const deployment = createDeploymentConfigurationStore(database, {
      repoDir: '/repos',
      reportDir: '/reports',
    });
    const branches: string[] = [];
    let identityMatches = true;
    let branchUnavailable = false;
    let dockerUnavailable = false;
    let builds = 0;
    let fetches = 0;
    const images = createProjectImageAdminService({
      database,
      projects,
      configuration,
      secrets,
      repoRoot: '/repos',
      storageRoot: '/storage',
      github: (project, token) => ({
        verifyIdentity: async () => {
          assert.equal(token, `token-${project.repositoryName}`);
          return {
            githubRepositoryId: identityMatches ? project.githubRepositoryId : '999',
            owner: project.repositoryOwner,
            name: project.repositoryName,
          };
        },
        readRepository: async () => ({
          fullName: 'example/a',
          defaultBranch: 'main',
          private: false,
          hasIssues: true,
          oauthScopes: [],
          permissions: { push: true },
        }),
      }),
      branchHead: async (projectId, branch) => {
        assert.equal(projectId, a.projectId);
        if (branchUnavailable) throw new Error('network down');
        branches.push(branch);
        return branch === 'main' ? COMMIT : null;
      },
      fetchRepository: async (repository) => {
        assert.ok(repository.directory.includes(a.projectId));
        fetches += 1;
      },
      ensureImage: async (input) => {
        if (dockerUnavailable) throw new ProjectImagePreparationError('DOCKER_UNAVAILABLE');
        assert.equal(input.projectId, a.projectId);
        assert.equal(input.targetCommit, COMMIT);
        assert.equal(input.storageRoot, '/storage');
        builds += 1;
        const key = {
          projectId: input.projectId,
          targetCommit: input.targetCommit,
          dockerfilePath: BUILTIN_IMAGE_DEFINITION,
        };
        if (!input.state.get(key)) {
          input.state.begin(key);
          input.state.ready(key, IMAGE);
        }
        return { imageId: IMAGE, buildDefinition: BUILTIN_IMAGE_DEFINITION, reused: builds > 1 };
      },
    });
    const readiness = createProjectReadinessService({
      database,
      projects,
      configuration,
      secrets,
      dependencies: {
        verifyRepository: async (project) => ({
          githubRepositoryId: project.githubRepositoryId,
          owner: project.repositoryOwner,
          name: project.repositoryName,
        }),
        checkDeployment: async () => ({ id: 'deployment', status: 'ok', message: 'ok' }),
        checkEnvironment: async () => ({ id: 'environment', status: 'ok', message: 'ok' }),
        checkImage: async () => ({ id: 'image', status: 'ok', message: 'ok' }),
      },
    });
    await app.register(fastifyCookie);
    await registerProjectAdminRoutes(app, {
      database,
      deployment,
      projects,
      configuration,
      secrets,
      readiness,
      images,
      auth: {
        isConfigured: () => true,
        authenticate: (token) => token === 'valid',
        login: async () => null,
        logout: () => {},
        changePassword: async () => false,
        revokeAll: () => {},
      },
    });
    const url = `/api/projects/${a.projectId}/image/prepare`;
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...cookie, origin: 'https://other.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: cookie,
          payload: { targetCommit: 'evil' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${b.projectId}/image/prepare`,
          headers: cookie,
        })
      ).statusCode,
      409,
    );
    identityMatches = false;
    assert.equal((await app.inject({ method: 'POST', url, headers: cookie })).statusCode, 409);
    identityMatches = true;
    branchUnavailable = true;
    assert.equal((await app.inject({ method: 'POST', url, headers: cookie })).statusCode, 503);
    branchUnavailable = false;
    dockerUnavailable = true;
    assert.equal((await app.inject({ method: 'POST', url, headers: cookie })).statusCode, 503);
    dockerUnavailable = false;
    const first = await app.inject({ method: 'POST', url, headers: cookie });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().image.targetCommit, COMMIT);
    assert.equal(first.json().image.imageId, IMAGE);
    assert.equal(first.json().image.reused, false);
    assert.deepEqual(branches.slice(-2), ['scenario-testing', 'main']);
    assert.equal(
      createProjectImageStateStore(database).get({
        projectId: a.projectId,
        targetCommit: COMMIT,
        dockerfilePath: BUILTIN_IMAGE_DEFINITION,
      })?.imageId,
      IMAGE,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url, headers: cookie })).json().image.reused,
      true,
    );
    assert.equal(builds, 2);
    assert.equal(fetches, 3);
    assert.equal(projects.get(a.projectId)?.status, 'paused');
    assert.equal(
      createProjectImageStateStore(database).get({
        projectId: b.projectId,
        targetCommit: COMMIT,
        dockerfilePath: BUILTIN_IMAGE_DEFINITION,
      }),
      null,
    );
  } finally {
    await app.close();
    database.close();
  }
});
