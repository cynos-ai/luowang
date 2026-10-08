import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateConnectionResources } from '../src/server/db/migrations/0021-connection-resources.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { BUILTIN_IMAGE_DEFINITION } from '../src/server/projects/image-source.js';
import { createLocationImageStateStore } from '../src/server/projects/execution-image-cache.js';
import { createLiveProjectReadinessAdapters } from '../src/server/projects/readiness-adapters.js';
import { createProjectReadinessService } from '../src/server/projects/readiness.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import type { ExecutionAdapter } from '../src/server/projects/execution-adapter.js';

describe('live project readiness adapters', () => {
  it('inspects the cached image on its selected SSH daemon and closes that adapter', async () => {
    const database = setup();
    try {
      const project = createProjectStore(database).createVerified({
        displayName: 'remote',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'remote' },
      });
      const server = '22222222-2222-4222-8222-222222222222';
      database
        .prepare(
          `INSERT INTO execution_servers(server_id,name,host,port,username,auth_type,created_at,updated_at,revision,capacity,health_status,capabilities_json)
        VALUES(?, 'remote','test.example',22,'test','password', '', '',1,1,'ready',?)`,
        )
        .run(server, JSON.stringify({ platform: 'linux/amd64' }));
      database
        .prepare(
          'INSERT INTO project_resource_bindings(project_id,execution_server_id,updated_at) VALUES(?,?,?)',
        )
        .run(project.projectId, server, '');
      const secrets = createScopedSecretStore(database, 'synthetic-key');
      secrets.project(project.projectId).set('gitToken', 'synthetic-token');
      const commit = 'a'.repeat(40),
        imageId = 'sha256:' + 'b'.repeat(64);
      const key = {
        projectId: project.projectId,
        targetCommit: commit,
        dockerfilePath: BUILTIN_IMAGE_DEFINITION,
      };
      const state = createLocationImageStateStore(database, {
        executionLocationId: `server:${server}`,
        executionLocationRevision: 1,
        platform: 'linux/amd64',
      });
      state.begin(key);
      state.ready(key, imageId);
      let inspected = 0,
        closed = 0;
      const dependencies = createLiveProjectReadinessAdapters({
        database,
        secrets,
        configuration: createProjectConfigurationStore(database),
        deployment: createConfigurationStore(database, {
          repoDir: '/repos',
          reportDir: '/reports',
        }),
        repoRoot: '/repos',
        branchHead: async () => commit,
        github: () => ({
          verifyIdentity: async () => ({
            githubRepositoryId: '101',
            owner: 'example',
            name: 'remote',
          }),
          readRepository: async () => ({ defaultBranch: 'main' }) as never,
        }),
        executionAdapter: async (input) => {
          assert.equal(input.locationId, `server:${server}`);
          assert.equal(input.revision, 1);
          return {
            locationId: input.locationId,
            async execute(binary: string, args: string[]) {
              assert.equal(binary, 'docker');
              assert.equal(args.at(-1), imageId);
              inspected++;
              return {
                code: 0,
                stderr: '',
                stdout: JSON.stringify({
                  'luowang.project-id': project.projectId,
                  'luowang.target-commit': commit,
                  'luowang.build-definition': BUILTIN_IMAGE_DEFINITION,
                }),
              };
            },
            async close() {
              closed++;
            },
          } as ExecutionAdapter;
        },
      });
      assert.equal(
        (
          await dependencies.checkImage(
            project,
            createProjectConfigurationStore(database).get(project.projectId),
          )
        ).status,
        'ok',
      );
      assert.equal(inspected, 1);
      assert.equal(closed, 1);
    } finally {
      database.close();
    }
  });
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
      configuration.update(a.projectId, {
        runtimeMode: 'external',
        baseUrl: 'https://a.example',
      });
      configuration.update(b.projectId, {
        runtimeMode: 'external',
        baseUrl: 'https://b.example',
      });
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
        checkExecution: async () => true,
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
      const images = createLocationImageStateStore(database, {
        executionLocationId: `local:${
          (
            database.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get() as {
              value: string;
            }
          ).value
        }`,
        executionLocationRevision: 1,
        platform: `${process.platform}/${process.arch}`,
      });
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
  ensureSystemMetadata(database, { appVersion: 'test' });
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  migrateProjectImageState(database);
  migrateConnectionResources(database);
  migrateExecutionRuntime(database);
  return database;
}
