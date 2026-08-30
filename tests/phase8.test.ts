import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { createAutomationService } from '../src/server/automation/service.js';
import { createRunRecoveryStore } from '../src/server/automation/recovery.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import type { ConnectivityRegistry } from '../src/server/connectivity.js';
import type {
  IndexedReport,
  IndexedScenario,
  RepositoryStatusResponse,
  RunDetail,
  RunSummary,
} from '../src/shared/types.js';
import type { RepositoryIndexer } from '../src/server/repository/indexer.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';
import { createRunStore } from '../src/server/runs/store.js';
import type { RunOrchestrator } from '../src/server/runs/orchestrator.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 8 operations console read model', () => {
  it('protects operations views and joins Git, scenario, Run, archive, and active facts', async () => {
    const fixture = await makeFixture();
    const anonymous = await fixture.app.inject({ method: 'GET', url: '/api/operations/dashboard' });
    assert.equal(anonymous.statusCode, 401);

    const login = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase8-api-password!' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = firstCookie(login.headers['set-cookie']);

    const dashboard = await fixture.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie },
    });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().progress.lastCompletedTarget, 'a'.repeat(40));
    assert.equal(dashboard.json().progress.pendingCount, 1);
    assert.equal(dashboard.json().activeRun.run.runId, fixture.activeRunId);
    assert.equal(dashboard.json().automation.pendingScenarioReviews.length, 1);

    const tree = await fixture.app.inject({
      method: 'GET',
      url: '/api/operations/git-tree',
      headers: { cookie },
    });
    assert.equal(tree.statusCode, 200);
    const commit = tree
      .json()
      .entries.find((entry: { sha: string }) => entry.sha === 'b'.repeat(40));
    assert.deepEqual(
      commit.includedRuns.map((run: { runId: string }) => run.runId),
      [fixture.runId],
    );
    assert.equal(commit.targetRuns[0].runId, fixture.runId);
    const target = tree
      .json()
      .entries.find((entry: { sha: string }) => entry.sha === 'c'.repeat(40));
    assert.equal(target.targetRuns[0].runId, fixture.reviewRunId);
    assert.equal(
      target.targetRuns[0].scenarioPrUrl,
      'https://github.com/cynos-ai/cynos-website/pull/8',
    );

    const scenarios = await fixture.app.inject({
      method: 'GET',
      url: '/api/scenarios?query=登录',
      headers: { cookie },
    });
    assert.equal(scenarios.statusCode, 200);
    assert.ok(
      scenarios
        .json()
        .scenarios[0].history.some((item: { runId: string }) => item.runId === fixture.runId),
    );

    const runs = await fixture.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie },
    });
    assert.equal(runs.statusCode, 200);
    const archived = runs.json().runs.find((run: { runId: string }) => run.runId === fixture.runId);
    assert.equal(archived.archive.reportStatus, 'published');
    assert.equal(
      archived.issues[0].requestedIssueUrl,
      'https://github.com/cynos-ai/cynos-website/issues/21',
    );

    const detail = await fixture.app.inject({
      method: 'GET',
      url: `/api/operations/runs/${fixture.runId}`,
      headers: { cookie },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().run.artifacts['report.md'], 'safe report');
    assert.equal(detail.json().run.artifacts['plan.md'], 'safe plan');

    const current = await fixture.app.inject({
      method: 'GET',
      url: '/api/operations/current',
      headers: { cookie },
    });
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().current.role, 'runner');
    assert.equal(current.json().current.stage, 'Runner：执行场景');
    assert.equal(current.json().current.run.request.includes('secret'), false);
  });

  it('keeps the last indexed Git commit visible when the remote is temporarily unavailable', async () => {
    const fixture = await makeFixture({
      repositoryStatus: {
        availability: 'unavailable',
        errorMessage: 'GitHub 暂时不可用',
        remoteHead: null,
      },
    });
    const login = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase8-api-password!' },
    });
    const cookie = firstCookie(login.headers['set-cookie']);

    const dashboard = await fixture.app.inject({
      method: 'GET',
      url: '/api/operations/dashboard',
      headers: { cookie },
    });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().stale, true);
    assert.equal(dashboard.json().branch.head, null);
    assert.equal(dashboard.json().branch.indexedCommit, 'c'.repeat(40));
    assert.equal(
      dashboard.json().dependencies.find((item: { id: string }) => item.id === 'github').status,
      'unavailable',
    );

    const tree = await fixture.app.inject({
      method: 'GET',
      url: '/api/operations/git-tree',
      headers: { cookie },
    });
    assert.equal(tree.statusCode, 200);
    assert.equal(tree.json().commit, 'c'.repeat(40));
    assert.equal(tree.json().stale, true);
    assert.equal(tree.json().entries.length, 3);
  });
});

async function makeFixture(options: { repositoryStatus?: Partial<RepositoryStatusResponse> } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase8-api-'));
  cleanup.push(async () => rm(dataDirectory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDirectory,
    LUOWANG_ADMIN_PASSWORD: 'phase8-api-password!',
    LUOWANG_MASTER_KEY: 'phase8-api-master-key',
  });
  const database = initializeDatabase(config);
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateRepository({ repository: 'https://github.com/cynos-ai/cynos-website' });
  const runStore = createRunStore(database.sqlite, { now: () => '2026-08-30T02:00:00.000Z' });
  const runId = '01K00000000000000000000001';
  const reviewRunId = '01K00000000000000000000002';
  const activeRunId = '01K00000000000000000000003';
  runStore.importCompleted({
    runId,
    trigger: 'manual',
    request: '验证登录场景',
    baseCommit: 'a'.repeat(40),
    targetCommit: 'b'.repeat(40),
    includedCommits: ['b'.repeat(40)],
    result: 'failed',
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:10:00.000Z',
    completedDirectory: join(config.reportDir, 'completed', runId),
    artifacts: {
      'plan.md': 'safe plan',
      'execution.md': 'safe execution',
      'draft-report.md': 'safe draft',
      'review.md': 'safe review',
      'report.md': 'safe report',
    },
    scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'failed' }],
    confirmedBugs: [
      {
        key: 'BUG-21',
        title: '登录后刷新会话丢失',
        scenarioIds: ['AUTH-LOGIN-001'],
        issueAction: 'create',
        issueUrl: 'https://github.com/cynos-ai/cynos-website/issues/21',
      },
    ],
  });
  runStore.importCompleted({
    runId: reviewRunId,
    trigger: 'manual',
    request: '审核新场景',
    baseCommit: 'b'.repeat(40),
    targetCommit: 'c'.repeat(40),
    includedCommits: [],
    result: 'blocked',
    startedAt: '2026-08-30T01:00:00.000Z',
    finishedAt: '2026-08-30T01:05:00.000Z',
    completedDirectory: join(config.reportDir, 'completed', reviewRunId),
    artifacts: { 'scenario-changes.patch': 'patch', 'report.md': 'blocked report' },
    scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'blocked' }],
    confirmedBugs: [],
    specialRun: true,
  });
  database.sqlite
    .prepare(
      `UPDATE run_store_runs
       SET report_status = 'published', report_commit_sha = ?, archive_status = 'completed',
           scenario_status = 'pull_request', scenario_pr_url = ?, progressed = 0
       WHERE run_id = ?`,
    )
    .run('d'.repeat(40), 'https://github.com/cynos-ai/cynos-website/pull/8', reviewRunId);
  database.sqlite
    .prepare(
      `UPDATE run_store_runs
       SET report_status = 'published', report_commit_sha = ?, archive_status = 'completed',
           progressed = 1
       WHERE run_id = ?`,
    )
    .run('e'.repeat(40), runId);
  database.sqlite
    .prepare(
      `INSERT INTO run_store_progress (id, last_completed_target, run_id, updated_at)
       VALUES (1, ?, ?, ?)`,
    )
    .run('a'.repeat(40), runId, '2026-08-30T00:10:00.000Z');

  const scenarios: IndexedScenario[] = [
    {
      id: 'AUTH-LOGIN-001',
      path: 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      name: '登录状态恢复',
      description: '验证用户登录后刷新页面仍保持登录状态',
      status: 'approved',
      tags: ['core', 'flow:登录'],
      content: '<script>not executable</script>',
      commitSha: 'c'.repeat(40),
      indexedAt: '2026-08-30T01:10:00.000Z',
    },
  ];
  const reports: IndexedReport[] = [];
  const repository = fakeRepository(options.repositoryStatus);
  const indexer = fakeIndexer(scenarios, reports);
  const active: RunSummary = {
    runId: activeRunId,
    status: 'running',
    phase: 'runner',
    result: null,
    trigger: 'manual',
    request: '验证当前登录场景',
    baseCommit: 'a'.repeat(40),
    targetCommit: 'c'.repeat(40),
    includedCommits: ['b'.repeat(40)],
    startedAt: '2026-08-30T02:00:00.000Z',
    finishedAt: null,
    errorMessage: null,
    artifactNames: ['plan.md'],
    activities: [{ at: '2026-08-30T02:01:00.000Z', message: 'Runner 正在执行场景', kind: 'phase' }],
  };
  const runs = fakeRuns(active);
  const connectivity = fakeConnectivity();
  const recoveryStore = createRunRecoveryStore(database.sqlite);
  const automation = createAutomationService({
    database: database.sqlite,
    configuration,
    repository,
    indexer,
    runs,
    archiver: {
      archive: async () => {
        throw new Error('not used');
      },
      scan: async () => [],
      retry: async () => {
        throw new Error('not used');
      },
    },
    runStore,
    recoveryStore,
    reportDir: config.reportDir,
  });
  const app = await createApp({
    config,
    database,
    logger: pino({ level: 'silent' }),
    repository,
    indexer,
    runs,
    runStore,
    recoveryStore,
    automation,
    connectivity,
    backgroundTasks: false,
  });
  cleanup.push(async () => app.close());
  return { app, runId, reviewRunId, activeRunId };
}

function fakeRepository(overrides: Partial<RepositoryStatusResponse> = {}): RepositoryService {
  const history = [
    { sha: 'c'.repeat(40), authoredAt: '2026-08-30T01:00:00.000Z', subject: '场景审核' },
    { sha: 'b'.repeat(40), authoredAt: '2026-08-30T00:00:00.000Z', subject: '产品变更' },
    { sha: 'a'.repeat(40), authoredAt: '2026-08-29T23:00:00.000Z', subject: '基线' },
  ];
  const git = {
    history: async () => history,
    commitsBetween: async () => [{ sha: 'b'.repeat(40), paths: ['src/login.ts'] }],
  } as unknown as GitRepository;
  const status: RepositoryStatusResponse = {
    configured: true,
    availability: 'available',
    errorMessage: null,
    repository: 'https://github.com/cynos-ai/cynos-website',
    scenarioBranch: 'scenario-testing',
    localReady: true,
    remoteHead: 'c'.repeat(40),
    indexedCommit: 'c'.repeat(40),
    lastSyncedAt: '2026-08-30T01:10:00.000Z',
    indexErrors: [],
  };
  return {
    getStatus: async () => ({ ...status, ...overrides }),
    getRepository: async () => git,
  } as unknown as RepositoryService;
}

function fakeIndexer(scenarios: IndexedScenario[], reports: IndexedReport[]): RepositoryIndexer {
  return {
    sync: async () => ({
      status: 'synced',
      commitSha: 'c'.repeat(40),
      syncedAt: null,
      scenarios: 1,
      reports: 0,
      errors: [],
      message: 'ok',
    }),
    listScenarios: () => scenarios,
    getScenario: (id) => scenarios.find((scenario) => scenario.id === id) ?? null,
    listReports: () => reports,
    getReport: (id) => reports.find((report) => report.runId === id) ?? null,
    indexState: () => ({
      commitSha: 'c'.repeat(40),
      syncedAt: '2026-08-30T01:10:00.000Z',
      errors: [],
    }),
  };
}

function fakeRuns(active: RunSummary): RunOrchestrator {
  const detail: RunDetail = { ...active, artifacts: { 'plan.md': 'active plan' } };
  return {
    start: async () => active,
    run: async () => detail,
    wait: async () => detail,
    current: async () => active,
    list: async () => [active],
    get: async (runId) => (runId === active.runId ? detail : null),
    recover: async () => undefined,
  };
}

function fakeConnectivity(): ConnectivityRegistry {
  return {
    list: () => [
      {
        id: 'test-environment-url',
        label: '测试环境基础 URL',
        available: true,
        result: {
          status: 'ok',
          message: 'ok',
          checkedAt: '2026-08-30T01:00:00.000Z',
          latencyMs: 3,
        },
      },
    ],
    run: async (id) => ({
      id,
      label: id,
      available: true,
      result: { status: 'ok', message: 'ok', checkedAt: null, latencyMs: 1 },
    }),
  };
}

function firstCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
