import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectQueueCoordinator } from '../src/server/automation/project-queue-coordinator.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('global project queue coordinator', () => {
  it('persists round-robin selection and lets B run while A waits for archive', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyRunOwnership(database, null);
      migrateLegacyConfigurationOwnership(database, null);
      migrateProjectQueueContext(database);
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      const projects = createProjectStore(database, {
        id: () => ids.shift()!,
        now: () => '2026-01-01',
      });
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const config = createProjectConfigurationStore(database);
      config.update(a.projectId, {});
      config.update(b.projectId, {});
      database.prepare("UPDATE projects SET status = 'active'").run();
      const queueA = createProjectTestRequestQueue(database, a.projectId);
      const queueB = createProjectTestRequestQueue(database, b.projectId);
      const a1 = queueA.enqueue({ trigger: 'manual', request: 'A1' });
      const a2 = queueA.enqueue({ trigger: 'manual', request: 'A2' });
      const b1 = queueB.enqueue({ trigger: 'manual', request: 'B1' });
      assert.equal(createProjectQueueCoordinator(database).claimNext()?.queueId, a1.queueId);
      const coordinatorAfterRestart = createProjectQueueCoordinator(database);
      assert.equal(coordinatorAfterRestart.claimNext(), null);
      queueA.markWaitingArchive(a1.queueId, '01K00000000000000000000001');
      assert.equal(coordinatorAfterRestart.claimNext()?.queueId, b1.queueId);
      queueB.complete(b1.queueId);
      assert.equal(coordinatorAfterRestart.claimNext(), null);
      queueA.complete(a1.queueId);
      assert.equal(coordinatorAfterRestart.claimNext()?.queueId, a2.queueId);
      queueA.complete(a2.queueId);
      const a3 = queueA.enqueue({ trigger: 'manual', request: 'A3' });
      const b2 = queueB.enqueue({ trigger: 'manual', request: 'B2' });
      assert.equal(coordinatorAfterRestart.claimNext()?.queueId, b2.queueId);
      queueB.complete(b2.queueId);
      assert.equal(coordinatorAfterRestart.claimNext()?.queueId, a3.queueId);
      assert.equal(
        (
          database
            .prepare('SELECT value FROM system_metadata WHERE key = ?')
            .get('last_scheduled_project_id') as { value: string }
        ).value,
        a.projectId,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});
