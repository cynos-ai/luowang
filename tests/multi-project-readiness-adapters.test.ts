import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { BUILTIN_IMAGE_DEFINITION } from '../src/server/projects/image-source.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createLiveProjectReadinessAdapters } from '../src/server/projects/readiness-adapters.js';
import { createProjectReadinessService } from '../src/server/projects/readiness.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

describe('live project readiness adapters', () => {
  it('uses project-scoped environment and current commit, and rejects absent or mismatched images', async () => {
    const database = setup();
    try {
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
      configuration.update(a.projectId, { baseUrl: 'https://a.example' });
      configuration.update(b.projectId, { baseUrl: 'https://b.example' });
      const secrets = createScopedSecretStore(database, 'test-master');
      secrets.project(a.projectId).set('gitToken', 'token-a');
      secrets.project(b.projectId).set('gitToken', 'token-b');
      const seenUrls: string[] = [];
      const commitA = 'a'.repeat(40);
      const commitB = 'b'.repeat(40);
      let inspectValid = true;
      let deploymentHealthy = true;
      const dependencies = createLiveProjectReadinessAdapters({
        database,
        deployment: createConfigurationStore(database, {
          repoDir: '/tmp/repo',
          reportDir: '/tmp/reports',
        }),
        configuration,
        secrets,
        repoRoot: '/tmp/repo',
        github: (project, token) => ({
          verifyIdentity: async () => {
            assert.equal(token, `token-${project.repositoryName}`);
            return {
              githubRepositoryId: project.githubRepositoryId,
              owner: project.repositoryOwner,
              name: project.repositoryName,
            };
          },
          readRepository: async () => ({
            fullName: `${project.repositoryOwner}/${project.repositoryName}`,
            defaultBranch: 'main',
            private: false,
            hasIssues: true,
            oauthScopes: [],
            permissions: { push: true },
          }),
        }),
        branchHead: async (id, branch) =>
          branch === 'main' ? (id === a.projectId ? commitA : commitB) : null,
        fetch: async (url) => {
          seenUrls.push(String(url));
          return new Response('', { status: String(url).includes('b.example') ? 503 : 200 });
        },
        checkProvider: async () => deploymentHealthy,
        checkBrowser: async () => true,
        checkOss: async () => true,
        inspectImage: async (key) =>
          inspectValid && key.projectId === a.projectId && key.targetCommit === commitA,
      });
      const readiness = createProjectReadinessService({
        database,
        projects,
        configuration,
        secrets,
        dependencies,
      });
      assert.equal(
        (await readiness.check(a.projectId)).checks.find((check) => check.id === 'image')?.status,
        'not_configured',
      );
      const images = createProjectImageStateStore(database);
      const key = {
        projectId: a.projectId,
        targetCommit: commitA,
        dockerfilePath: BUILTIN_IMAGE_DEFINITION,
      };
      images.begin(key);
      images.ready(key, `sha256:${'c'.repeat(64)}`);
      assert.equal((await readiness.check(a.projectId)).ready, true);
      assert.equal((await readiness.check(b.projectId)).ready, false);
      assert.ok(seenUrls.includes('https://a.example/'));
      assert.ok(seenUrls.includes('https://b.example/'));
      inspectValid = false;
      assert.equal(
        (await readiness.check(a.projectId)).checks.find((check) => check.id === 'image')?.status,
        'failed',
      );
      inspectValid = true;
      deploymentHealthy = false;
      assert.equal((await readiness.resume(a.projectId)).project.status, 'paused');
    } finally {
      database.close();
    }
  });
});

function setup(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  migrateProjectImageState(database);
  return database;
}
