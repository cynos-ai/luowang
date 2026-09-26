import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('project-bound request queues', () => {
  it('merges only within one project and atomically respects pause and the global Run slot', () => {
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
      config.update(a.projectId, { baseUrl: 'https://a.example' });
      config.update(b.projectId, { baseUrl: 'https://b.example' });
      database.prepare("UPDATE projects SET status = 'active'").run();
      const queueA = createProjectTestRequestQueue(database, a.projectId);
      const queueB = createProjectTestRequestQueue(database, b.projectId);
      const firstA = queueA.enqueue({ trigger: 'git', request: 'change A' });
      const firstB = queueB.enqueue({ trigger: 'git', request: 'change B' });
      const mergedA = queueA.enqueue({ trigger: 'schedule', request: 'scheduled A' });
      assert.equal(mergedA.queueId, firstA.queueId);
      assert.equal(mergedA.requestIds.length, 2);
      assert.equal(queueB.get(firstB.queueId)?.requestIds.length, 1);
      assert.equal(mergedA.projectId, a.projectId);
      assert.equal(mergedA.configRevision, 2);
      assert.equal(mergedA.githubRepositoryId, '101');
      assert.equal(JSON.parse(mergedA.configSnapshotJson!).baseUrl, 'https://a.example');
      assert.throws(
        () => config.update(a.projectId, { baseUrl: 'https://other.example' }),
        /待处理请求/,
      );
      assert.throws(
        () => config.update(a.projectId, { executionDockerfile: 'test/Dockerfile.luowang' }),
        /待处理请求/,
      );
      assert.throws(
        () => config.update(a.projectId, { testDataCleanupUrl: 'https://other.example/cleanup' }),
        /待处理请求/,
      );
      config.update(a.projectId, { pollIntervalSeconds: 600 });
      const nextRevisionA = queueA.enqueue({ trigger: 'git', request: 'after revision' });
      assert.notEqual(nextRevisionA.queueId, firstA.queueId);
      assert.equal(nextRevisionA.configRevision, 3);
      assert.equal(queueA.get(firstB.queueId), null);
      assert.throws(() => queueA.fail(firstB.queueId, 'wrong owner'), /不存在/);

      database
        .prepare("UPDATE projects SET status = 'paused' WHERE project_id = ?")
        .run(a.projectId);
      assert.throws(() => queueA.enqueue({ trigger: 'manual', request: 'new A' }), /已暂停/);
      assert.equal(queueA.claimNext(), null);
      assert.equal(queueB.claimNext()?.queueId, firstB.queueId);
      database
        .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
        .run(a.projectId);
      assert.equal(queueA.claimNext(), null);
      queueB.complete(firstB.queueId);
      assert.equal(queueA.claimNext()?.queueId, firstA.queueId);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});
