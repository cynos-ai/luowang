import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateConnectionResources } from '../src/server/db/migrations/0021-connection-resources.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createProjectStore } from '../src/server/projects/store.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

describe('execution runtime migration', () => {
  it('preserves queued work as immutable local external snapshots and is idempotent', () => {
    const database = new Database(':memory:');
    try {
      database.pragma('foreign_keys = ON');
      runMigrations(database);
      ensureSystemMetadata(database, { appVersion: 'test', id: () => INSTANCE });
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyRunOwnership(database, null);
      migrateLegacyConfigurationOwnership(database, null);
      migrateProjectQueueContext(database);
      migrateProjectImageState(database);
      migrateConnectionResources(database);

      createProjectStore(database, { id: () => PROJECT }).createVerified({
        displayName: 'fixture',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'fixture' },
      });
      database.prepare("UPDATE projects SET status = 'active' WHERE project_id = ?").run(PROJECT);
      database
        .prepare('INSERT INTO project_config(project_id, value, updated_at) VALUES (?, ?, ?)')
        .run(
          PROJECT,
          JSON.stringify({
            language: 'zh-CN',
            scenarioBranch: 'scenario-testing',
            scenarioMode: 'auto',
          }),
          new Date(0).toISOString(),
        );
      const queued = createProjectTestRequestQueue(database, PROJECT, {
        requestId: () => '33333333-3333-4333-8333-333333333333',
      }).enqueue({ request: 'test', trigger: 'manual' });

      migrateExecutionRuntime(database);
      migrateExecutionRuntime(database);

      const row = database
        .prepare(
          `SELECT execution_location_id, execution_location_revision,
          managed_files_snapshot_json, config_snapshot_json
          FROM test_request_queue WHERE queue_id = ?`,
        )
        .get(queued.queueId) as {
        execution_location_id: string;
        execution_location_revision: number;
        managed_files_snapshot_json: string;
        config_snapshot_json: string;
      };
      assert.equal(row.execution_location_id, `local:${INSTANCE}`);
      assert.equal(row.execution_location_revision, 1);
      assert.deepEqual(JSON.parse(row.managed_files_snapshot_json), []);
      assert.equal(JSON.parse(row.config_snapshot_json).runtimeMode, 'external');
      assert.throws(
        () =>
          database
            .prepare(
              'UPDATE test_request_queue SET execution_location_revision = 2 WHERE queue_id = ?',
            )
            .run(queued.queueId),
        /immutable/,
      );
      assert.deepEqual(database.pragma('foreign_key_check'), []);
    } finally {
      database.close();
    }
  });
});
