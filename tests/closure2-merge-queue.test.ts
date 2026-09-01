import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, it } from 'vitest';

import { createAutomationService } from '../src/server/automation/service.js';
import { createTestRequestQueue } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db/client.js';
import { initializeDatabase, runMigrations } from '../src/server/db/migrate.js';
import { closureMergeQueueMigration } from '../src/server/db/migrations/0006-closure-merge-queue.js';
import { migrations } from '../src/server/db/migrations/index.js';
import { RepositoryError } from '../src/server/repository/errors.js';
import { GitRepository } from '../src/server/repository/git-repository.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import type { RunArchiver } from '../src/server/runs/archiver.js';
import type { RunOrchestrator } from '../src/server/runs/orchestrator.js';
import type { RunInput } from '../src/server/runs/types.js';
import { createRunId } from '../src/server/runs/workspace.js';
import type { RunDetail, RunSummary } from '../src/shared/types.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

const RUN_ID = '01K00000000000000000000001';

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Closure 2 merge queue migration', () => {
  it('migrates legacy pending and historical rows without treating target_ref as merge authority', async () => {
    const root = await temporaryDirectory('luowang-closure2-migration-');
    const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: root });
    const database = openDatabase(config);
    cleanup.push(async () => database.close());
    runMigrations(
      database.sqlite,
      migrations.filter((item) => item.version !== closureMergeQueueMigration.version),
    );

    insertLegacyQueue(database.sqlite, 1, 'git', 'queued', null, null);
    insertLegacyQueue(database.sqlite, 2, 'manual', 'queued', null, null);
    insertLegacyQueue(database.sqlite, 3, 'api', 'queued', 'feature', null);
    insertLegacyQueue(database.sqlite, 4, 'schedule', 'running', 'old-head', null);
    insertLegacyQueue(database.sqlite, 5, 'manual', 'running', null, null);
    insertLegacyQueue(database.sqlite, 6, 'manual', 'waiting_archive', null, null);
    insertLegacyQueue(database.sqlite, 7, 'manual', 'running', 'old-target', RUN_ID);
    insertLegacyQueue(database.sqlite, 8, 'api', 'completed', 'historic', null);
    database.sqlite
      .prepare(
        `INSERT INTO interrupted_run_records
         (run_id, trigger, request, base_commit, target_commit, included_commits_json,
          started_at, interrupted_at, running_directory, artifact_names_json, error_message,
          created_at, updated_at)
         VALUES (?, 'manual', 'existing run', NULL, ?, '[]', ?, ?, NULL, '[]', 'interrupted', ?, ?)`,
      )
      .run(RUN_ID, '7'.repeat(40), timestamp(), timestamp(), timestamp(), timestamp());

    closureMergeQueueMigration.apply(database.sqlite);
    closureMergeQueueMigration.apply(database.sqlite);
    const rows = database.sqlite
      .prepare(
        `SELECT queue_id, request_kind, source_ref, prepared_merge_commit,
                prepared_merge_mode, resolved_target_commit, status, target_ref, error_message
         FROM test_request_queue ORDER BY queue_id`,
      )
      .all() as Array<Record<string, unknown>>;

    assert.deepEqual(
      rows.map((row) => [row.queue_id, row.request_kind, row.status]),
      [
        [1, 'automatic-head', 'queued'],
        [2, 'manual-current-head', 'queued'],
        [3, 'manual-current-head', 'failed'],
        [4, 'automatic-head', 'queued'],
        [5, 'manual-current-head', 'queued'],
        [6, 'manual-current-head', 'failed'],
        [7, 'manual-current-head', 'running'],
        [8, 'manual-current-head', 'completed'],
      ],
    );
    assert.match(String(rows[2]?.error_message), /merge-source/);
    assert.match(String(rows[5]?.error_message), /缺少 Run ID/);
    assert.equal(rows[6]?.resolved_target_commit, '7'.repeat(40));
    assert.equal(rows[2]?.source_ref, null);
    assert.equal(rows[2]?.target_ref, 'feature');
    assert.equal(
      rows.every((row) => row.prepared_merge_commit === null),
      true,
    );
    assert.equal(
      rows.every((row) => row.prepared_merge_mode === null),
      true,
    );
  });
});

describe('Closure 2 queue contract', () => {
  it('keeps only automatic requests mergeable and rejects arbitrary target input', async () => {
    const context = await databaseContext();
    let id = 0;
    const queue = createTestRequestQueue(context.database.sqlite, {
      requestId: () => `closure2-${++id}`,
    });
    const automatic = queue.enqueue({
      request: 'git A',
      trigger: 'git',
      requestKind: 'automatic-head',
    });
    const merged = queue.enqueue({
      request: 'cron B',
      trigger: 'schedule',
      requestKind: 'automatic-head',
    });
    const firstManual = queue.enqueue({
      request: 'merge feature/a',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'feature/a',
      confirmed: true,
    });
    const secondManual = queue.enqueue({
      request: 'merge feature/a again',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'feature/a',
      confirmed: true,
    });

    assert.equal(merged.queueId, automatic.queueId);
    assert.notEqual(firstManual.queueId, secondManual.queueId);
    const tag = queue.enqueue({
      request: 'merge a tag',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'refs/tags/v1.2.3',
      confirmed: true,
    });
    const sha = queue.enqueue({
      request: 'merge a published SHA',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'a'.repeat(40),
      confirmed: true,
    });
    assert.equal(tag.sourceRef, 'refs/tags/v1.2.3');
    assert.equal(sha.sourceRef, 'a'.repeat(40));
    assert.equal(queue.list().length, 5);
    assert.throws(
      () =>
        queue.enqueue({
          request: 'unsafe',
          trigger: 'manual',
          targetCommit: 'a'.repeat(40),
        }),
      /不能指定任意 target/,
    );
    for (const sourceRef of [
      `github_pat_${'secret_material'}`,
      `ghp_${'secret'}`,
      `gho_${'secret'}`,
      `ghu_${'secret'}`,
      `ghs_${'secret'}`,
      `ghr_${'secret'}`,
      `sk-${'123456789012'}`,
      `AKIA${'1234567890ABCDEF'}`,
      'github.com/org/repo',
      'x-access-token@github.com/org/repo',
      'token@github.com/org/repo',
    ]) {
      assert.throws(
        () =>
          queue.enqueue({
            request: 'credential-like source',
            trigger: 'manual',
            requestKind: 'manual-merge-source',
            sourceRef,
            confirmed: true,
          }),
        /sourceRef 格式无效/,
      );
    }
    assert.throws(
      () =>
        queue.enqueue({
          request: 'unconfirmed',
          trigger: 'manual',
          requestKind: 'manual-merge-source',
          sourceRef: 'feature/a',
        }),
      /明确确认/,
    );
  });

  it('persists immutable prepared and resolved facts', async () => {
    const context = await databaseContext();
    const queue = createTestRequestQueue(context.database.sqlite);
    const item = queue.enqueue({
      request: 'merge',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'main',
      confirmed: true,
    });
    queue.claimNext();
    queue.markPrepared(item.queueId, 'a'.repeat(40), 'existing-branch');
    const resolved = queue.markResolved(item.queueId, 'a'.repeat(40));
    assert.equal(resolved.preparedMergeCommit, 'a'.repeat(40));
    assert.equal(resolved.resolvedTargetCommit, 'a'.repeat(40));
    assert.throws(
      () => queue.markResolved(item.queueId, 'b'.repeat(40)),
      /必须等于 prepared|target 已固定/,
    );
  });
});

describe('Closure 2 persistent Git prepared refs', () => {
  it('creates a missing scenario branch from the exact prepared source without pushing internal refs', async () => {
    const fixture = await gitFixture(false);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      11,
      true,
    );
    assert.equal(prepared.mode, 'initial-create');
    assert.equal(prepared.preparedCommit, fixture.mainHead);
    assert.equal(await fixture.repository.readInternalRef(11), fixture.mainHead);
    assert.equal(await fixture.repository.remoteBranchHead('scenario-testing'), null);

    await git(fixture.clone, ['gc', '--prune=now']);
    const published = await fixture.repository.publishPreparedMerge(
      'scenario-testing',
      11,
      prepared.preparedCommit,
      prepared.mode,
    );
    assert.equal(published, fixture.mainHead);
    assert.equal(await fixture.repository.remoteBranchHead('scenario-testing'), fixture.mainHead);
    assert.deepEqual(await remoteInternalRefs(fixture.remote), []);
    await fixture.repository.deleteInternalRef(11);
    await fixture.repository.deleteInternalRef(11);
    assert.equal(await fixture.repository.readInternalRef(11), null);
  });

  it('treats a remote descendant as an idempotent initial publish but rejects an unrelated competitor', async () => {
    const success = await gitFixture(false);
    const prepared = await success.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      12,
      true,
    );
    await success.repository.publishPreparedMerge(
      'scenario-testing',
      12,
      prepared.preparedCommit,
      prepared.mode,
    );
    const newer = await commitAndPush(success.author, 'scenario-testing', 'newer.txt', 'newer');
    assert.notEqual(newer, prepared.preparedCommit);
    assert.equal(
      await success.repository.publishPreparedMerge(
        'scenario-testing',
        12,
        prepared.preparedCommit,
        prepared.mode,
      ),
      prepared.preparedCommit,
    );
    assert.equal(await success.repository.remoteBranchHead('scenario-testing'), newer);

    const competition = await gitFixture(false);
    const losing = await competition.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      13,
      true,
    );
    const competitor = await createUnrelatedScenarioBranch(competition);
    await assert.rejects(
      competition.repository.publishPreparedMerge(
        'scenario-testing',
        13,
        losing.preparedCommit,
        losing.mode,
      ),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'SCENARIO_BRANCH_REMOTE_CHANGED',
    );
    assert.equal(await competition.repository.remoteBranchHead('scenario-testing'), competitor);
  });

  it('uses expected-empty CAS when a competitor creates an ancestor after the absence check', async () => {
    const fixture = await gitFixture(false);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      24,
      true,
    );
    const hookDirectory = join(fixture.clone, '.git', 'hooks');
    const hook = join(hookDirectory, 'pre-push');
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(
      hook,
      [
        '#!/bin/sh',
        `git --git-dir=${shellQuote(fixture.remote)} update-ref refs/heads/scenario-testing ${shellQuote(fixture.initialHead)}`,
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(hook, 0o700);

    await assert.rejects(
      fixture.repository.publishPreparedMerge(
        'scenario-testing',
        24,
        prepared.preparedCommit,
        prepared.mode,
      ),
      (error: unknown) => error instanceof RepositoryError && error.code === 'PUSH_REJECTED',
    );
    assert.equal(
      await fixture.repository.remoteBranchHead('scenario-testing'),
      fixture.initialHead,
    );
    assert.equal(await fixture.repository.readInternalRef(24), prepared.preparedCommit);
  });

  it('prepares and recovers one no-ff merge commit across cleanup and Git GC', async () => {
    const fixture = await gitFixture(true);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'feature',
      14,
      false,
    );
    assert.equal(prepared.mode, 'existing-branch');
    assert.equal(prepared.alreadyIncluded, false);
    assert.notEqual(prepared.preparedCommit, fixture.featureHead);
    assert.equal(await fixture.repository.readInternalRef(14), prepared.preparedCommit);

    await fixture.repository.cleanWorkspace();
    await git(fixture.clone, ['gc', '--prune=now']);
    assert.equal(
      await fixture.repository.publishPreparedMerge(
        'scenario-testing',
        14,
        prepared.preparedCommit,
        prepared.mode,
      ),
      prepared.preparedCommit,
    );
    assert.equal(
      await fixture.repository.remoteBranchHead('scenario-testing'),
      prepared.preparedCommit,
    );
    const parents = (
      await git(fixture.clone, ['show', '-s', '--format=%P', prepared.preparedCommit])
    )
      .trim()
      .split(/\s+/);
    assert.equal(parents.length, 2);
    assert.deepEqual(await remoteInternalRefs(fixture.remote), []);
  });

  it('resolves an advertised annotated tag to its remote commit', async () => {
    const fixture = await gitFixture(true);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'refs/tags/release-test',
      23,
      false,
    );
    assert.equal(prepared.sourceCommit, fixture.mainHead);
    await fixture.repository.publishPreparedMerge(
      'scenario-testing',
      23,
      prepared.preparedCommit,
      prepared.mode,
    );
  });

  it('rejects local/internal refs and unpublished local SHAs as merge sources without echoing them', async () => {
    const fixture = await gitFixture(true);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'feature',
      20,
      false,
    );
    const internalSource = 'refs/luowang/merge-requests/20';
    await assert.rejects(
      fixture.repository.prepareMergeRequest('scenario-testing', internalSource, 21, false),
      (error: unknown) =>
        error instanceof RepositoryError &&
        error.code === 'TARGET_INVALID' &&
        !error.message.includes(internalSource),
    );
    await assert.rejects(
      fixture.repository.prepareMergeRequest(
        'scenario-testing',
        prepared.preparedCommit,
        22,
        false,
      ),
      (error: unknown) =>
        error instanceof RepositoryError &&
        error.code === 'TARGET_INVALID' &&
        !error.message.includes(prepared.preparedCommit),
    );
    assert.equal(await fixture.repository.readInternalRef(21), null);
    assert.equal(await fixture.repository.readInternalRef(22), null);
  });

  it('rejects ordinary remote competition without rebuilding or force-pushing prepared', async () => {
    const fixture = await gitFixture(true);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'feature',
      18,
      false,
    );
    const competitor = await commitAndPush(
      fixture.author,
      'scenario-testing',
      'competitor.txt',
      'competitor',
    );
    await assert.rejects(
      fixture.repository.publishPreparedMerge(
        'scenario-testing',
        18,
        prepared.preparedCommit,
        prepared.mode,
      ),
      (error: unknown) => error instanceof RepositoryError && error.code === 'PUSH_REJECTED',
    );
    assert.equal(await fixture.repository.remoteBranchHead('scenario-testing'), competitor);
    assert.equal(await fixture.repository.readInternalRef(18), prepared.preparedCommit);
  });

  it('leaves no prepared ref when the no-ff merge conflicts', async () => {
    const fixture = await gitFixture(true);
    await commitAndPush(fixture.author, 'scenario-testing', 'base.txt', 'scenario version');
    await git(fixture.author, ['checkout', 'feature']);
    await writeAndCommit(fixture.author, 'base.txt', 'feature version', 'feature conflict');
    await git(fixture.author, ['push', 'origin', 'feature']);
    await assert.rejects(
      fixture.repository.prepareMergeRequest('scenario-testing', 'feature', 19, false),
      (error: unknown) => error instanceof RepositoryError && error.code === 'MERGE_CONFLICT',
    );
    assert.equal(await fixture.repository.readInternalRef(19), null);
  });

  it('accepts a remote-reachable 40-character SHA and uses the current head when already included', async () => {
    const fixture = await gitFixture(true);
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      fixture.initialHead,
      17,
      false,
    );
    assert.equal(prepared.sourceCommit, fixture.initialHead);
    assert.equal(prepared.alreadyIncluded, true);
    assert.equal(prepared.preparedCommit, fixture.initialHead);
    assert.equal(
      await fixture.repository.publishPreparedMerge(
        'scenario-testing',
        17,
        prepared.preparedCommit,
        prepared.mode,
      ),
      fixture.initialHead,
    );
  });

  it('does not regenerate prepared work when the internal ref is missing unless remote already contains it', async () => {
    const missing = await gitFixture(true);
    const prepared = await missing.repository.prepareMergeRequest(
      'scenario-testing',
      'feature',
      15,
      false,
    );
    await missing.repository.deleteInternalRef(15);
    await assert.rejects(
      missing.repository.publishPreparedMerge(
        'scenario-testing',
        15,
        prepared.preparedCommit,
        prepared.mode,
      ),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'MERGE_REQUEST_STATE_INVALID',
    );

    const pushed = await gitFixture(true);
    const published = await pushed.repository.prepareMergeRequest(
      'scenario-testing',
      'feature',
      16,
      false,
    );
    await pushed.repository.publishPreparedMerge(
      'scenario-testing',
      16,
      published.preparedCommit,
      published.mode,
    );
    await pushed.repository.deleteInternalRef(16);
    assert.equal(
      await pushed.repository.publishPreparedMerge(
        'scenario-testing',
        16,
        published.preparedCommit,
        published.mode,
      ),
      published.preparedCommit,
    );
  });
});

describe('Closure 2 automation integration', () => {
  it('creates no Run when the scenario branch is absent outside the initialization merge-source case', async () => {
    const fixture = await gitFixture(false);
    const context = await databaseContext();
    const fake = controllableRuns();
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration: createConfigurationStore(context.database.sqlite, {
        repoDir: context.config.repoDir,
        reportDir: context.config.reportDir,
      }),
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs: fake.runs,
      archiver: noopArchiver(),
      reportDir: context.config.reportDir,
    });

    const automatic = await automation.submitTestRequest({
      request: 'automatic without branch',
      trigger: 'git',
      requestKind: 'automatic-head',
    });
    const current = await automation.submitTestRequest({
      request: 'manual current without branch',
      trigger: 'manual',
      requestKind: 'manual-current-head',
    });
    const merge = await automation.submitTestRequest({
      request: 'merge without initialization',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'main',
      confirmed: true,
    });
    await waitFor(() => automation.getQueue(merge.queue.queueId)?.status === 'failed');

    assert.equal(automation.getQueue(automatic.queue.queueId)?.status, 'failed');
    assert.equal(automation.getQueue(current.queue.queueId)?.status, 'failed');
    assert.equal(automation.getQueue(merge.queue.queueId)?.status, 'failed');
    assert.equal(fake.started.length, 0);
    assert.equal(await fixture.repository.remoteBranchHead('scenario-testing'), null);
  });

  it('uses one FIFO request for first creation, one fixed initialization Run, and terminal ref cleanup', async () => {
    const fixture = await gitFixture(false);
    const context = await databaseContext();
    const configuration = createConfigurationStore(context.database.sqlite, {
      repoDir: context.config.repoDir,
      reportDir: context.config.reportDir,
    });
    const fake = controllableRuns();
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration,
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs: fake.runs,
      archiver: noopArchiver(),
      reportDir: context.config.reportDir,
    });

    const submission = await automation.submitTestRequest({
      request: '首次创建并初始化',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'main',
      confirmed: true,
      initialization: true,
    });
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0]?.targetCommit, fixture.mainHead);
    assert.equal(fake.started[0]?.initialization, true);
    assert.match(fake.started[0]?.runId ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
    const running = automation.getQueue(submission.queue.queueId);
    assert.equal(running?.preparedMergeCommit, fixture.mainHead);
    assert.equal(running?.resolvedTargetCommit, fixture.mainHead);
    assert.equal(running?.runId, fake.started[0]?.runId);
    assert.equal(
      await fixture.repository.readInternalRef(submission.queue.queueId),
      fixture.mainHead,
    );

    fake.finish(fake.started[0]?.runId as string);
    await waitForAsync(
      async () =>
        automation.getQueue(submission.queue.queueId)?.status === 'completed' &&
        (await fixture.repository.readInternalRef(submission.queue.queueId)) === null,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.started.length, 1);
  });

  it('recovers push-before-resolved from remote containment even after the internal ref is gone', async () => {
    const fixture = await gitFixture(false);
    const context = await databaseContext();
    const queue = createTestRequestQueue(context.database.sqlite);
    const item = queue.enqueue({
      request: 'recover published initialization',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'main',
      confirmed: true,
      initialization: true,
    });
    queue.claimNext();
    const prepared = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      item.queueId,
      true,
    );
    queue.markPrepared(item.queueId, prepared.preparedCommit, prepared.mode);
    await fixture.repository.publishPreparedMerge(
      'scenario-testing',
      item.queueId,
      prepared.preparedCommit,
      prepared.mode,
    );
    await fixture.repository.deleteInternalRef(item.queueId);
    const fake = controllableRuns();
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration: createConfigurationStore(context.database.sqlite, {
        repoDir: context.config.repoDir,
        reportDir: context.config.reportDir,
      }),
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs: fake.runs,
      archiver: noopArchiver(),
      queue,
      reportDir: context.config.reportDir,
    });

    await automation.recover();
    const recovered = automation.getQueue(item.queueId);
    assert.equal(recovered?.resolvedTargetCommit, prepared.preparedCommit);
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0]?.targetCommit, prepared.preparedCommit);
    assert.equal(fake.started[0]?.initialization, true);
  });

  it('keeps an already resolved target when the remote branch advances before Run creation', async () => {
    const fixture = await gitFixture(false);
    const initial = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      700,
      true,
    );
    await fixture.repository.publishPreparedMerge(
      'scenario-testing',
      700,
      initial.preparedCommit,
      initial.mode,
    );
    await fixture.repository.deleteInternalRef(700);
    const fixedTarget = await fixture.repository.remoteBranchHead('scenario-testing');
    const context = await databaseContext();
    const queue = createTestRequestQueue(context.database.sqlite);
    const item = queue.enqueue({
      request: 'fixed current head',
      trigger: 'manual',
      requestKind: 'manual-current-head',
    });
    queue.claimNext();
    queue.markResolved(item.queueId, fixedTarget as string);
    const newer = await commitAndPush(fixture.author, 'scenario-testing', 'later.txt', 'later');
    assert.notEqual(newer, fixedTarget);
    const fake = controllableRuns();
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration: createConfigurationStore(context.database.sqlite, {
        repoDir: context.config.repoDir,
        reportDir: context.config.reportDir,
      }),
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs: fake.runs,
      archiver: noopArchiver(),
      queue,
      reportDir: context.config.reportDir,
    });

    await automation.recover();
    assert.equal(fake.started.length, 1);
    assert.equal(fake.started[0]?.targetCommit, fixedTarget);
    assert.equal(automation.getQueue(item.queueId)?.resolvedTargetCommit, fixedTarget);
  });

  it('links the deterministic reserved Run after a start-before-link crash instead of creating a second Run', async () => {
    const fixture = await gitFixture(false);
    const initial = await fixture.repository.prepareMergeRequest(
      'scenario-testing',
      'main',
      800,
      true,
    );
    await fixture.repository.publishPreparedMerge(
      'scenario-testing',
      800,
      initial.preparedCommit,
      initial.mode,
    );
    await fixture.repository.deleteInternalRef(800);
    const context = await databaseContext();
    const queue = createTestRequestQueue(context.database.sqlite, {
      now: timestamp,
      requestId: () => 'reserved-run-request',
    });
    const item = queue.enqueue({
      request: 'recover reserved Run',
      trigger: 'manual',
      requestKind: 'manual-current-head',
    });
    queue.claimNext();
    queue.markResolved(item.queueId, initial.preparedCommit);
    const reservedRunId = reservedId(item.createdAt, item.requestId);
    let starts = 0;
    const interrupted: RunDetail = {
      runId: reservedRunId,
      status: 'interrupted',
      phase: 'interrupted',
      result: null,
      trigger: 'manual',
      request: item.request,
      baseCommit: null,
      targetCommit: initial.preparedCommit,
      includedCommits: [],
      startedAt: timestamp(),
      finishedAt: timestamp(),
      errorMessage: 'restart',
      artifactNames: [],
      artifacts: {},
    };
    const runs = {
      start: async () => {
        starts += 1;
        throw new Error('must not start a duplicate Run');
      },
      run: async () => interrupted,
      wait: async () => interrupted,
      current: async () => null,
      list: async () => [interrupted],
      get: async (runId: string) => (runId === reservedRunId ? interrupted : null),
      recover: async () => undefined,
    } as RunOrchestrator;
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration: createConfigurationStore(context.database.sqlite, {
        repoDir: context.config.repoDir,
        reportDir: context.config.reportDir,
      }),
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs,
      archiver: noopArchiver(),
      queue,
      reportDir: context.config.reportDir,
    });

    await automation.recover();
    assert.equal(starts, 0);
    assert.equal(automation.getQueue(item.queueId)?.runId, reservedRunId);
    assert.equal(automation.getQueue(item.queueId)?.status, 'interrupted');
  });

  it('fails a crash-gap internal ref without prepared instead of guessing a merge', async () => {
    const fixture = await gitFixture(false);
    const context = await databaseContext();
    const queue = createTestRequestQueue(context.database.sqlite);
    const item = queue.enqueue({
      request: 'crash gap',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef: 'main',
      confirmed: true,
      initialization: true,
    });
    queue.claimNext();
    await fixture.repository.prepareMergeRequest('scenario-testing', 'main', item.queueId, true);
    await fixture.repository.prepareMergeRequest('scenario-testing', 'main', 999, true);
    const automation = createAutomationService({
      database: context.database.sqlite,
      configuration: createConfigurationStore(context.database.sqlite, {
        repoDir: context.config.repoDir,
        reportDir: context.config.reportDir,
      }),
      repository: repositoryAdapter(fixture.repository, fixture.remote),
      runs: controllableRuns().runs,
      archiver: noopArchiver(),
      queue,
      reportDir: context.config.reportDir,
    });

    await automation.recover();
    assert.equal(automation.getQueue(item.queueId)?.status, 'failed');
    assert.match(automation.getQueue(item.queueId)?.errorMessage ?? '', /拒绝猜测或重做/);
    assert.equal(await fixture.repository.readInternalRef(item.queueId), null);
    assert.equal(await fixture.repository.readInternalRef(999), null);
    assert.equal(await fixture.repository.remoteBranchHead('scenario-testing'), null);
  });
});

function insertLegacyQueue(
  database: import('better-sqlite3').Database,
  queueId: number,
  trigger: 'git' | 'schedule' | 'manual' | 'api',
  status: string,
  targetRef: string | null,
  runId: string | null,
): void {
  database
    .prepare(
      `INSERT INTO test_request_queue
       (queue_id, request_id, trigger, request, target_ref, trigger_sources_json,
        request_ids_json, status, run_id, claimed_at, waiting_archive_at, completed_at,
        error_message, archive_status, progressed, created_at, updated_at, initialization)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 0)`,
    )
    .run(
      queueId,
      `legacy-${queueId}`,
      trigger,
      `legacy ${queueId}`,
      targetRef,
      JSON.stringify([trigger]),
      JSON.stringify([`legacy-${queueId}`]),
      status,
      runId,
      timestamp(),
      timestamp(),
    );
}

async function databaseContext() {
  const root = await temporaryDirectory('luowang-closure2-db-');
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: root,
    LUOWANG_REPO_DIR: join(root, 'repo'),
    LUOWANG_REPORT_DIR: join(root, 'report'),
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  return { config, database };
}

interface GitFixture {
  root: string;
  remote: string;
  author: string;
  clone: string;
  repository: GitRepository;
  initialHead: string;
  mainHead: string;
  featureHead: string;
}

async function gitFixture(withScenarioBranch: boolean): Promise<GitFixture> {
  const root = await temporaryDirectory('luowang-closure2-git-');
  const remote = join(root, 'remote.git');
  const author = join(root, 'author');
  const clone = join(root, 'managed');
  await git(root, ['init', '--bare', remote]);
  await git(root, ['clone', remote, author]);
  await git(author, ['config', 'user.name', 'Closure 2 Fixture']);
  await git(author, ['config', 'user.email', 'closure2@localhost']);
  await writeAndCommit(author, 'base.txt', 'base', 'base');
  await git(author, ['branch', '-M', 'main']);
  await git(author, ['push', '-u', 'origin', 'main']);
  const initialHead = await revParse(author, 'HEAD');
  if (withScenarioBranch) await git(author, ['push', 'origin', 'HEAD:refs/heads/scenario-testing']);

  await writeAndCommit(author, 'main.txt', 'main', 'main change');
  await git(author, ['push', 'origin', 'main']);
  const mainHead = await revParse(author, 'HEAD');
  await git(author, ['tag', '-a', 'release-test', '-m', 'release test', mainHead]);
  await git(author, ['push', 'origin', 'refs/tags/release-test']);
  await git(author, ['checkout', '-b', 'feature', initialHead]);
  await writeAndCommit(author, 'feature.txt', 'feature', 'feature change');
  await git(author, ['push', '-u', 'origin', 'feature']);
  const featureHead = await revParse(author, 'HEAD');
  await git(author, ['checkout', 'main']);

  return {
    root,
    remote,
    author,
    clone,
    repository: new GitRepository({ directory: clone, remoteUrl: remote }),
    initialHead,
    mainHead,
    featureHead,
  };
}

function repositoryAdapter(repository: GitRepository, remote: string): RepositoryService {
  return {
    getRepositoryUrl: () => remote,
    getScenarioBranch: () => 'scenario-testing',
    getRepository: async () => repository,
    prepareMergeRequest: (sourceRef, queueId, initialization) =>
      repository.prepareMergeRequest('scenario-testing', sourceRef, queueId, initialization),
    publishPreparedMerge: (queueId, commit, mode) =>
      repository.publishPreparedMerge('scenario-testing', queueId, commit, mode),
    isPublishedTarget: (commit) => repository.isPublishedOnBranch('scenario-testing', commit),
    readMergeRequestRef: (queueId) => repository.readInternalRef(queueId),
    listMergeRequestRefs: () => repository.listInternalMergeRequestIds(),
    cleanupMergeRequestRef: (queueId) => repository.deleteInternalRef(queueId),
  } as unknown as RepositoryService;
}

function controllableRuns(): {
  runs: RunOrchestrator;
  started: RunInput[];
  finish: (runId: string) => void;
} {
  const started: RunInput[] = [];
  const summaries = new Map<string, RunSummary>();
  const waiters = new Map<string, (detail: RunDetail) => void>();
  let active: RunSummary | null = null;
  const runs: RunOrchestrator = {
    start: async (input) => {
      started.push(input);
      const runId = input.runId ?? RUN_ID;
      const summary: RunSummary = {
        runId,
        status: 'running',
        phase: 'runner',
        result: null,
        trigger: input.trigger,
        request: input.request,
        baseCommit: null,
        targetCommit: input.targetCommit ?? null,
        includedCommits: [],
        startedAt: timestamp(),
        finishedAt: null,
        errorMessage: null,
        artifactNames: [],
        initialization: input.initialization,
      };
      summaries.set(runId, summary);
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
    finish(runId) {
      const summary = summaries.get(runId);
      const resolve = waiters.get(runId);
      if (!summary || !resolve) throw new Error(`Run is not waiting: ${runId}`);
      summary.status = 'completed';
      summary.phase = 'completed';
      summary.result = 'passed';
      summary.finishedAt = timestamp();
      active = null;
      resolve({ ...summary, artifacts: {} });
    },
  };
}

function noopArchiver(): RunArchiver {
  return {
    archive: async (runId) => ({
      runId,
      status: 'completed',
      reportStatus: 'published',
      reportCommitSha: null,
      issues: [],
      progressed: true,
      archiveStatus: 'completed',
      errorMessage: null,
      indexerTriggered: false,
    }),
    scan: async () => [],
    retry: async (runId) => noopArchiver().archive(runId),
  };
}

async function createUnrelatedScenarioBranch(fixture: GitFixture): Promise<string> {
  await git(fixture.author, ['checkout', '--orphan', 'competitor']);
  await git(fixture.author, ['rm', '-rf', '.']);
  await writeAndCommit(fixture.author, 'competitor.txt', 'competitor', 'competitor');
  await git(fixture.author, ['push', 'origin', 'HEAD:refs/heads/scenario-testing']);
  return revParse(fixture.author, 'HEAD');
}

async function commitAndPush(
  author: string,
  branch: string,
  path: string,
  content: string,
): Promise<string> {
  await git(author, ['fetch', 'origin']);
  await git(author, ['checkout', '-B', branch, `origin/${branch}`]);
  await writeAndCommit(author, path, content, content);
  await git(author, ['push', 'origin', branch]);
  return revParse(author, 'HEAD');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeAndCommit(
  directory: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(directory, path), `${content}\n`, 'utf8');
  await git(directory, ['add', '--', path]);
  await git(directory, ['commit', '-m', message]);
}

async function remoteInternalRefs(remote: string): Promise<string[]> {
  const output = await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/luowang/']);
  return output.split(/\r?\n/).filter(Boolean);
}

async function revParse(directory: string, ref: string): Promise<string> {
  return (await git(directory, ['rev-parse', ref])).trim().toLowerCase();
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  return waitForAsync(async () => predicate());
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

function reservedId(createdAt: string, requestId: string): string {
  return createRunId(
    Date.parse(createdAt),
    createHash('sha256').update(requestId).digest().subarray(0, 10),
  );
}

function timestamp(): string {
  return '2026-08-31T00:00:00.000Z';
}
