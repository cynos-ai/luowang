import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import type { ProjectAutomationDispatcher } from '../src/server/automation/project-dispatcher.js';
import type { ConnectivityRegistry } from '../src/server/connectivity.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateLegacySecretOwnership } from '../src/server/db/migrations/0013-project-secret-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import { migrateProjectReportIndexIdentity } from '../src/server/db/migrations/0017-project-report-index-identity.js';
import { createProjectConsoleService } from '../src/server/projects/console-service.js';
import { createProjectRunStore } from '../src/server/runs/store.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';

const now = '2026-09-27T06:20:00.000Z';
const projectAId = '11111111-1111-4111-8111-111111111111';
const projectBId = '22222222-2222-4222-8222-222222222222';

it('keeps both preparing and unreadable active projects visible with independent waiting reasons', async () => {
  const database = setup();
  try {
    const projects = createProjectStore(database);
    const config = createProjectConfigurationStore(database);
    const [a, b] = ['a', 'b'].map((name, i) => {
      const project = projects.createVerified({
        displayName: name,
        repository: { githubRepositoryId: `${i + 500}`, owner: 'example', name },
      });
      config.update(project.projectId, {});
      return project;
    });
    database.prepare("UPDATE projects SET status = 'active'").run();
    for (const project of [a, b]) {
      const queue = createProjectTestRequestQueue(database, project.projectId);
      const first = queue.enqueue({ request: 'first', trigger: 'manual' });
      queue.enqueue({ request: 'second', trigger: 'manual' });
      queue.claimNext();
      if (project === b) queue.markStarted(first.queueId, '01K00000000000000000000002');
    }
    const dispatch = dispatcher();
    dispatch.getActiveRun = async () => {
      throw new Error('private-canary');
    };
    const service = createProjectConsoleService({
      database,
      projects,
      dispatcher: dispatch,
      connectivity: { list: () => [], runAll: async () => [] } as unknown as ConnectivityRegistry,
      schedulerStatus,
      inspectResources: async () => {
        throw new Error('unused');
      },
      version: 'test',
      databaseHealthy: () => true,
      secretStoreAvailable: () => true,
    });
    const result = await service.workspace();
    assert.equal(result.activeRuns.length, 2);
    assert.deepEqual(result.capacity, { occupied: 2, limit: 2 });
    assert.equal(
      result.activeRuns.find((item) => item.project.projectId === a.projectId)?.runId,
      null,
    );
    assert.equal(
      result.activeRuns.find((item) => item.project.projectId === a.projectId)?.progress,
      null,
    );
    assert.equal(result.partialErrors[0].projectId, b.projectId);
    assert.equal(result.queue.filter((item) => item.waitingReason === '本项目正在执行').length, 2);
    assert.deepEqual(
      result.queue.filter((item) => item.status === 'queued').map((item) => item.projectPosition),
      [2, 2],
    );
    assert.doesNotMatch(JSON.stringify(result), /private-canary/);
    assert.deepEqual(service.systemStatus().executionCapacity, result.capacity);
  } finally {
    database.close();
  }
});

it('aggregates persisted project facts without running external checks', async () => {
  const database = setup();
  try {
    const ids = [projectAId, projectBId];
    const projects = createProjectStore(database, { now: () => now, id: () => ids.shift()! });
    const projectA = projects.createVerified({
      displayName: '项目 A',
      repository: { githubRepositoryId: '1001', owner: 'cynos-ai', name: 'a' },
    });
    projects.createVerified({
      displayName: '项目 B',
      repository: { githubRepositoryId: '1002', owner: 'cynos-ai', name: 'b' },
    });
    for (const id of ['repository', 'credentials', 'deployment', 'environment', 'image']) {
      database
        .prepare(
          `INSERT INTO project_connectivity_check_results
             (project_id, check_id, status, message, checked_at, latency_ms)
           VALUES (?, ?, 'ok', '通过', ?, NULL)`,
        )
        .run(projectAId, id, now);
    }
    createProjectRunStore(database, projectAId).importCompleted({
      runId: '01K00000000000000000000001',
      trigger: 'manual',
      request: '合成测试请求',
      baseCommit: null,
      targetCommit: 'a'.repeat(40),
      includedCommits: ['a'.repeat(40)],
      result: 'blocked',
      startedAt: now,
      finishedAt: now,
      completedDirectory: '/synthetic/run',
      artifacts: {},
      scenarioResults: [],
      confirmedBugs: [],
      activities: [
        {
          at: now,
          message: '测试数据清理未完成，需要处理；不改变本次功能验证结果。',
          kind: 'warning',
          code: 'test_data_cleanup_failed',
        },
      ],
    });
    let checks = 0;
    let inventories = 0;
    const service = createProjectConsoleService({
      database,
      projects,
      dispatcher: dispatcher(),
      connectivity: {
        list: () => [],
        run: async () => {
          checks += 1;
          throw new Error('not expected');
        },
        runAll: async () => [],
      },
      schedulerStatus: schedulerStatus,
      inspectResources: async () => {
        inventories += 1;
        return {
          instanceId: 'fixture',
          projects: [projectAId, projectBId],
          containers: [],
          images: [],
          candidateImageBytes: 0,
        };
      },
      version: '0.7.0-test',
      databaseHealthy: () => true,
      secretStoreAvailable: () => true,
      now: () => now,
    });

    const workspace = await service.workspace();
    assert.equal(checks, 0);
    assert.equal(inventories, 0);
    assert.equal(workspace.projects.length, 2);
    assert.equal(workspace.projects[0].readiness.status, 'ready');
    assert.equal(workspace.projects[1].readiness.status, 'not_checked');
    assert.equal(workspace.recentRuns[0].project.projectId, projectA.projectId);
    assert.ok(workspace.attention.some((item) => item.kind === 'blocked_run'));
    assert.ok(workspace.attention.some((item) => item.kind === 'cleanup_failed'));
    assert.ok(
      workspace.attention.some(
        (item) => item.kind === 'not_ready' && item.project?.projectId === projectBId,
      ),
    );
    await service.resources();
    assert.equal(inventories, 1);
  } finally {
    database.close();
  }
});

it('keeps healthy projects when one project summary cannot be read', async () => {
  const database = setup();
  try {
    const actual = createProjectStore(database, { now: () => now, id: () => projectAId });
    const projectA = actual.createVerified({
      displayName: '项目 A',
      repository: { githubRepositoryId: '1001', owner: 'cynos-ai', name: 'a' },
    });
    const missingProject = {
      ...projectA,
      projectId: projectBId,
      displayName: '项目 B',
      githubRepositoryId: '1002',
      repositoryName: 'b',
    };
    const projects = {
      createVerified: actual.createVerified,
      get: (projectId: string) =>
        projectId === projectAId ? projectA : projectId === projectBId ? missingProject : null,
      list: () => [projectA, missingProject],
    };
    const service = createProjectConsoleService({
      database,
      projects,
      dispatcher: dispatcher(),
      connectivity: { list: () => [], runAll: async () => [], run: async () => assert.fail() },
      schedulerStatus,
      inspectResources: async () => ({
        instanceId: 'fixture',
        projects: [],
        containers: [],
        images: [],
        candidateImageBytes: 0,
      }),
      version: '0.7.0-test',
      databaseHealthy: () => true,
      secretStoreAvailable: () => true,
      now: () => now,
    });

    const workspace = await service.workspace();
    assert.equal(workspace.projects.length, 2);
    assert.equal(workspace.projects[0].readError, null);
    assert.equal(workspace.projects[1].readError?.code, 'PROJECT_SUMMARY_READ_FAILED');
    assert.deepEqual(workspace.partialErrors, [
      {
        projectId: projectBId,
        code: 'PROJECT_SUMMARY_READ_FAILED',
        message: '项目摘要暂时不可读',
      },
    ]);
  } finally {
    database.close();
  }
});

it('reads persisted dependency state, redacts diagnostics, and only checks fixed adapters explicitly', async () => {
  const database = setup();
  try {
    database
      .prepare(
        `INSERT INTO connectivity_check_results
           (check_id, status, message, checked_at, latency_ms)
         VALUES ('provider-model', 'failed', ?, ?, 12)`,
      )
      .run('请求 https://user:password@example.test 失败 /home/private/config', now);
    let requested: string | null = null;
    const connectivity: ConnectivityRegistry = {
      list: () => [],
      runAll: async () => [],
      run: async (id) => {
        requested = id;
        database
          .prepare(
            `UPDATE connectivity_check_results
             SET status = 'ok', message = '连接通过', checked_at = ? WHERE check_id = ?`,
          )
          .run(now, id);
        return {
          id,
          label: id,
          available: true,
          result: { status: 'ok', message: '连接通过', checkedAt: now, latencyMs: 1 },
        };
      },
    };
    const service = createProjectConsoleService({
      database,
      projects: createProjectStore(database),
      dispatcher: dispatcher(),
      connectivity,
      schedulerStatus,
      inspectResources: async () => ({
        instanceId: 'fixture',
        projects: [],
        containers: [],
        images: [],
        candidateImageBytes: 0,
      }),
      version: '0.7.0-test',
      databaseHealthy: () => true,
      secretStoreAvailable: () => true,
      now: () => now,
    });

    const status = service.systemStatus();
    assert.equal(requested, null);
    assert.equal(status.dependencies[0].status, 'unavailable');
    assert.equal(status.dependencies[0].message.includes('password'), false);
    assert.equal(status.dependencies[0].message.includes('/home/private'), false);
    assert.equal(status.dependencies[1].status, 'not_checked');
    const checked = await service.runSystemCheck('provider');
    assert.equal(requested, 'provider-model');
    assert.equal(checked.check.status, 'ok');
    assert.equal(checked.result.status, 'ok');
    assert.equal(checked.result.message, '连接通过');
  } finally {
    database.close();
  }
});

function dispatcher(): ProjectAutomationDispatcher {
  return {
    enqueue: () => {
      throw new Error('unused');
    },
    drain: async () => {},
    recover: async () => {},
    retryArchives: async () => {},
    maxConcurrentProjects: 2,
    stop: async () => undefined,
    currentRuns: async () => [],
    getActiveRun: async () => null,
  };
}

function schedulerStatus() {
  return {
    running: true,
    lastPollAt: now,
    nextPollAt: null,
    lastArchiveAt: null,
    nextArchiveAt: null,
    lastIndexerAt: now,
    nextIndexerAt: null,
    lastCleanupAt: null,
    nextCleanupAt: null,
    lastCronKey: null,
    lastError: null,
  };
}

function setup(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyIndexOwnership(database, null);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateLegacySecretOwnership(database, 'test-master-key', null);
  migrateProjectQueueContext(database);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  migrateProjectReportIndexIdentity(database);
  return database;
}
