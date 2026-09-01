import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, it } from 'vitest';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { createRunRecoveryStore } from '../src/server/automation/recovery.js';
import {
  createIssueCandidateController,
  createRunHistoryTool,
} from '../src/server/runs/run-history.js';
import { createRunStore, type RunStore } from '../src/server/runs/store.js';
import type { RepositoryIssue, RunSummary } from '../src/shared/types.js';

const cleanup: Array<() => Promise<void>> = [];
const TARGET_A = 'a'.repeat(40);
const TARGET_B = 'b'.repeat(40);
const TARGET_C = 'c'.repeat(40);

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Closure 5 bounded history tools', () => {
  it('queries completed, special blocked, archive-failed, and interrupted Runs with stable limited summaries', async () => {
    const fixture = await historyFixture();
    const tool = createRunHistoryTool({
      runStore: fixture.runStore,
      recoveryStore: fixture.recoveryStore,
    });

    const recent = await invokeJson(tool, { limit: 100 });
    assert.equal(recent.status, 'ok');
    const runs = recent.runs as Array<Record<string, unknown>>;
    assert.deepEqual(
      runs.map((run) => run.runId),
      [
        '01K00000000000000000000004',
        '01K00000000000000000000003',
        '01K00000000000000000000002',
        '01K00000000000000000000001',
      ],
    );
    assert.equal(
      runs.find((run) => run.runId === '01K00000000000000000000002')?.specialBlocked,
      true,
    );
    assert.equal(
      runs.find((run) => run.runId === '01K00000000000000000000002')?.scenarioPrUrl,
      'https://github.com/example/app/pull/8',
    );
    assert.equal(
      runs.find((run) => run.runId === '01K00000000000000000000003')?.archiveStatus,
      'failed',
    );
    assert.equal(runs[0]?.status, 'interrupted');
    const serialized = JSON.stringify(recent);
    assert.doesNotMatch(serialized, /full secret artifact|request-secret|archive-secret/);
    assert.match(serialized, /REDACTED/);

    const byScenario = await invokeJson(tool, { scenarioId: 'AUTH-LOGIN-001' });
    assert.deepEqual(
      (byScenario.runs as Array<{ runId: string }>).map((run) => run.runId),
      ['01K00000000000000000000003', '01K00000000000000000000001'],
    );
    const byCommit = await invokeJson(tool, { commit: TARGET_B, limit: 1 });
    assert.equal(
      (byCommit.runs as Array<{ runId: string }>)[0]?.runId,
      '01K00000000000000000000004',
    );
    const byBug = await invokeJson(tool, { bugOrIssue: 'BUG-AUTH-001' });
    assert.deepEqual(
      (byBug.runs as Array<{ runId: string }>).map((run) => run.runId),
      ['01K00000000000000000000001'],
    );
    const empty = await invokeJson(tool, { scenarioId: 'NO-SUCH-001' });
    assert.equal(empty.status, 'empty');
  });

  it('matches Issue candidates by normalized title, exact bug key, and keyword count with stable ordering', async () => {
    const fixture = await historyFixture();
    const issues: RepositoryIssue[] = [
      issue(12, '登录 状态　丢失', '2026-09-01T03:00:00.000Z'),
      issue(13, 'Login timeout regression', '2026-09-01T04:00:00.000Z'),
      issue(14, 'Login regression', '2026-09-01T04:00:00.000Z'),
    ];
    const repository = { listIssues: async () => issues };

    const byBug = createIssueCandidateController(
      { runStore: fixture.runStore, repository },
      () => true,
    );
    const bugResult = await invokeJson(byBug.tool, { bug_key: ' bug-auth-001 ' });
    assert.equal(bugResult.status, 'ok');
    const bugCandidates = bugResult.candidates as Array<Record<string, unknown>>;
    assert.equal(bugCandidates[0]?.number, 12);
    assert.deepEqual(bugCandidates[0]?.matchReasons, ['exact_bug_key']);
    assert.deepEqual(
      (bugCandidates[0]?.relatedRuns as Array<{ runId: string }>).map((run) => run.runId),
      ['01K00000000000000000000001'],
    );
    assert.equal(byBug.coverageForBug('BUG-AUTH-001', '登录状态丢失'), 'covered');
    assert.equal(byBug.coverageForBug('BUG-OTHER-001', '其他问题'), 'none');

    const byTitle = createIssueCandidateController(
      { runStore: fixture.runStore, repository },
      () => true,
    );
    const titleResult = await invokeJson(byTitle.tool, { title: '  登录   状态 丢失  ' });
    assert.equal((titleResult.candidates as Array<Record<string, unknown>>)[0]?.number, 12);
    assert.deepEqual((titleResult.candidates as Array<Record<string, unknown>>)[0]?.matchReasons, [
      'exact_title',
    ]);

    const byKeywords = createIssueCandidateController(
      { runStore: fixture.runStore, repository },
      () => true,
    );
    const keywordResult = await invokeJson(byKeywords.tool, {
      keywords: ['LOGIN', ' timeout ', 'login'],
    });
    assert.deepEqual(
      (keywordResult.candidates as Array<{ number: number }>).map((candidate) => candidate.number),
      [13, 14],
    );
    assert.doesNotMatch(JSON.stringify(keywordResult), /full secret artifact|request-secret/);
  });

  it('enforces read-before-query, strict input, duplicate, retry, and ten-call budgets', async () => {
    const fixture = await historyFixture();
    let available = false;
    let repositoryCalls = 0;
    const unavailable = createIssueCandidateController(
      {
        runStore: fixture.runStore,
        repository: {
          listIssues: async () => {
            repositoryCalls += 1;
            throw new Error('credential-bearing dependency failure');
          },
        },
      },
      () => available,
    );
    const beforeRead = await invoke(unavailable.tool, { title: '登录问题' });
    assert.equal(beforeRead.details.error, true);
    available = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await invokeJson(unavailable.tool, { title: '登录问题' });
      assert.equal(result.status, 'unavailable');
      assert.doesNotMatch(JSON.stringify(result), /credential-bearing/);
    }
    assert.equal(repositoryCalls, 2);
    assert.equal(unavailable.coverageForBug('BUG-LOGIN-001', '登录问题'), 'gap');

    const invalid = createIssueCandidateController(
      { runStore: fixture.runStore, repository: { listIssues: async () => [] } },
      () => true,
    );
    for (const params of [
      {},
      { keywords: 'not-an-array' },
      { keywords: [] },
      { keywords: ['x'] },
      { title: 'x'.repeat(201) },
      { title: 'bad\ncontrol' },
      { title: `token=${'sensitive-value'}` },
      { limit: 101, title: 'valid title' },
    ]) {
      const result = await invoke(invalid.tool, params);
      assert.equal(result.details.error, true, JSON.stringify(params));
    }

    const budget = createIssueCandidateController(
      { runStore: fixture.runStore, repository: { listIssues: async () => [] } },
      () => true,
    );
    for (let index = 0; index < 10; index += 1) {
      const result = await invokeJson(budget.tool, { title: `unique title ${index}` });
      assert.equal(result.status, 'empty');
    }
    const exhausted = await invokeJson(budget.tool, { title: 'eleventh unique title' });
    assert.equal(exhausted.status, 'unavailable');
    assert.match(String(exhausted.message), /预算已耗尽/);
    assert.equal(budget.coverageForBug('BUG-11', 'eleventh unique title'), 'gap');

    const duplicate = createIssueCandidateController(
      { runStore: fixture.runStore, repository: { listIssues: async () => [] } },
      () => true,
    );
    assert.equal((await invokeJson(duplicate.tool, { title: 'same title' })).status, 'empty');
    const repeated = await invoke(duplicate.tool, { title: ' same   title ' });
    assert.equal(repeated.details.error, true);
  });

  it('distinguishes successful empty from unavailable dependencies', async () => {
    const fixture = await historyFixture();
    const empty = createIssueCandidateController(
      { runStore: fixture.runStore, repository: { listIssues: async () => [] } },
      () => true,
    );
    assert.deepEqual(await invokeJson(empty.tool, { title: 'nothing matches' }), {
      status: 'empty',
      candidates: [],
    });

    const missingStore = createIssueCandidateController(
      { repository: { listIssues: async () => [] } },
      () => true,
    );
    const unavailable = await invokeJson(missingStore.tool, { title: 'nothing matches' });
    assert.equal(unavailable.status, 'unavailable');
    assert.deepEqual(unavailable.candidates, []);
  });
});

async function historyFixture(): Promise<{
  runStore: RunStore;
  recoveryStore: ReturnType<typeof createRunRecoveryStore>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-closure5-'));
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: directory,
    LUOWANG_ADMIN_PASSWORD: 'closure5-fixture-password!',
    LUOWANG_MASTER_KEY: 'closure5-fixture-master-key',
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const runStore = createRunStore(database.sqlite, { now: () => '2026-09-01T05:00:00.000Z' });
  const recoveryStore = createRunRecoveryStore(database.sqlite, {
    now: () => '2026-09-01T05:00:00.000Z',
  });

  importRun(runStore, {
    runId: '01K00000000000000000000001',
    result: 'failed',
    targetCommit: TARGET_A,
    includedCommits: [],
    finishedAt: '2026-09-01T01:00:00.000Z',
    scenarios: [{ id: 'AUTH-LOGIN-001', result: 'failed' }],
    bugs: [
      {
        key: 'BUG-AUTH-001',
        title: '登录状态丢失',
        scenarioIds: ['AUTH-LOGIN-001'],
        issueAction: 'create',
      },
    ],
    request: `token=${'request-secret'}`,
  });
  runStore.markIssueAttempt('01K00000000000000000000001', 'BUG-AUTH-001', {
    status: 'succeeded',
    issueNumber: 12,
    issueUrl: 'https://github.com/example/app/issues/12',
  });

  importRun(runStore, {
    runId: '01K00000000000000000000002',
    result: 'blocked',
    targetCommit: TARGET_B,
    includedCommits: [],
    finishedAt: '2026-09-01T02:00:00.000Z',
    scenarios: [],
    bugs: [],
    specialRun: true,
  });
  runStore.markScenario('01K00000000000000000000002', {
    status: 'pull_request',
    scenarioPrUrl: 'https://github.com/example/app/pull/8',
  });

  importRun(runStore, {
    runId: '01K00000000000000000000003',
    result: 'passed',
    targetCommit: TARGET_C,
    includedCommits: [TARGET_B],
    finishedAt: '2026-09-01T03:00:00.000Z',
    scenarios: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
    bugs: [
      {
        key: 'BUG-AUTH-002',
        title: 'Login timeout regression',
        scenarioIds: ['AUTH-LOGIN-001'],
        issueAction: 'link',
        issueUrl: 'https://github.com/example/app/issues/13',
      },
    ],
  });
  runStore.markIssueAttempt('01K00000000000000000000003', 'BUG-AUTH-002', {
    status: 'succeeded',
    issueNumber: 13,
    issueUrl: 'https://github.com/example/app/issues/13',
  });
  runStore.markArchiveFailure('01K00000000000000000000003', `password=${'archive-secret'}`);

  const interrupted: RunSummary = {
    runId: '01K00000000000000000000004',
    status: 'interrupted',
    phase: 'interrupted',
    result: null,
    trigger: 'schedule',
    request: 'interrupted fixture',
    baseCommit: TARGET_B,
    targetCommit: TARGET_C,
    includedCommits: [],
    startedAt: '2026-09-01T03:30:00.000Z',
    finishedAt: '2026-09-01T04:00:00.000Z',
    errorMessage: 'process restarted',
    artifactNames: ['plan.md'],
  };
  recoveryStore.record(interrupted, { interruptedAt: interrupted.finishedAt ?? undefined });
  return { runStore, recoveryStore };
}

function importRun(
  store: RunStore,
  input: {
    runId: string;
    result: 'passed' | 'failed' | 'blocked';
    targetCommit: string;
    includedCommits: string[];
    finishedAt: string;
    scenarios: Array<{ id: string; result: 'passed' | 'failed' | 'blocked' }>;
    bugs: Array<{
      key: string;
      title: string;
      scenarioIds: string[];
      issueAction: 'create' | 'link';
      issueUrl?: string;
    }>;
    request?: string;
    specialRun?: boolean;
  },
): void {
  store.importCompleted({
    runId: input.runId,
    trigger: 'manual',
    request: input.request ?? 'fixture request',
    baseCommit: null,
    targetCommit: input.targetCommit,
    includedCommits: input.includedCommits,
    result: input.result,
    startedAt: input.finishedAt.replace(/:00\.000Z$/, ':00.000Z'),
    finishedAt: input.finishedAt,
    completedDirectory: `/tmp/${input.runId}`,
    artifacts: {
      'plan.md': 'full secret artifact',
      'execution.md': 'fixture execution',
      'draft-report.md': 'fixture draft',
      'review.md': 'fixture review',
      'report.md': 'fixture report',
      ...(input.specialRun ? { 'scenario-changes.patch': 'fixture patch' } : {}),
    },
    scenarioResults: input.scenarios,
    confirmedBugs: input.bugs,
    specialRun: input.specialRun,
  });
}

function issue(number: number, title: string, updatedAt: string): RepositoryIssue {
  return {
    number,
    title,
    state: 'open',
    url: `https://github.com/example/app/issues/${number}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
  };
}

async function invokeJson(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await invoke(tool, params);
  assert.notEqual(result.details.error, true, textOf(result));
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function invoke(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  return tool.execute(
    'closure5-tool',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

function textOf(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
}
