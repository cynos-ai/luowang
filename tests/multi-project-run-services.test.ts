import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectRunServices } from '../src/server/projects/run-services.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectTaskRuntime } from '../src/server/projects/task-runtime.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

it('assembles two project Runs with fixed repository, cleanup, evidence and history scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-project-runs-'));
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateLegacyIndexOwnership(database, null);
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
    const config = createProjectConfigurationStore(database);
    config.update(a.projectId, {
      language: 'en-US',
      baseUrl: 'https://a.example',
      testDataCleanupUrl: 'https://a.example/cleanup',
    });
    config.update(b.projectId, {
      language: 'zh-CN',
      baseUrl: 'https://b.example',
      testDataCleanupUrl: 'https://b.example/cleanup',
    });
    database.prepare("UPDATE projects SET status = 'active'").run();
    const queueA = createProjectTestRequestQueue(database, a.projectId);
    const queueB = createProjectTestRequestQueue(database, b.projectId);
    queueA.enqueue({ trigger: 'manual', request: 'A' });
    queueB.enqueue({ trigger: 'manual', request: 'B' });
    const claimedA = queueA.claimNext()!;
    const deployment = createConfigurationStore(database, {
      repoDir: join(root, 'repos'),
      reportDir: join(root, 'reports'),
    });
    const paths = { repoRoot: join(root, 'repos'), reportRoot: join(root, 'reports') };
    const secrets = createScopedSecretStore(database, 'synthetic-master-key');
    const runtimeA = createProjectTaskRuntime(claimedA, projects, deployment, paths);
    const servicesA = createProjectRunServices({
      database,
      task: runtimeA,
      secrets,
      ...paths,
      storageRoot: join(root, 'storage'),
    });
    queueA.complete(claimedA.queueId);
    const claimedB = queueB.claimNext()!;
    const runtimeB = createProjectTaskRuntime(claimedB, projects, deployment, paths);
    const servicesB = createProjectRunServices({
      database,
      task: runtimeB,
      secrets,
      ...paths,
      storageRoot: join(root, 'storage'),
    });
    assert.equal(servicesA.repository.getRepositoryUrl(), 'https://github.com/example/a');
    assert.equal(servicesB.repository.getRepositoryUrl(), 'https://github.com/example/b');
    assert.equal(servicesA.testData.cleanupAvailable, true);
    assert.equal(servicesB.testData.cleanupAvailable, true);
    assert.notEqual(
      servicesA.oss.objectKey(RUN_ID, 'shot.png'),
      servicesB.oss.objectKey(RUN_ID, 'shot.png'),
    );
    assert.equal(servicesB.runStore.get(RUN_ID), null);
    const workspaceA = await servicesA.workspaceStore.create(RUN_ID);
    assert.ok(workspaceA.runningDirectory.includes(join('projects', a.projectId)));
    await servicesA.runs.recover();
    assert.equal((await servicesA.runs.get(RUN_ID))?.status, 'interrupted');
    assert.equal(await servicesB.runs.get(RUN_ID), null);
    assert.equal(servicesB.recoveryStore.get(RUN_ID), null);
    assert.equal(servicesA.recoveryStore.get(RUN_ID)?.runId, RUN_ID);
    assert.equal(config.get(a.projectId).testDataCleanupUrl, 'https://a.example/cleanup');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
