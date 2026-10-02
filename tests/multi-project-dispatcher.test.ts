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
import { migrateRunStop } from '../src/server/db/migrations/0018-run-stop.js';
import { createProjectRunRecoveryStore } from '../src/server/automation/recovery.js';
import type { RunDetail, RunSummary } from '../src/shared/types.js';

describe('project automation dispatcher', () => {
  it('cancels queued requests idempotently and refuses a different project', async () => {
    const fixture = setup();
    const dispatcher = fixture.dispatcher((id) => fakeServices(id, {}));
    try {
      const item = dispatcher.enqueue(fixture.a.projectId, {
        trigger: 'manual',
        request: 'cancel queued',
      });
      await assert.rejects(dispatcher.stopRequest(fixture.b.projectId, item.queueId), /不存在/);
      const first = await dispatcher.stopRequest(fixture.a.projectId, item.queueId);
      assert.equal(first.status, 'interrupted');
      assert.equal(first.runId, null);
      assert.equal(first.stopReason, 'user_requested');
      assert.deepEqual(await dispatcher.stopRequest(fixture.a.projectId, item.queueId), first);
      await dispatcher.drain();
      assert.equal(fixture.queue(fixture.a.projectId).get(item.queueId)?.claimedAt, null);
    } finally {
      await dispatcher.stop();
      fixture.database.close();
    }
  });

  it('holds a stopped preparation until it exits, lets B finish, and never starts A', async () => {
    const fixture = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const bFinished = Promise.withResolvers<void>();
    let aStarts = 0;
    const dispatcher = fixture.dispatcher((id) => {
      const services = fakeServices(id, {
        async start(runId) {
          if (id === fixture.a.projectId) aStarts++;
          return { runId };
        },
        async archive() {
          bFinished.resolve();
          return archiveResult();
        },
      });
      if (id === fixture.a.projectId)
        services.repository.getRepository = async () => {
          entered.resolve();
          await release.promise;
          return {
            fetch: async () => undefined,
            remoteBranchHead: async () => 'a'.repeat(40),
          } as never;
        };
      return services;
    }, 2);
    const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
    dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
    const drain = dispatcher.drain();
    try {
      await entered.promise;
      assert.equal(
        (await dispatcher.stopRequest(fixture.a.projectId, a.queueId)).status,
        'running',
      );
      await bFinished.promise;
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'running');
      release.resolve();
      await drain;
      assert.equal(aStarts, 0);
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'interrupted');
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.resolvedTargetCommit, null);
    } finally {
      release.resolve();
      await dispatcher.stop();
      fixture.database.close();
    }
  });

  it('does not resurrect a stopped preparation during recovery', async () => {
    const fixture = setup();
    try {
      const queue = fixture.queue(fixture.a.projectId);
      const item = queue.enqueue({ trigger: 'manual', request: 'stopped before crash' });
      queue.claimNext();
      queue.requestStop(item.queueId);
      let starts = 0;
      const restarted = fixture.dispatcher((id) =>
        fakeServices(id, {
          async start(runId) {
            starts++;
            return { runId };
          },
        }),
      );
      await restarted.recover();
      await restarted.drain();
      assert.equal(starts, 0);
      assert.equal(queue.get(item.queueId)?.status, 'interrupted');
      assert.equal(queue.get(item.queueId)?.stopReason, 'user_requested');
    } finally {
      fixture.database.close();
    }
  });
  it('restores durable user-stop attribution after a crash before the final Run snapshot', async () => {
    const fixture = setup();
    try {
      const queue = fixture.queue(fixture.a.projectId);
      const item = queue.enqueue({ trigger: 'manual', request: 'original request' });
      queue.claimNext();
      queue.markResolved(item.queueId, 'a'.repeat(40));
      queue.markStarted(item.queueId, '01JQ7K6D5J4P3N2M1H0G9F8E7D');
      const stopped = queue.requestStop(item.queueId);
      const restarted = fixture.dispatcher((id) => fakeServices(id, {}));
      await restarted.recover();
      const recovered = createProjectRunRecoveryStore(fixture.database, fixture.a.projectId).get(
        '01JQ7K6D5J4P3N2M1H0G9F8E7D',
      );
      assert.equal(recovered?.stopReason, 'user_requested');
      assert.equal(recovered?.stopRequestedAt, stopped.stopRequestedAt);
      assert.equal(recovered?.targetCommit, 'a'.repeat(40));
      assert.equal(recovered?.request, 'original request');
      assert.equal(recovered?.result, null);
      assert.match(recovered!.errorMessage!, /未知/);
    } finally {
      fixture.database.close();
    }
  });

  it('overlaps A1/B1, keeps A2 queued, and fills a released slot without losing wakeups', async () => {
    const fixture = setup();
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const both = Promise.withResolvers<void>();
    const bArchived = Promise.withResolvers<void>();
    const started: string[] = [];
    const dispatcher = fixture.dispatcher(
      (projectId) =>
        fakeServices(projectId, {
          async start(runId) {
            started.push(projectId);
            if (started.length === 2) both.resolve();
            return { runId };
          },
          async wait() {
            await (projectId === fixture.a.projectId ? releaseA.promise : releaseB.promise);
            return { status: 'completed' };
          },
          async archive() {
            if (projectId === fixture.b.projectId) bArchived.resolve();
            return archiveResult();
          },
        }),
      2,
    );
    const a1 = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A1' });
    const a2 = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A2' });
    const b1 = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B1' });
    const draining = dispatcher.drain();
    try {
      await both.promise;
      assert.equal(fixture.queue(fixture.a.projectId).get(a1.queueId)?.status, 'running');
      assert.equal(fixture.queue(fixture.b.projectId).get(b1.queueId)?.status, 'running');
      assert.equal(fixture.queue(fixture.a.projectId).get(a2.queueId)?.status, 'queued');
      assert.equal(dispatcher.drain(), draining);
      await assert.rejects(dispatcher.recover(), /活动任务/);
      releaseB.resolve();
      await bArchived.promise;
      assert.equal(fixture.queue(fixture.a.projectId).get(a1.queueId)?.status, 'running');
      const b2 = dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B2' });
      dispatcher.drain();
      releaseA.resolve();
      await draining;
      assert.equal(fixture.queue(fixture.b.projectId).get(b2.queueId)?.status, 'completed');
      assert.equal(fixture.queue(fixture.a.projectId).get(a2.queueId)?.status, 'completed');
      assert.equal(started.length, 4);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await dispatcher.stop();
      fixture.database.close();
    }
  });

  it('counts slow preparation without preventing another project and drains all tasks on shutdown', async () => {
    const fixture = setup();
    const preparing = Promise.withResolvers<void>();
    const releasePreparation = Promise.withResolvers<void>();
    const bStarted = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const dispatcher = fixture.dispatcher((projectId) => {
      const services = fakeServices(projectId, {
        async wait() {
          if (projectId === fixture.b.projectId) {
            bStarted.resolve();
            await releaseB.promise;
          }
          return { status: 'completed' };
        },
      });
      if (projectId === fixture.a.projectId) {
        const get = services.repository.getRepository.bind(services.repository);
        services.repository.getRepository = async () => {
          preparing.resolve();
          await releasePreparation.promise;
          return get();
        };
      }
      return services;
    }, 2);
    const a = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A' });
    const a2 = dispatcher.enqueue(fixture.a.projectId, { trigger: 'manual', request: 'A2' });
    dispatcher.enqueue(fixture.b.projectId, { trigger: 'manual', request: 'B' });
    const draining = dispatcher.drain();
    try {
      await Promise.all([preparing.promise, bStarted.promise]);
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.runId, null);
      assert.equal(fixture.queue(fixture.a.projectId).get(a.queueId)?.status, 'running');
      assert.equal(fixture.queue(fixture.a.projectId).claimNext(), null);
      let stopped = false;
      const stop = dispatcher.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      assert.equal(stopped, false);
      releasePreparation.resolve();
      releaseB.resolve();
      await Promise.all([draining, stop]);
      assert.equal(stopped, true);
      assert.equal(fixture.queue(fixture.a.projectId).get(a2.queueId)?.status, 'queued');
    } finally {
      releasePreparation.resolve();
      releaseB.resolve();
      await dispatcher.stop();
      fixture.database.close();
    }
  });

  it('recovers two interrupted Runs once, without restarting their models or changing fixed targets', async () => {
    const fixture = setup();
    let starts = 0,
      recovered = 0;
    const rows = [fixture.a, fixture.b].map((project, index) => {
      const queue = fixture.queue(project.projectId);
      const row = queue.enqueue({ trigger: 'manual', request: 'recover' });
      queue.claimNext();
      queue.markResolved(row.queueId, (index === 0 ? 'a' : 'b').repeat(40));
      queue.markStarted(row.queueId, `01K0000000000000000000000${index + 1}`);
      return { queue, row };
    });
    const dispatcher = fixture.dispatcher(
      (projectId) =>
        fakeServices(projectId, {
          async start(runId) {
            starts++;
            return { runId };
          },
          async recover() {
            recovered++;
          },
        }),
      2,
    );
    try {
      await dispatcher.recover();
      await dispatcher.recover();
      await dispatcher.drain();
      assert.equal(starts, 0);
      assert.equal(recovered, 2);
      for (const { queue, row } of rows) {
        assert.equal(queue.get(row.queueId)?.status, 'interrupted');
        assert.ok(queue.get(row.queueId)?.resolvedTargetCommit);
      }
    } finally {
      await dispatcher.stop();
      fixture.database.close();
    }
  });
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
      const [current] = await dispatcher.currentRuns();
      assert.equal(current?.projectId, fixture.a.projectId);
      assert.equal(current?.run.runId, activeId);
      assert.equal((await dispatcher.getActiveRun(fixture.a.projectId, activeId))?.runId, activeId);
      assert.equal(await dispatcher.getActiveRun(fixture.b.projectId, activeId), null);
      release.resolve();
      await draining;
      assert.deepEqual(await dispatcher.currentRuns(), []);
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
      const recovering = dispatcher.recover().then(() => dispatcher.drain());
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
      await dispatcher.drain();
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
  migrateRunStop(database);
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
    dispatcher: (
      factory: (projectId: string) => ProjectDispatchServices,
      maxConcurrentProjects = 1,
    ) =>
      createProjectAutomationDispatcher({
        maxConcurrentProjects,
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
