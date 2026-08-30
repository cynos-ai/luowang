import { strict as assert } from 'node:assert';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it } from 'vitest';

import type { RunDetail, RunSummary } from '../src/shared/types.js';
import { createAutomationScheduler, matchesCron } from '../src/server/automation/scheduler.js';
import {
  createAutomationService,
  type AutomationService,
} from '../src/server/automation/service.js';
import { createGitPoller } from '../src/server/automation/poller.js';
import { createAutomationStateStore } from '../src/server/automation/state.js';
import { createTestRequestQueue, type TestRequestRecord } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import type { RunArchiver } from '../src/server/runs/archiver.js';
import type { RunStore } from '../src/server/runs/store.js';
import type { RunInput } from '../src/server/runs/types.js';
import { createRunOrchestrator, type RunOrchestrator } from '../src/server/runs/orchestrator.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import { RunWorkspaceStore } from '../src/server/runs/workspace.js';
import { createRunRecoveryStore } from '../src/server/automation/recovery.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 6 persistent automation', () => {
  it('keeps FIFO order while merging only queued automatic requests', async () => {
    const context = await createDatabaseContext();
    let requestNumber = 0;
    const queue = createTestRequestQueue(context.database.sqlite, {
      requestId: () => `request-${++requestNumber}`,
    });

    const first = queue.enqueue({
      request: 'Git product change A',
      trigger: 'git',
      targetRef: 'a'.repeat(40),
    });
    const merged = queue.enqueue({
      request: 'Cron product change B',
      trigger: 'schedule',
      targetRef: 'b'.repeat(40),
    });
    const manual = queue.enqueue({
      request: '人工重测',
      trigger: 'manual',
      targetRef: 'b'.repeat(40),
    });
    const api = queue.enqueue({ request: 'API 重测', trigger: 'api', targetRef: 'b'.repeat(40) });

    assert.equal(merged.queueId, first.queueId);
    assert.equal(merged.targetRef, 'b'.repeat(40));
    assert.deepEqual(merged.triggerSources, ['git', 'schedule']);
    assert.equal(queue.listPending().length, 3);
    assert.deepEqual(
      queue.listPending().map((item) => [item.queueId, item.trigger]),
      [
        [first.queueId, 'git'],
        [manual.queueId, 'manual'],
        [api.queueId, 'api'],
      ],
    );

    const claimed = queue.claimNext();
    assert.equal(claimed?.queueId, first.queueId);
    queue.markStarted(first.queueId, runId(1));
    queue.markWaitingArchive(first.queueId, runId(1));
    queue.complete(first.queueId, {
      runId: runId(1),
      archiveStatus: 'completed',
      progressed: true,
    });

    assert.equal(queue.claimNext()?.queueId, manual.queueId);
  });

  it('polls only the configured scenario branch and filters pure test assets', async () => {
    const context = await createDatabaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    configuration.updateRepository({
      repository: 'https://github.com/cynos-ai/cynos-website',
      scenarioBranch: 'scenario-testing',
      triggerOnCommit: true,
    });
    const state = createAutomationStateStore(context.database.sqlite);
    const queue = createTestRequestQueue(context.database.sqlite);
    let head = 'a'.repeat(40);
    let changes: Array<{ sha: string; paths: string[] }> = [];
    const git = {
      fetch: async () => undefined,
      remoteBranchHead: async (branch: string) => {
        assert.equal(branch, 'scenario-testing');
        return head;
      },
      commitsBetween: async () => changes,
    };
    const repository = {
      getRepository: async () => git,
      getScenarioBranch: () => 'scenario-testing',
    } as unknown as RepositoryService;
    const submitted: TestRequestRecord[] = [];
    const poller = createGitPoller({
      configuration,
      repository,
      state,
      submitter: {
        submitTestRequest: async (input) => {
          const item = queue.enqueue(input);
          submitted.push(item);
          return { queue: item };
        },
      },
    });

    const initialized = await poller.poll('git');
    assert.equal(initialized.status, 'no_change');
    head = 'b'.repeat(40);
    changes = [
      { sha: 'c'.repeat(40), paths: ['docs/scenario-testing/scenarios/login.md'] },
      { sha: 'd'.repeat(40), paths: ['src/login.ts'] },
    ];
    const productChange = await poller.poll('git');
    assert.equal(productChange.status, 'queued');
    assert.deepEqual(productChange.includedCommits, ['d'.repeat(40)]);
    assert.equal(submitted[0]?.targetRef, head);

    head = 'e'.repeat(40);
    changes = [{ sha: 'f'.repeat(40), paths: ['docs/scenario-testing/reports/run/report.md'] }];
    const testAssetChange = await poller.poll('schedule');
    assert.equal(testAssetChange.status, 'ignored');
    assert.equal(submitted.length, 1);
  });

  it('runs poll, archive, indexer and cron tasks at injectable intervals', async () => {
    const context = await createDatabaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    configuration.updateRepository({
      repository: 'https://github.com/cynos-ai/cynos-website',
      pollIntervalSeconds: 60,
      cron: '5 * * * *',
      triggerOnCommit: true,
    });
    const state = createAutomationStateStore(context.database.sqlite);
    const pollCalls: string[] = [];
    let archiveCalls = 0;
    let cleanupCalls = 0;
    let indexCalls = 0;
    const poller = {
      poll: async (trigger: 'git' | 'schedule') => {
        pollCalls.push(trigger);
        return {
          status: 'no_change' as const,
          trigger,
          scenarioBranch: 'scenario-testing',
          currentHead: null,
          baselineCommit: null,
          includedCommits: [],
          queue: null,
          message: 'no-op',
        };
      },
      reset: () => undefined,
    };
    const automation = {
      state: () => state,
      scanArchives: async () => {
        archiveCalls += 1;
        return [];
      },
      cleanupRetention: async () => {
        cleanupCalls += 1;
        return { removedRunIds: [], skippedRunIds: [] };
      },
    } as unknown as AutomationService;
    const scheduler = createAutomationScheduler({
      configuration,
      poller,
      automation,
      state,
      indexer: {
        sync: async () => {
          indexCalls += 1;
          return {
            status: 'not_configured',
            commitSha: null,
            syncedAt: null,
            scenarios: 0,
            reports: 0,
            errors: [],
            message: 'fixture',
          };
        },
      } as never,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });

    await scheduler.tick(new Date('2026-08-30T00:00:09.000Z'));
    assert.equal(archiveCalls, 0);
    await scheduler.tick(new Date('2026-08-30T00:00:10.000Z'));
    assert.equal(archiveCalls, 1);
    await scheduler.tick(new Date('2026-08-30T00:01:00.000Z'));
    assert.deepEqual(pollCalls, ['git']);
    await scheduler.tick(new Date('2026-08-30T00:05:00.000Z'));
    assert.equal(scheduler.status().lastCronKey, '2026-08-30-00-05');
    assert.equal(pollCalls.includes('schedule'), true);
    assert.equal(cleanupCalls, 1);
    assert.equal(indexCalls, 1);
    assert.equal(matchesCron('*/5 * * * *', new Date('2026-08-30T00:05:00.000Z')), true);
  });

  it('does not start the next queued request until the current Run is archived', async () => {
    const context = await createDatabaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    const fakeRuns = createFakeRuns();
    const archiveCalls: string[] = [];
    const archiver: RunArchiver = {
      archive: async (runId) => {
        archiveCalls.push(runId);
        return {
          runId,
          status: 'completed',
          reportStatus: 'published',
          reportCommitSha: 'f'.repeat(40),
          issues: [],
          progressed: true,
          archiveStatus: 'completed',
          errorMessage: null,
          indexerTriggered: false,
        };
      },
      scan: async () => [],
      retry: async (runId) => archiver.archive(runId),
    };
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration,
      repository: {} as RepositoryService,
      runs: fakeRuns.runs,
      archiver,
      reportDir: context.config.reportDir,
    });

    const first = await automation.submitTestRequest({
      request: '第一项',
      trigger: 'manual',
      targetRef: 'a'.repeat(40),
    });
    const second = await automation.submitTestRequest({
      request: '第二项',
      trigger: 'manual',
      targetRef: 'b'.repeat(40),
    });
    assert.equal(first.run?.runId, runId(1));
    assert.equal(second.run, null);
    assert.deepEqual(
      fakeRuns.started.map((item) => item.request),
      ['第一项'],
    );

    fakeRuns.finish(runId(1));
    await waitFor(() => fakeRuns.started.length === 2);
    assert.deepEqual(archiveCalls, [runId(1)]);
    assert.deepEqual(
      fakeRuns.started.map((item) => item.request),
      ['第一项', '第二项'],
    );
    fakeRuns.finish(runId(2));
    await waitFor(() => archiveCalls.length === 2);
    assert.equal(
      automation.listQueue().every((item) => item.status === 'completed'),
      true,
    );
  });

  it('recovers queued, running and waiting-archive requests after a process restart', async () => {
    const queuedContext = await createDatabaseContext();
    const queuedConfiguration = createConfigurationStore(queuedContext.database.sqlite, {
      repoDir: queuedContext.config.repoDir,
      reportDir: queuedContext.config.reportDir,
    });
    const queued = createTestRequestQueue(queuedContext.database.sqlite);
    const queuedItem = queued.enqueue({
      request: '重启后继续执行的排队请求',
      trigger: 'api',
      targetRef: 'a'.repeat(40),
    });
    const queuedRuns = createRestartFakeRuns();
    const queuedAutomation = createAutomationService({
      database: queuedContext.database.sqlite,
      configuration: queuedConfiguration,
      repository: {} as RepositoryService,
      runs: queuedRuns.runs,
      archiver: createNoopArchiver(),
      reportDir: queuedContext.config.reportDir,
    });

    await queuedAutomation.recover();
    assert.equal(queuedAutomation.getQueue(queuedItem.queueId)?.status, 'running');
    assert.deepEqual(
      queuedRuns.started.map((item) => item.request),
      ['重启后继续执行的排队请求'],
    );

    const runningContext = await createDatabaseContext();
    const runningConfiguration = createConfigurationStore(runningContext.database.sqlite, {
      repoDir: runningContext.config.repoDir,
      reportDir: runningContext.config.reportDir,
    });
    const running = createTestRequestQueue(runningContext.database.sqlite);
    const runningItem = running.enqueue({
      request: '进程中断的运行请求',
      trigger: 'git',
      targetRef: 'b'.repeat(40),
    });
    running.claimNext();
    running.markStarted(runningItem.queueId, runId(3));
    const interrupted: RunDetail = {
      runId: runId(3),
      status: 'interrupted',
      phase: 'interrupted',
      result: null,
      trigger: 'git',
      request: '进程中断的运行请求',
      baseCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      includedCommits: ['b'.repeat(40)],
      startedAt: '2026-08-30T00:00:00.000Z',
      finishedAt: '2026-08-30T00:01:00.000Z',
      errorMessage: '进程重启时 Run 尚在 running 目录，未恢复 Agent 会话',
      artifactNames: ['plan.md'],
      artifacts: { 'plan.md': '# plan' },
    };
    const interruptedRecovery = createRunRecoveryStore(runningContext.database.sqlite, {
      now: () => '2026-08-30T00:02:00.000Z',
    });
    const interruptedRuns = createRestartFakeRuns(new Map([[interrupted.runId, interrupted]]));
    const runningAutomation = createAutomationService({
      database: runningContext.database.sqlite,
      configuration: runningConfiguration,
      repository: {} as RepositoryService,
      runs: interruptedRuns.runs,
      archiver: createNoopArchiver(),
      recoveryStore: interruptedRecovery,
      reportDir: runningContext.config.reportDir,
    });

    await runningAutomation.recover();
    const interruptedQueue = runningAutomation.getQueue(runningItem.queueId);
    assert.equal(interruptedQueue?.status, 'interrupted');
    assert.equal(interruptedRecovery.get(interrupted.runId)?.targetCommit, 'b'.repeat(40));

    const archiveContext = await createDatabaseContext();
    const archiveConfiguration = createConfigurationStore(archiveContext.database.sqlite, {
      repoDir: archiveContext.config.repoDir,
      reportDir: archiveContext.config.reportDir,
    });
    const archiveQueue = createTestRequestQueue(archiveContext.database.sqlite);
    const waitingItem = archiveQueue.enqueue({
      request: '重启时等待归档的请求',
      trigger: 'schedule',
      targetRef: 'c'.repeat(40),
    });
    archiveQueue.claimNext();
    archiveQueue.markStarted(waitingItem.queueId, runId(4));
    archiveQueue.markWaitingArchive(waitingItem.queueId, runId(4));
    const nextItem = archiveQueue.enqueue({
      request: '等待归档后的下一请求',
      trigger: 'manual',
      targetRef: 'd'.repeat(40),
    });
    const archiveCalls: string[] = [];
    const archiveRuns = createRestartFakeRuns();
    const archiveAutomation = createAutomationService({
      database: archiveContext.database.sqlite,
      configuration: archiveConfiguration,
      repository: {} as RepositoryService,
      runs: archiveRuns.runs,
      archiver: {
        archive: async (runId) => {
          archiveCalls.push(runId);
          return {
            runId,
            status: 'completed',
            reportStatus: 'published',
            reportCommitSha: 'e'.repeat(40),
            issues: [],
            progressed: true,
            archiveStatus: 'completed',
            errorMessage: null,
            indexerTriggered: false,
          };
        },
        scan: async () => [],
        retry: async (runId) => {
          throw new Error(`unexpected retry: ${runId}`);
        },
      },
      reportDir: archiveContext.config.reportDir,
    });

    await archiveAutomation.recover();
    assert.deepEqual(archiveCalls, [runId(4)]);
    assert.equal(archiveAutomation.getQueue(waitingItem.queueId)?.status, 'completed');
    assert.equal(archiveAutomation.getQueue(nextItem.queueId)?.status, 'running');
    assert.deepEqual(
      archiveRuns.started.map((item) => item.request),
      ['等待归档后的下一请求'],
    );
  });

  it('cleans only old successfully archived completed directories', async () => {
    const context = await createDatabaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    configuration.updateHarness({ local: { retentionDays: 1 } });
    const oldRunId = runId(5);
    const recentRunId = runId(6);
    const failedRunId = runId(7);
    await Promise.all(
      [oldRunId, recentRunId, failedRunId].map((id) =>
        mkdir(join(context.config.reportDir, 'completed', id), { recursive: true }),
      ),
    );
    const runStore = {
      list: () => [
        {
          runId: oldRunId,
          archiveStatus: 'completed',
          finishedAt: '2026-08-28T00:00:00.000Z',
        },
        {
          runId: recentRunId,
          archiveStatus: 'completed',
          finishedAt: '2026-08-29T12:00:00.000Z',
        },
        {
          runId: failedRunId,
          archiveStatus: 'failed',
          finishedAt: '2026-08-28T00:00:00.000Z',
        },
      ],
    } as unknown as RunStore;
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration,
      repository: {} as RepositoryService,
      runs: createRestartFakeRuns().runs,
      archiver: createNoopArchiver(),
      runStore,
      reportDir: context.config.reportDir,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });

    const cleanupResult = await automation.cleanupRetention();
    assert.deepEqual(cleanupResult, { removedRunIds: [oldRunId], skippedRunIds: [] });
    const remaining = await new RunWorkspaceStore(context.config.reportDir).list('completed');
    assert.deepEqual(remaining, [failedRunId, recentRunId].sort());
    await assert.rejects(access(join(context.config.reportDir, 'completed', oldRunId)));
  });

  it('marks an orphaned running directory interrupted without restoring an Agent session', async () => {
    const context = await createDatabaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    const recoveryStore = createRunRecoveryStore(context.database.sqlite, {
      now: () => '2026-08-30T00:03:00.000Z',
    });
    const orphanedRunId = runId(8);
    const workspace = await new RunWorkspaceStore(context.config.reportDir).create(orphanedRunId);
    await workspace.writer('main-a').writePlan('# 部分执行计划');

    const orchestrator = createRunOrchestrator({
      configuration,
      repository: {} as RepositoryService,
      reportDir: context.config.reportDir,
      provider: {} as ProviderAdapter,
      recoveryStore,
    });

    await orchestrator.recover();
    const recovered = await orchestrator.get(orphanedRunId);
    assert.equal(recovered?.status, 'interrupted');
    assert.equal(recovered?.phase, 'interrupted');
    assert.deepEqual(recovered?.artifactNames, ['plan.md']);
    assert.equal(recoveryStore.get(orphanedRunId)?.runningDirectory, workspace.runningDirectory);
  });
});

async function createDatabaseContext() {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase6-'));
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: join(dataDir, 'repo'),
    LUOWANG_REPORT_DIR: join(dataDir, 'report'),
    LUOWANG_ADMIN_PASSWORD: 'phase6-password!',
    LUOWANG_MASTER_KEY: 'phase6-master-key',
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  return { config, database };
}

function createFakeRuns(): {
  runs: RunOrchestrator;
  started: RunInput[];
  finish: (runId: string, status?: 'completed' | 'interrupted') => void;
} {
  const started: RunInput[] = [];
  const summaries = new Map<string, RunSummary>();
  const waiters = new Map<string, (detail: RunDetail) => void>();
  let active: RunSummary | null = null;
  const runs: RunOrchestrator = {
    start: async (input) => {
      started.push(input);
      const id = runId(started.length);
      const summary: RunSummary = {
        runId: id,
        status: 'queued',
        phase: 'preparing',
        result: null,
        trigger: input.trigger,
        request: input.request,
        baseCommit: null,
        targetCommit: input.targetCommit ?? 'a'.repeat(40),
        includedCommits: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
        errorMessage: null,
        artifactNames: [],
      };
      summaries.set(id, summary);
      active = summary;
      return summary;
    },
    run: async () => {
      throw new Error('not used');
    },
    wait: async (runId) =>
      new Promise<RunDetail>((resolve) => {
        waiters.set(runId, resolve);
      }),
    current: async () => active,
    list: async () => [...summaries.values()],
    get: async (runId) => {
      const summary = summaries.get(runId);
      return summary ? { ...summary, artifacts: {} } : null;
    },
    recover: async () => undefined,
  };
  return {
    runs,
    started,
    finish(runId, status = 'completed') {
      const summary = summaries.get(runId);
      const resolve = waiters.get(runId);
      if (!summary || !resolve) throw new Error(`missing fake Run ${runId}`);
      active = null;
      summary.status = status;
      summary.phase = status === 'completed' ? 'completed' : 'interrupted';
      summary.result = status === 'completed' ? 'passed' : null;
      summary.finishedAt = new Date().toISOString();
      resolve({ ...summary, artifacts: {} });
      waiters.delete(runId);
    },
  };
}

function createRestartFakeRuns(details = new Map<string, RunDetail>()): {
  runs: RunOrchestrator;
  started: RunInput[];
} {
  const started: RunInput[] = [];
  const summaries = new Map<string, RunSummary>();
  return {
    started,
    runs: {
      start: async (input) => {
        started.push(input);
        const summary: RunSummary = {
          runId: runId(started.length),
          status: 'queued',
          phase: 'preparing',
          result: null,
          trigger: input.trigger,
          request: input.request,
          baseCommit: null,
          targetCommit: input.targetCommit ?? 'a'.repeat(40),
          includedCommits: [],
          startedAt: '2026-08-30T00:00:00.000Z',
          finishedAt: null,
          errorMessage: null,
          artifactNames: [],
        };
        summaries.set(summary.runId, summary);
        return summary;
      },
      run: async () => {
        throw new Error('not used');
      },
      wait: async (runId) => {
        const detail = details.get(runId);
        if (detail) return detail;
        return new Promise<RunDetail>(() => undefined);
      },
      current: async () => null,
      list: async () => [...summaries.values()],
      get: async (runId) => details.get(runId) ?? null,
      recover: async () => undefined,
    },
  };
}

function createNoopArchiver(): RunArchiver {
  return {
    archive: async (runId) => ({
      runId,
      status: 'completed',
      reportStatus: 'published',
      reportCommitSha: null,
      issues: [],
      progressed: false,
      archiveStatus: 'completed',
      errorMessage: null,
      indexerTriggered: false,
    }),
    scan: async () => [],
    retry: async (runId) => ({
      runId,
      status: 'completed',
      reportStatus: 'published',
      reportCommitSha: null,
      issues: [],
      progressed: false,
      archiveStatus: 'completed',
      errorMessage: null,
      indexerTriggered: false,
    }),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('fixture condition was not reached');
}

function runId(index: number): string {
  return `01K000000000000000000000${index.toString().padStart(2, '0')}`;
}
