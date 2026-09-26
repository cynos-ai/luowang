import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { GitHubApiError } from '../src/server/repository/github.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { providerReadinessFailure } from '../src/server/projects/readiness-adapters.js';
import {
  createProjectReadinessService,
  type ProjectReadinessDependencies,
  type ReadinessCheck,
} from '../src/server/projects/readiness.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { awaitsCutoverActivation } from '../src/server/projects/cutover-activation.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

describe('project readiness and lifecycle', () => {
  it('uses provider status codes without forwarding gateway response text', () => {
    const gatewayFailure = {
      status: 'failed' as const,
      code: 'AUTHENTICATION_FAILED' as const,
      message: 'private-provider-response-canary',
    };
    assert.equal(
      providerReadinessFailure(gatewayFailure),
      '模型 Provider 认证失败，请检查部署级 API Key',
    );
    assert.doesNotMatch(
      providerReadinessFailure(gatewayFailure),
      /private-provider-response-canary/,
    );
    assert.equal(
      providerReadinessFailure({ status: 'failed', code: 'MODEL_NOT_FOUND' }),
      '模型 Provider 或角色模型不存在，请检查部署级配置',
    );
    assert.equal(
      providerReadinessFailure({ status: 'timeout', code: 'REQUEST_FAILED' }),
      '模型 Provider 检查超时，请检查网络或网关',
    );
  });

  it('fails closed on missing, failing and stale checks before allowing explicit resume', async () => {
    const database = setup();
    try {
      const projects = createProjectStore(database);
      const project = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const config = createProjectConfigurationStore(database);
      database
        .prepare(
          'INSERT INTO system_metadata (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run('v061_legacy_cutover_project_id', project.projectId, 'now', 'now');
      config.update(project.projectId, {});
      const secrets = createScopedSecretStore(database, 'test-master');
      let repositoryId = '101';
      let repositoryFailure = false;
      let deploymentStatus: ReadinessCheck['status'] = 'ok';
      let mutateDuringImageCheck = false;
      let imageChecks = 0;
      const ok = (id: ReadinessCheck['id']): ReadinessCheck => ({
        id,
        status: 'ok',
        message: '已检查',
      });
      const dependencies: ProjectReadinessDependencies = {
        verifyRepository: async () => {
          if (repositoryFailure) throw new GitHubApiError(404, 'private-token-canary');
          return {
            githubRepositoryId: repositoryId,
            owner: 'example',
            name: 'a',
          };
        },
        checkDeployment: async () => ({ ...ok('deployment'), status: deploymentStatus }),
        checkEnvironment: async () => ok('environment'),
        checkImage: async () => {
          imageChecks += 1;
          if (mutateDuringImageCheck) {
            config.update(project.projectId, { pollIntervalSeconds: 600 });
          }
          return ok('image');
        },
      };
      const readiness = createProjectReadinessService({
        database,
        projects,
        configuration: config,
        secrets,
        dependencies,
      });
      const missing = await readiness.resume(project.projectId);
      assert.equal(missing.project.status, 'paused');
      assert.equal(missing.readiness.ready, false);
      assert.equal(
        missing.readiness.checks.find((item) => item.id === 'repository')?.status,
        'not_configured',
      );
      assert.equal(imageChecks, 0);
      secrets.project(project.projectId).set('gitToken', 'token-a');
      config.update(project.projectId, { baseUrl: 'https://a.example' });
      repositoryFailure = true;
      const inaccessible = await readiness.check(project.projectId);
      const repositoryCheck = inaccessible.checks.find((item) => item.id === 'repository');
      assert.equal(repositoryCheck?.status, 'failed');
      assert.match(repositoryCheck?.message ?? '', /不存在，或当前 Token 无权读取/);
      assert.doesNotMatch(JSON.stringify(inaccessible), /private-token-canary/);
      repositoryFailure = false;
      const unreadable = await createProjectReadinessService({
        database,
        projects,
        configuration: config,
        secrets: createScopedSecretStore(database, undefined),
        dependencies,
      }).check(project.projectId);
      assert.equal(unreadable.ready, false);
      assert.equal(unreadable.checks.find((item) => item.id === 'repository')?.status, 'failed');
      repositoryId = 'wrong-id';
      assert.equal((await readiness.resume(project.projectId)).readiness.ready, false);
      assert.equal(projects.get(project.projectId)?.status, 'paused');
      repositoryId = '101';
      deploymentStatus = 'failed';
      assert.equal((await readiness.resume(project.projectId)).readiness.ready, false);
      deploymentStatus = 'ok';
      mutateDuringImageCheck = true;
      const stale = await readiness.resume(project.projectId);
      assert.equal(stale.project.status, 'paused');
      assert.equal(stale.readiness.ready, false);
      assert.ok(stale.readiness.checks.every((item) => item.status === 'needs_recheck'));
      mutateDuringImageCheck = false;
      assert.equal(awaitsCutoverActivation(database, project.projectId), true);
      const active = await readiness.resume(project.projectId);
      assert.equal(active.readiness.ready, true);
      assert.equal(active.project.status, 'active');
      assert.equal(awaitsCutoverActivation(database, project.projectId), false);

      const queue = createProjectTestRequestQueue(database, project.projectId);
      const first = queue.enqueue({ trigger: 'manual', request: 'first' });
      const second = queue.enqueue({ trigger: 'manual', request: 'second' });
      assert.equal(queue.claimNext()?.queueId, first.queueId);
      assert.equal(readiness.pause(project.projectId).status, 'paused');
      assert.equal(awaitsCutoverActivation(database, project.projectId), false);
      assert.equal(queue.get(first.queueId)?.status, 'running');
      assert.equal(queue.get(second.queueId)?.status, 'queued');
      assert.equal(queue.claimNext(), null);
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
