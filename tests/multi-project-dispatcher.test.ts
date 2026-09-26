import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import {
  createProjectAutomationDispatcher,
  type ProjectDispatchServices,
} from '../src/server/automation/project-dispatcher.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import type { RunDetail, RunSummary } from '../src/shared/types.js';

describe('project automation dispatcher', () => {
  it('exposes only the active project Run while execution is in progress', async () => {
    const fixture = setup();
    try {
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let activeId = '';
      const summary: RunSummary = {
        runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        status: 'running',
        phase: 'runner',
        result: null,
        trigger: 'manual',
        request: 'A',
        baseCommit: null,
        targetCommit: 'a'.repeat(40),
        includedCommits: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        errorMessage: null,
        artifactNames: [],
      };
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async start(runId) {
            activeId = runId;
            return { runId };
          },
          async wait() {
            waiting.resolve();
            await release.promise;
            return { status: 'completed' };
          },
          async current() {
            return { ...summary, runId: activeId };
          },
          async get() {
            return { ...summary, runId: activeId, artifacts: {} };
          },
        }),
      );
      dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
      const draining = dispatcher.drain();
      await waiting.promise;
      const current = await dispatcher.currentRun();
      assert.equal(current?.projectId, fixture.a.projectId);
      assert.equal(current?.run.runId, activeId);
      assert.equal((await dispatcher.getActiveRun(fixture.a.projectId, activeId))?.runId, activeId);
      assert.equal(await dispatcher.getActiveRun(fixture.b.projectId, activeId), null);
      release.resolve();
      await draining;
      assert.equal(await dispatcher.currentRun(), null);
    } finally {
      fixture.database.close();
    }
  });
  it('starts B while A is waiting for its own archive and retains both project bindings', async () => {
    const fixture = setup();
    try {
      const events: string[] = [];
      const bStarted = Promise.withResolvers<void>();
      const finishAArchive = Promise.withResolvers<void>();
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async start(runId, targetCommit) {
            events.push(`${projectId}:start:${targetCommit}`);
            if (projectId === fixture.b.projectId) bStarted.resolve();
            return { runId };
          },
          async archive() {
            events.push(`${projectId}:archive-start`);
            if (projectId === fixture.a.projectId) await finishAArchive.promise;
            events.push(`${projectId}:archive-end`);
            return archiveResult();
          },
        }),
      );
      const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
      const b = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
      const draining = dispatcher.drain();
      await bStarted.promise;
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'waiting_archive');
      assert.equal(events.includes(`${fixture.a.projectId}:archive-end`), false);
      finishAArchive.resolve();
      await draining;
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'completed');
      assert.equal(fixture.queue(fixture.b.projectId).get(b.queueId)?.status, 'completed');
      assert.equal(events.filter((event) => event.includes(':start:')).length, 2);
    } finally {
      fixture.database.close();
    }
  });

  it('fails one project without consuming the other project request', async () => {
    const fixture = setup();
    try {
      const started: string[] = [];
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async start(runId) {
            started.push(projectId);
            if (projectId === fixture.a.projectId) throw new Error('image unavailable');
            return { runId };
          },
        }),
      );
      const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
      const b = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
      await dispatcher.drain();
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'failed');
      assert.match(
        fixture.queue(fixture.a.projectId).get(a.queueId)?.errorMessage ?? '',
        /image unavailable/,
      );
      assert.equal(fixture.queue(fixture.b.projectId).get(b.queueId)?.status, 'completed');
      assert.deepEqual(started, [fixture.a.projectId, fixture.b.projectId]);
    } finally {
      fixture.database.close();
    }
  });

  it('records an archive failure for A while B still completes', async () => {
    const fixture = setup();
    try {
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async archive() {
            if (projectId === fixture.a.projectId) throw new Error('A archive unavailable');
            return archiveResult();
          },
        }),
      );
      const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
      const b = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
      await dispatcher.drain();
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.archiveStatus, 'failed');
      assert.equal(
        fixture.queue(fixture.b.projectId).get(b.queueId)?.archiveStatus,
        'completed',
        fixture.queue(fixture.b.projectId).get(b.queueId)?.errorMessage ?? undefined,
      );
    } finally {
      fixture.database.close();
    }
  });

  it('retries completed archives from fixed project snapshots even when one project is paused', async () => {
    const fixture = setup();
    try {
      const attempts = new Map<string, number>();
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async archive() {
            const attempt = (attempts.get(projectId) ?? 0) + 1;
            attempts.set(projectId, attempt);
            if (attempt === 1 || projectId === fixture.a.projectId) {
              throw new Error(`${projectId} archive unavailable`);
            }
            return archiveResult();
          },
        }),
      );
      const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
      const b = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
      await dispatcher.drain();
      assert.throws(
        () =>
          fixture
            .queue(fixture.b.projectId)
            .recordArchiveRetry(
              a.queueId,
              fixture.queue(fixture.a.projectId).get(a.queueId)!.runId!,
              { archiveStatus: 'completed' },
            ),
        /不存在/,
      );
      fixture.database
        .prepare("UPDATE projects SET status = 'paused' WHERE project_id = ?")
        .run(fixture.a.projectId);
      await dispatcher.retryArchives(new Date(Date.now() + 61_000));
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.archiveStatus, 'failed');
      assert.equal(
        fixture.queue(fixture.b.projectId).get(b.queueId)?.archiveStatus,
        'completed',
        fixture.queue(fixture.b.projectId).get(b.queueId)?.errorMessage ?? undefined,
      );
      assert.equal(attempts.get(fixture.a.projectId), 2);
      assert.equal(attempts.get(fixture.b.projectId), 2);
      await dispatcher.retryArchives(new Date());
      assert.equal(attempts.get(fixture.a.projectId), 2);
    } finally {
      fixture.database.close();
    }
  });

  it('recovers A waiting archive from its stored project while B can run', async () => {
    const fixture = setup();
    try {
      const aQueued = fixture
        .queue(fixture.a.projectId)
        .enqueue({ trigger: 'manual', request: 'A' });
      const aClaimed = fixture.queue(fixture.a.projectId).claimNext()!;
      const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      fixture.queue(fixture.a.projectId).markStarted(aClaimed.queueId, runId);
      fixture.queue(fixture.a.projectId).markWaitingArchive(aClaimed.queueId, runId);
      const b = fixture.queue(fixture.b.projectId).enqueue({ trigger: 'manual', request: 'B' });
      const bStarted = Promise.withResolvers<void>();
      const finishAArchive = Promise.withResolvers<void>();
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async start(startedRunId) {
            if (projectId === fixture.b.projectId) bStarted.resolve();
            return { runId: startedRunId };
          },
          async archive() {
            if (projectId === fixture.a.projectId) await finishAArchive.promise;
            return archiveResult();
          },
        }),
      );
      const recovering = dispatcher.recover();
      await bStarted.promise;
      assert.equal(
        fixture.queue(fixture.a.projectId).get(aQueued.queueId)?.status,
        'waiting_archive',
      );
      finishAArchive.resolve();
      await recovering;
      assert.equal(fixture.queue(fixture.a.projectId).get(aQueued.queueId)?.status, 'completed');
      assert.equal(fixture.queue(fixture.b.projectId).get(b.queueId)?.status, 'completed');
    } finally {
      fixture.database.close();
    }
  });

  it('defers migrated archives until first activation, including across restart', async () => {
    const fixture = setup();
    try {
      const queue = fixture.queue(fixture.a.projectId);
      const failed = queue.enqueue({ trigger: 'manual', request: 'failed archive' });
      queue.claimNext();
      queue.markStarted(failed.queueId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      queue.markWaitingArchive(failed.queueId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      queue.complete(failed.queueId, {
        runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        archiveStatus: 'failed',
      });
      const pending = queue.enqueue({ trigger: 'manual', request: 'pending archive' });
      queue.claimNext();
      queue.markStarted(pending.queueId, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
      queue.markWaitingArchive(pending.queueId, '01ARZ3NDEKTSV4RRFFQ69G5FAW');
      fixture.database
        .prepare("UPDATE projects SET status = 'paused' WHERE project_id = ?")
        .run(fixture.a.projectId);
      fixture.database
        .prepare(
          'INSERT INTO system_metadata (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run('v061_legacy_cutover_project_id', fixture.a.projectId, 'now', 'now');
      let calls = 0;
      const factory = (projectId: string) =>
        fakeServices(projectId, {
          async archive() {
            calls++;
            return archiveResult();
          },
        });
      const first = fixture.dispatcher(factory);
      await first.recover();
      await first.retryArchives(new Date(Date.now() + 61_000));
      assert.equal(calls, 0);
      assert.equal(queue.get(pending.queueId)?.status, 'waiting_archive');
      assert.equal(queue.get(failed.queueId)?.archiveStatus, 'failed');
      const restarted = fixture.dispatcher(factory);
      await restarted.recover();
      fixture.database
        .prepare(
          'INSERT INTO system_metadata (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run('v061_legacy_project_activated', fixture.a.projectId, 'now', 'now');
      await restarted.retryArchives(new Date(Date.now() + 61_000));
      assert.equal(calls, 2);
      assert.equal(queue.get(pending.queueId)?.status, 'completed');
      assert.equal(queue.get(failed.queueId)?.archiveStatus, 'completed');
      await restarted.retryArchives(new Date(Date.now() + 120_000));
      assert.equal(calls, 2);
    } finally {
      fixture.database.close();
    }
  });

  it('contains one project recovery failure and continues with another project', async () => {
    const fixture = setup();
    try {
      const a = fixture.queue(fixture.a.projectId).enqueue({ trigger: 'manual', request: 'A' });
      const claimedA = fixture.queue(fixture.a.projectId).claimNext()!;
      fixture
        .queue(fixture.a.projectId)
        .markStarted(claimedA.queueId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
      const b = fixture.queue(fixture.b.projectId).enqueue({ trigger: 'manual', request: 'B' });
      const dispatcher = fixture.dispatcher((projectId) =>
        fakeServices(projectId, {
          async recover() {
            if (projectId === fixture.a.projectId) throw new Error('A recovery failed');
          },
        }),
      );
      await dispatcher.recover();
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'interrupted');
      assert.match(
        fixture.queue(fixture.a.projectId).get(a.queueId)?.errorMessage ?? '',
        /A recovery failed/,
      );
      assert.equal(fixture.queue(fixture.b.projectId).get(b.queueId)?.status, 'completed');
    } finally {
      fixture.database.close();
    }
  });
});

function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  const projects = createProjectStore(database, {
    id: (() => {
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      return () => ids.shift()!;
    })(),
    now: () => '2026-01-01T00:00:00.000Z',
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
  config.update(a.projectId, { baseUrl: 'https://a.example' });
  config.update(b.projectId, { baseUrl: 'https://b.example' });
  database.prepare("UPDATE projects SET status = 'active'").run();
  const deployment = createConfigurationStore(database, {
    repoDir: '/repos',
    reportDir: '/reports',
  });
  const secrets = createScopedSecretStore(database, 'synthetic-master-key');
  return {
    database,
    a,
    b,
    queue: (projectId: string) => createProjectTestRequestQueue(database, projectId),
    dispatcher: (factory: (projectId: string) => ProjectDispatchServices) =>
      createProjectAutomationDispatcher({
        database,
        deployment,
        projects,
        secrets,
        repoRoot: '/repos',
        reportRoot: '/reports',
        storageRoot: '/storage',
        createServices: (task) => {
          assert.equal(
            task.configuration.getRepository().repository,
            `https://github.com/example/${task.projectId === a.projectId ? 'a' : 'b'}`,
          );
          return factory(task.projectId);
        },
      }),
  };
}

function fakeServices(
  projectId: string,
  hooks: {
    start?: (runId: string, targetCommit: string) => Promise<{ runId: string }>;
    archive?: () => Promise<ReturnType<typeof archiveResult>>;
    recover?: () => Promise<void>;
    wait?: () => Promise<{ status: 'completed' }>;
    current?: () => Promise<RunSummary | null>;
    get?: () => Promise<RunDetail | null>;
  },
): ProjectDispatchServices {
  const targetCommit = projectId.startsWith('1111') ? 'a'.repeat(40) : 'b'.repeat(40);
  return {
    repository: {
      getScenarioBranch: () => 'scenario-testing',
      getRepository: async () => ({
        fetch: async () => undefined,
        remoteBranchHead: async () => targetCommit,
      }),
      isPublishedTarget: async (commit: string) => commit === targetCommit,
      cleanupMergeRequestRef: async () => undefined,
    },
    runs: {
      start: async (input: { runId?: string; targetCommit?: string }) =>
        hooks.start ? hooks.start(input.runId!, input.targetCommit!) : { runId: input.runId! },
      wait: hooks.wait ?? (async () => ({ status: 'completed' })),
      recover: hooks.recover ?? (async () => undefined),
      get: hooks.get ?? (async () => null),
      current: hooks.current ?? (async () => null),
    },
    archiver: {
      archive: hooks.archive ?? (async () => archiveResult()),
      retry: hooks.archive ?? (async () => archiveResult()),
    },
  } as unknown as ProjectDispatchServices;
}

function archiveResult() {
  return { status: 'completed' as const, progressed: true, errorMessage: null };
}
