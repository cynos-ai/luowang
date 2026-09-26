import { strict as assert } from 'node:assert';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectTaskRuntime } from '../src/server/projects/task-runtime.js';

describe('claimed project task runtime', () => {
  it('holds the captured project and deployment settings across later edits', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyRunOwnership(database, null);
      migrateLegacyConfigurationOwnership(database, null);
      migrateProjectQueueContext(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const config = createProjectConfigurationStore(database);
      config.update(a.projectId, {
        language: 'en-US',
        baseUrl: 'https://a.example',
        executionDockerfile: 'build/Dockerfile',
      });
      config.update(b.projectId, { language: 'zh-CN', baseUrl: 'https://b.example' });
      database.prepare("UPDATE projects SET status = 'active'").run();
      const queueA = createProjectTestRequestQueue(database, a.projectId);
      const queueB = createProjectTestRequestQueue(database, b.projectId);
      const queuedA = queueA.enqueue({ trigger: 'manual', request: 'test A' });
      queueB.enqueue({ trigger: 'manual', request: 'test B' });
      assert.throws(
        () =>
          createProjectTaskRuntime(
            queuedA,
            projects,
            createConfigurationStore(database, { repoDir: '/repos', reportDir: '/reports' }),
            { repoRoot: '/repos', reportRoot: '/reports' },
          ),
        /尚未认领/,
      );
      const claimedA = queueA.claimNext()!;
      const deployment = createConfigurationStore(database, {
        repoDir: '/repos',
        reportDir: '/reports',
      });
      deployment.updateHarness({ provider: 'first-provider', language: 'deployment' });
      const paths = { repoRoot: '/repos', reportRoot: '/reports' };
      const runtimeA = createProjectTaskRuntime(claimedA, projects, deployment, paths);
      assert.equal(runtimeA.projectId, a.projectId);
      assert.equal(runtimeA.configRevision, claimedA.configRevision);
      assert.equal(runtimeA.executionDockerfile, 'build/Dockerfile');
      assert.equal(
        runtimeA.configuration.getRepository().repository,
        'https://github.com/example/a',
      );
      assert.equal(runtimeA.configuration.getRepository().baseUrl, 'https://a.example');
      assert.equal(runtimeA.configuration.getHarness().language, 'en-US');
      assert.equal(runtimeA.configuration.getHarness().provider, 'first-provider');
      assert.equal(
        runtimeA.configuration.getHarness().local.repoDir,
        join('/repos', 'projects', a.projectId, 'repo'),
      );
      deployment.updateHarness({ provider: 'second-provider' });
      config.update(a.projectId, { pollIntervalSeconds: 600 });
      assert.equal(runtimeA.configuration.getHarness().provider, 'first-provider');
      assert.equal(runtimeA.configuration.getRepository().pollIntervalSeconds, 300);
      assert.throws(() => runtimeA.configuration.updateHarness({ language: 'other' }), /只读/);
      queueA.complete(claimedA.queueId);
      config.update(a.projectId, { baseUrl: 'https://new-a.example' });
      assert.equal(runtimeA.configuration.getRepository().baseUrl, 'https://a.example');

      const claimedB = queueB.claimNext()!;
      const runtimeB = createProjectTaskRuntime(claimedB, projects, deployment, paths);
      assert.equal(runtimeB.configuration.getRepository().baseUrl, 'https://b.example');
      assert.equal(runtimeB.configuration.getHarness().provider, 'second-provider');
      assert.equal(
        runtimeB.configuration.getHarness().local.reportDir,
        join('/reports', 'projects', b.projectId),
      );
      assert.throws(
        () =>
          createProjectTaskRuntime(
            { ...claimedA, githubRepositoryId: b.githubRepositoryId },
            projects,
            deployment,
            paths,
          ),
        /身份无效/,
      );
      assert.throws(
        () =>
          createProjectTaskRuntime(
            {
              ...claimedB,
              configSnapshotJson: JSON.stringify({
                repository: 'https://github.com/example/a',
                language: 'zh-CN',
              }),
            },
            projects,
            deployment,
            paths,
          ),
        /未知字段/,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});
