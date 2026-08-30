import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, it } from 'vitest';

import type { RepositoryIssue } from '../src/shared/types.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { RepositoryError } from '../src/server/repository/errors.js';
import { GitRepository, type ReportFileName } from '../src/server/repository/git-repository.js';
import { GitHubClient } from '../src/server/repository/github.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import { createRunArchiver } from '../src/server/runs/archiver.js';
import { createRunStore, type RunStore } from '../src/server/runs/store.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 5 archive and progress', () => {
  it('publishes a passed Run once, indexes it once, and advances on repeated scans', async () => {
    const context = await createArchiveContext();
    const runId = runIdAt(1);
    await writeCompletedRun(context.reportDir, runId, reportFor(runId, 'passed', []));

    const first = await context.archiver.archive(runId);
    const second = await context.archiver.archive(runId);
    const third = (await context.archiver.scan())[0];

    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(third?.status, 'completed');
    assert.equal(context.repository.publishCalls, 1);
    assert.equal(context.indexer.syncCalls, 1);
    assert.equal(first.progressed, true);
    assert.equal(context.store.getLastCompletedTarget(), 'a'.repeat(40));
    assert.equal(context.store.get(runId)?.archiveStatus, 'completed');
  });

  it('creates multiple confirmed Bug Issues and retries only failed items', async () => {
    const context = await createArchiveContext();
    const runId = runIdAt(2);
    const bugs = [
      { key: 'BUG-LOGIN-001', title: '登录状态丢失' },
      { key: 'BUG-REGISTER-002', title: '注册成功提示错误' },
    ];
    context.repository.failKeys.add(bugs[1]!.key);
    await writeCompletedRun(context.reportDir, runId, reportFor(runId, 'failed', bugs));

    const first = await context.archiver.archive(runId);
    assert.equal(first.status, 'partial');
    assert.equal(first.progressed, false);
    assert.deepEqual(
      first.issues.map((issue) => [issue.bugKey, issue.status]),
      [
        ['BUG-LOGIN-001', 'succeeded'],
        ['BUG-REGISTER-002', 'failed'],
      ],
    );
    assert.equal(context.repository.createdIssues.length, 1);
    assert.equal(context.repository.findCalls, 2);

    context.repository.failKeys.delete(bugs[1]!.key);
    const second = await context.archiver.retry(runId);
    assert.equal(second.status, 'completed');
    assert.equal(second.progressed, true);
    assert.equal(context.repository.createdIssues.length, 2);
    assert.equal(context.repository.findCalls, 3);
    assert.equal(
      context.store.get(runId)?.issues.every((issue) => issue.status === 'succeeded'),
      true,
    );
    assert.equal(context.store.getLastCompletedTarget(), 'a'.repeat(40));
    for (const created of context.repository.createdIssues) {
      assert.match(created.body, new RegExp(`luowang-run:${runId}`));
      assert.match(created.body, /luowang-bug:BUG-/);
    }
  });

  it('creates Issues for blocked Runs but never advances the completed target', async () => {
    const context = await createArchiveContext();
    const runId = runIdAt(3);
    await writeCompletedRun(
      context.reportDir,
      runId,
      reportFor(runId, 'blocked', [{ key: 'BUG-BLOCKED-001', title: '阻塞期间确认的问题' }]),
    );

    const result = await context.archiver.archive(runId);

    assert.equal(result.status, 'completed');
    assert.equal(result.issues[0]?.status, 'succeeded');
    assert.equal(result.progressed, false);
    assert.equal(context.store.getLastCompletedTarget(), null);
  });

  it('stores a scenario-review blocked Run without publishing it as a formal report', async () => {
    const context = await createArchiveContext();
    const runId = runIdAt(10);
    await writeCompletedRun(context.reportDir, runId, reportFor(runId, 'blocked', []));
    const directory = join(context.reportDir, 'completed', runId);
    await rm(join(directory, 'plan.md'));
    await rm(join(directory, 'execution.md'));
    await rm(join(directory, 'draft-report.md'));
    await rm(join(directory, 'review.md'));
    await writeFile(join(directory, 'scenario-changes.patch'), 'fixture patch\n');

    const result = await context.archiver.archive(runId);
    const stored = context.store.get(runId);

    assert.equal(result.status, 'completed');
    assert.equal(result.reportStatus, 'not_applicable');
    assert.equal(result.progressed, false);
    assert.equal(context.repository.publishCalls, 0);
    assert.equal(stored?.specialRun, true);
  });

  it('keeps a conflicting report untouched and does not create its Issues', async () => {
    const context = await createArchiveContext();
    const runId = runIdAt(4);
    const report = reportFor(runId, 'failed', [{ key: 'BUG-CONFLICT-001', title: '报告冲突问题' }]);
    await writeCompletedRun(context.reportDir, runId, report);
    context.repository.publishError = new RepositoryError(
      'REPORT_CONFLICT',
      '报告文件已存在且内容不同，拒绝覆盖',
      409,
    );

    const result = await context.archiver.archive(runId);
    const stored = context.store.get(runId);

    assert.equal(result.status, 'failed');
    assert.equal(result.reportStatus, 'conflict');
    assert.equal(result.progressed, false);
    assert.equal(context.repository.createdIssues.length, 0);
    assert.equal(stored?.archiveStatus, 'failed');
    assert.equal(stored?.issues[0]?.status, 'pending');
    assert.equal(
      await readFile(join(context.reportDir, 'completed', runId, 'report.md'), 'utf8'),
      report,
    );
  });

  it('validates linked Issues before checking existence and preserves the link fact', async () => {
    const context = await createArchiveContext();
    const invalidRun = runIdAt(5);
    await writeCompletedRun(
      context.reportDir,
      invalidRun,
      reportFor(invalidRun, 'blocked', [
        {
          key: 'BUG-LINK-INVALID',
          title: '无效关联',
          issueAction: 'link',
          issueUrl: 'https://example.test/not-an-issue',
        },
      ]),
    );
    const invalid = await context.archiver.archive(invalidRun);
    assert.equal(invalid.issues[0]?.status, 'failed');
    assert.equal(context.repository.getIssueCalls, 0);

    const validRun = runIdAt(6);
    await writeCompletedRun(
      context.reportDir,
      validRun,
      reportFor(validRun, 'failed', [
        {
          key: 'BUG-LINK-VALID',
          title: '已有问题',
          issueAction: 'link',
          issueUrl: 'https://github.com/cynos-ai/cynos-website/issues/42',
        },
      ]),
    );
    const valid = await context.archiver.archive(validRun);
    assert.equal(valid.issues[0]?.status, 'succeeded');
    assert.equal(valid.issues[0]?.issueUrl, 'https://github.com/cynos-ai/cynos-website/issues/42');
    assert.equal(valid.progressed, true);
    assert.equal(context.repository.getIssueCalls, 1);
  });

  it('does not let an older Run overwrite a newer progress fact', async () => {
    const context = await createArchiveContext();
    const older = runIdAt(7);
    const newer = runIdAt(8);
    await writeCompletedRun(
      context.reportDir,
      older,
      reportFor(older, 'passed', [], '2026-08-30T00:01:00Z'),
    );
    await writeCompletedRun(
      context.reportDir,
      newer,
      reportFor(newer, 'passed', [], '2026-08-30T00:02:00Z'),
    );

    const latest = await context.archiver.archive(newer);
    const old = await context.archiver.archive(older);

    assert.equal(latest.progressed, true);
    assert.equal(old.progressed, false);
    assert.equal(context.store.getLastCompletedTarget(), 'b'.repeat(40));
  });
});

describe('Phase 5 Git report publisher', () => {
  it('adds only the current Run report files, is idempotent, and refuses content conflicts', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });
    const runId = runIdAt(9);
    const files = reportFiles('archive fixture');

    const first = await repository.publishRunReports('scenario-testing', runId, files);
    const second = await repository.publishRunReports('scenario-testing', runId, files);
    assert.equal(first.status, 'published');
    assert.equal(second.status, 'already_published');
    assert.equal(first.commitSha, second.commitSha);
    assert.equal(
      await gitShow(
        fixture.remoteDir,
        `scenario-testing:docs/scenario-testing/reports/${runId}/report.md`,
      ),
      files['report.md'],
    );
    assert.equal(
      await gitShow(fixture.remoteDir, 'scenario-testing:README.md'),
      'fixture product\n',
    );

    await assert.rejects(
      () =>
        repository.publishRunReports('scenario-testing', runId, {
          ...files,
          'report.md': 'different\n',
        }),
      (error: unknown) => error instanceof RepositoryError && error.code === 'REPORT_CONFLICT',
    );
    assert.equal(
      await gitShow(
        fixture.remoteDir,
        `scenario-testing:docs/scenario-testing/reports/${runId}/report.md`,
      ),
      files['report.md'],
    );
    assert.equal((await git(['status', '--porcelain'], fixture.cloneDir)).stdout.trim(), '');
  }, 30_000);

  it('queries marked Issues, creates a marked Issue, and validates linked Issue URLs', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string; body: string | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ method, url, body });
      if (method === 'POST') {
        return new Response(
          JSON.stringify({
            number: 8,
            title: '新问题',
            state: 'open',
            html_url: 'https://github.com/cynos-ai/cynos-website/issues/8',
            created_at: '2026-08-30T00:00:00Z',
            updated_at: '2026-08-30T00:00:00Z',
            body,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/issues/42')) {
        return new Response(
          JSON.stringify({
            number: 42,
            title: '已有问题',
            state: 'open',
            html_url: 'https://github.com/cynos-ai/cynos-website/issues/42',
            created_at: '2026-08-30T00:00:00Z',
            updated_at: '2026-08-30T00:00:00Z',
            body: 'existing',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 7,
            title: '已归档问题',
            state: 'open',
            html_url: 'https://github.com/cynos-ai/cynos-website/issues/7',
            created_at: '2026-08-30T00:00:00Z',
            updated_at: '2026-08-30T00:00:00Z',
            body: 'luowang-run:RUN-1 luowang-bug:BUG-1',
          },
          {
            number: 6,
            title: 'Pull Request',
            state: 'open',
            html_url: 'https://github.com/cynos-ai/cynos-website/pull/6',
            pull_request: { url: 'https://api.github.com/pulls/6' },
            body: 'luowang-run:RUN-1 luowang-bug:BUG-1',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    try {
      const client = new GitHubClient({
        repositoryUrl: 'https://github.com/cynos-ai/cynos-website',
        apiBaseUrl: 'https://github.test',
        tokenProvider: () => 'token-not-recorded',
      });
      const matches = await client.findIssuesByMarkers(['luowang-run:RUN-1', 'luowang-bug:BUG-1']);
      assert.deepEqual(
        matches.map((issue) => issue.number),
        [7],
      );
      const created = await client.createIssue('新问题', 'luowang-run:RUN-2\nluowang-bug:BUG-2');
      assert.equal(created.number, 8);
      const linked = await client.getIssueByUrl(
        'https://github.com/cynos-ai/cynos-website/issues/42',
      );
      assert.equal(linked.number, 42);
      await assert.rejects(
        () => client.getIssueByUrl('https://github.com/cynos-ai/cynos-website/pull/6'),
        (error: unknown) => error instanceof RepositoryError && error.code === 'ISSUE_URL_INVALID',
      );
      assert.equal(
        requests.filter((request) => request.method === 'POST')[0]?.body,
        JSON.stringify({ title: '新问题', body: 'luowang-run:RUN-2\nluowang-bug:BUG-2' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

interface ArchiveContext {
  reportDir: string;
  store: RunStore;
  archiver: ReturnType<typeof createRunArchiver>;
  repository: ArchiveRepository;
  indexer: { syncCalls: number; sync: () => Promise<{ status: 'synced' }> };
}

class ArchiveRepository {
  publishCalls = 0;
  findCalls = 0;
  getIssueCalls = 0;
  readonly failKeys = new Set<string>();
  readonly createdIssues: Array<RepositoryIssue & { body: string }> = [];
  publishError: Error | undefined;

  getRepositoryUrl(): string {
    return 'https://github.com/cynos-ai/cynos-website';
  }

  async publishRunReports(runId: string, files: Record<ReportFileName, string>) {
    void runId;
    void files;
    this.publishCalls += 1;
    if (this.publishError) throw this.publishError;
    return {
      status: 'published' as const,
      commitSha: 'c'.repeat(40),
      scenarioBranchHead: 'c'.repeat(40),
    };
  }

  async findIssuesByMarkers(markers: readonly string[]): Promise<RepositoryIssue[]> {
    this.findCalls += 1;
    return this.createdIssues
      .filter((issue) => markers.every((marker) => issue.body.includes(marker)))
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      }));
  }

  async createIssue(title: string, body: string): Promise<RepositoryIssue> {
    const key = body.match(/luowang-bug:([^\r\n]+)/)?.[1] ?? '';
    if (this.failKeys.has(key)) throw new Error('fixture Issue failure');
    const issue: RepositoryIssue & { body: string } = {
      number: this.createdIssues.length + 1,
      title,
      state: 'open',
      url: `https://github.com/cynos-ai/cynos-website/issues/${this.createdIssues.length + 1}`,
      createdAt: '2026-08-30T00:00:00Z',
      updatedAt: '2026-08-30T00:00:00Z',
      body,
    };
    this.createdIssues.push(issue);
    return issue;
  }

  async getIssueByUrl(url: string): Promise<RepositoryIssue> {
    this.getIssueCalls += 1;
    return {
      number: Number(url.split('/').pop()),
      title: '已有 Issue',
      state: 'open',
      url,
      createdAt: '2026-08-30T00:00:00Z',
      updatedAt: '2026-08-30T00:00:00Z',
    };
  }
}

async function createArchiveContext(): Promise<ArchiveContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase5-data-'));
  const reportDir = join(dataDir, 'report');
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_REPO_DIR: join(dataDir, 'repo'),
  });
  const database = initializeDatabase(config);
  const store = createRunStore(database.sqlite, { now: () => '2026-08-30T00:10:00Z' });
  const repository = new ArchiveRepository();
  const indexer = {
    syncCalls: 0,
    sync: async () => {
      indexer.syncCalls += 1;
      return { status: 'synced' as const };
    },
  };
  const archiver = createRunArchiver({
    database: database.sqlite,
    reportDir,
    repository: repository as unknown as RepositoryService,
    indexer: indexer as never,
    runStore: store,
  });
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  cleanup.push(async () => database.close());
  return { reportDir, store, archiver, repository, indexer };
}

async function writeCompletedRun(reportDir: string, runId: string, report: string): Promise<void> {
  const directory = join(reportDir, 'completed', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'plan.md'), '# Plan\n');
  await writeFile(join(directory, 'execution.md'), '# Execution\n');
  await writeFile(join(directory, 'draft-report.md'), '# Draft\n');
  await writeFile(join(directory, 'review.md'), '# Review\n');
  await writeFile(join(directory, 'report.md'), report);
}

function reportFor(
  runId: string,
  result: 'passed' | 'failed' | 'blocked',
  bugs: Array<{
    key: string;
    title: string;
    issueAction?: 'create' | 'link';
    issueUrl?: string;
  }>,
  finishedAt = '2026-08-30T00:00:00Z',
): string {
  const scenario = result === 'passed' ? '[]' : `\n  - id: PHASE5-FIXTURE\n    result: ${result}`;
  const bugYaml = bugs.length
    ? `\n${bugs
        .map(
          (bug) =>
            `  - key: ${bug.key}\n    title: ${bug.title}\n    scenario_ids:\n      - PHASE5-FIXTURE\n    issue_action: ${bug.issueAction ?? 'create'}${bug.issueUrl ? `\n    issue_url: ${bug.issueUrl}` : ''}`,
        )
        .join('\n')}`
    : ' []';
  return `---
run_id: ${runId}
trigger: manual
base_commit: null
target_commit: ${result === 'passed' && runId === runIdAt(8) ? 'b'.repeat(40) : 'a'.repeat(40)}
included_commits: []
result: ${result}
started_at: 2026-08-30T00:00:00Z
finished_at: ${finishedAt}
scenario_results: ${scenario}
confirmed_bugs:${bugYaml}
---

# Report

Phase 5 fixture report.
`;
}

function reportFiles(body: string): Record<ReportFileName, string> {
  return {
    'draft-report.md': `# Draft\n\n${body}\n`,
    'review.md': `# Review\n\n${body}\n`,
    'report.md': `# Report\n\n${body}\n`,
  };
}

function runIdAt(index: number): string {
  return `01K000000000000000000000${index.toString().padStart(2, '0')}`;
}

async function createGitFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase5-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 5 Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase5@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'fixture product\n');
  await git(['add', 'README.md'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  await git(['checkout', '-b', 'scenario-testing', 'main'], sourceDir);
  await git(['push', '-u', 'origin', 'scenario-testing'], sourceDir);
  return { rootDir, remoteDir, sourceDir, cloneDir };
}

async function gitShow(directory: string, ref: string): Promise<string> {
  return (await git(['show', ref], directory)).stdout;
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
