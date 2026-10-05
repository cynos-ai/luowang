import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateConnectionResources } from '../src/server/db/migrations/0021-connection-resources.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import type { ExecutionAdapter } from '../src/server/projects/execution-adapter.js';
import { reconcileExecutionResourceLedger } from '../src/server/projects/execution-resource-recovery.js';
import { createExecutionResourceLedger } from '../src/server/projects/resource-ledger.js';
import { createProjectStore } from '../src/server/projects/store.js';
import type { ScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

it('keeps capacity occupied when Docker resource discovery fails', async () => {
  const database = new Database(':memory:');
  const instanceId = '11111111-1111-4111-8111-111111111111';
  try {
    runMigrations(database);
    ensureSystemMetadata(database, { appVersion: 'test', id: () => instanceId });
    runMigrations(database, [projectIdentityMigration]);
    migrateLegacyRunOwnership(database, null);
    migrateLegacyConfigurationOwnership(database, null);
    migrateProjectQueueContext(database);
    migrateProjectImageState(database);
    migrateConnectionResources(database);
    const project = createProjectStore(database).createVerified({
      displayName: 'Recovery fixture',
      repository: { githubRepositoryId: '1', owner: 'cynos-ai', name: 'fixture' },
    });
    migrateExecutionRuntime(database);
    const ledger = createExecutionResourceLedger(database, instanceId);
    const resource = ledger.plan({
      projectId: project.projectId,
      attemptId: '01K00000000000000000000001',
      executionLocationId: `local:${instanceId}`,
      executionLocationRevision: 1,
      resourceType: 'compose-project',
      ownerLabels: { 'luowang.instance-id': instanceId },
    });
    const adapter: ExecutionAdapter = {
      locationId: `local:${instanceId}`,
      async execute(_program, args) {
        if (args[0] === 'ps') return { stdout: '', stderr: 'daemon unavailable', code: 1 };
        return { stdout: '', stderr: '', code: 0 };
      },
      async upload() {},
      async download() {},
      async uploadTree() {},
      async downloadTree() {},
      async removeTree() {},
      async close() {},
    };
    const result = await reconcileExecutionResourceLedger(database, {} as ScopedSecretStore, {
      adapterFactory: async () => adapter,
    });
    assert.deepEqual(result, { released: 0, unknown: 1 });
    assert.equal(ledger.get(resource.resourceId).state, 'unknown');
    assert.equal(ledger.get(resource.resourceId).occupiesSlot, true);
  } finally {
    database.close();
  }
});
