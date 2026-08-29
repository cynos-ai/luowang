import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { createRepositoryIndexer } from '../src/server/repository/indexer.js';
import { GitRepository } from '../src/server/repository/git-repository.js';
import { createRepositoryService } from '../src/server/repository/service.js';
import { createSecretStore } from '../src/server/security/secret-store.js';
import { initializeDatabase } from '../src/server/db/migrate.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 2 repository control', () => {
  it('creates a scenario branch, merges with --no-ff, avoids duplicate merges, and detects broken history', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });

    const initialHead = await repository.createScenarioBranch('scenario-testing', 'main');
    assert.equal(await repository.remoteBranchHead('scenario-testing'), initialHead);

    await git(['checkout', '-b', 'develop', 'main'], fixture.sourceDir);
    await writeFile(join(fixture.sourceDir, 'README.md'), 'developed product\n');
    await commitAndPush(fixture.sourceDir, 'develop product', 'develop');

    const merged = await repository.mergeNoFastForward('scenario-testing', 'develop', true);
    assert.equal(merged.alreadyIncluded, false);
    assert.ok(merged.mergeCommit);
    assert.equal(merged.scenarioBranchHead, await repository.remoteBranchHead('scenario-testing'));

    const repeated = await repository.mergeNoFastForward('scenario-testing', 'develop', true);
    assert.equal(repeated.alreadyIncluded, true);
    assert.equal(repeated.scenarioBranchHead, merged.scenarioBranchHead);

    await writeFile(join(fixture.cloneDir, 'untracked.txt'), 'temporary workspace data');
    await repository.checkoutTarget(merged.scenarioBranchHead);
    await assert.rejects(
      () => readFile(join(fixture.cloneDir, 'untracked.txt')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );

    await git(
      ['push', '--force', 'origin', `${initialHead}:refs/heads/scenario-testing`],
      fixture.sourceDir,
    );
    await assert.rejects(
      () => repository.assertAncestor(merged.scenarioBranchHead, initialHead),
      (error: unknown) => error instanceof Error && error.message.includes('历史已断裂'),
    );
  });

  it('cleans a conflicted merge without leaving a dirty worktree', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });
    await repository.createScenarioBranch('scenario-testing', 'main');

    const competingDir = join(fixture.rootDir, 'competing');
    await git(['clone', fixture.remoteDir, competingDir], fixture.rootDir);
    await git(['checkout', 'scenario-testing'], competingDir);
    await git(['config', 'user.name', 'LuoWang Test'], competingDir);
    await git(['config', 'user.email', 'luowang@example.test'], competingDir);
    await writeFile(join(competingDir, 'README.md'), 'scenario side\n');
    await git(['add', 'README.md'], competingDir);
    await git(['commit', '-m', 'scenario side'], competingDir);
    await git(['push', 'origin', 'scenario-testing'], competingDir);

    await git(['checkout', '-b', 'develop', 'main'], fixture.sourceDir);
    await writeFile(join(fixture.sourceDir, 'README.md'), 'source side\n');
    await commitAndPush(fixture.sourceDir, 'source side', 'develop');

    await assert.rejects(
      () => repository.mergeNoFastForward('scenario-testing', 'develop', true),
      (error: unknown) => error instanceof Error && error.message.includes('存在冲突'),
    );
    const status = (await git(['status', '--porcelain'], fixture.cloneDir)).stdout.trim();
    assert.equal(status, '');
  });

  it('atomically indexes valid scenes and reports, preserves valid cache on invalid files, and removes deleted files', async () => {
    const fixture = await createGitFixture();
    await git(['checkout', '-b', 'scenario-testing', 'main'], fixture.sourceDir);
    await mkdir(join(fixture.sourceDir, 'docs/scenario-testing/scenarios'), { recursive: true });
    await mkdir(join(fixture.sourceDir, 'docs/scenario-testing/reports/run-001'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'),
      validScenario('AUTH-LOGIN-001'),
    );
    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/reports/run-001/report.md'),
      validReport('run-001'),
    );
    await commitAndPush(fixture.sourceDir, 'add scenario facts', 'scenario-testing');

    const context = await createRepositoryContext(fixture);
    const first = await context.indexer.sync();
    assert.equal(first.status, 'synced');
    assert.equal(first.scenarios, 1);
    assert.equal(first.reports, 1);
    assert.equal(context.indexer.listScenarios()[0]?.id, 'AUTH-LOGIN-001');
    assert.deepEqual(Object.keys(context.indexer.getReport('run-001')?.files ?? []), ['report.md']);

    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/scenarios/DUPLICATE.md'),
      validScenario('AUTH-LOGIN-001'),
    );
    await mkdir(join(fixture.sourceDir, 'docs/scenario-testing/reports/run-002'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/reports/run-002/report.md'),
      validReport('run-002').replace('result: passed', 'result: unknown'),
    );
    await commitAndPush(fixture.sourceDir, 'add invalid facts', 'scenario-testing');

    const second = await context.indexer.sync();
    assert.equal(second.status, 'synced');
    assert.ok(second.errors.some((item) => item.path.endsWith('DUPLICATE.md')));
    assert.ok(second.errors.some((item) => item.path.endsWith('run-002/report.md')));
    assert.equal(context.indexer.listScenarios().length, 1);
    assert.ok(context.indexer.getReport('run-001'));
    assert.equal(context.indexer.getReport('run-002'), null);

    await git(
      [
        'rm',
        'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
        'docs/scenario-testing/scenarios/DUPLICATE.md',
      ],
      fixture.sourceDir,
    );
    await commitAndPush(fixture.sourceDir, 'remove scenario fact', 'scenario-testing');
    const third = await context.indexer.sync();
    assert.equal(third.scenarios, 0);
    assert.equal(context.indexer.listScenarios().length, 0);
  });

  it('exposes repository status, sync, scenarios, reports, and tree through authenticated API routes', async () => {
    const fixture = await createGitFixture();
    await git(['checkout', '-b', 'scenario-testing', 'main'], fixture.sourceDir);
    await mkdir(join(fixture.sourceDir, 'docs/scenario-testing/scenarios'), { recursive: true });
    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/scenarios/AUTH-REGISTER-001.md'),
      validScenario('AUTH-REGISTER-001'),
    );
    await commitAndPush(fixture.sourceDir, 'add API scenario', 'scenario-testing');

    const context = await createRepositoryContext(fixture, true);
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase2-api-password!' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = readCookie(login.headers['set-cookie']);
    const sync = await context.app.inject({
      method: 'POST',
      url: '/api/repository/sync',
      headers: { cookie },
    });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().scenarios, 1);
    const scenarios = await context.app.inject({
      method: 'GET',
      url: '/api/scenarios',
      headers: { cookie },
    });
    assert.equal(scenarios.statusCode, 200);
    assert.equal(scenarios.json().scenarios[0].id, 'AUTH-REGISTER-001');
    const status = await context.app.inject({
      method: 'GET',
      url: '/api/repository/status',
      headers: { cookie },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().remoteHead, sync.json().commitSha);
    const tree = await context.app.inject({
      method: 'GET',
      url: `/api/repository/tree?commit=${encodeURIComponent(sync.json().commitSha)}`,
      headers: { cookie },
    });
    assert.equal(tree.statusCode, 200);
    assert.ok(
      tree
        .json()
        .entries.some((entry: { path: string }) => entry.path.includes('AUTH-REGISTER-001')),
    );
  });

  it('keeps the previous complete cache when the scenario branch is rewritten', async () => {
    const fixture = await createGitFixture();
    await git(['checkout', '-b', 'scenario-testing', 'main'], fixture.sourceDir);
    await mkdir(join(fixture.sourceDir, 'docs/scenario-testing/scenarios'), { recursive: true });
    await writeFile(
      join(fixture.sourceDir, 'docs/scenario-testing/scenarios/AUTH-HISTORY-001.md'),
      validScenario('AUTH-HISTORY-001'),
    );
    await commitAndPush(fixture.sourceDir, 'add history scenario', 'scenario-testing');
    const context = await createRepositoryContext(fixture);
    const first = await context.indexer.sync();
    assert.equal(first.status, 'synced');
    const indexedCommit = context.indexer.indexState().commitSha;
    const mainHead = (await git(['rev-parse', 'main'], fixture.sourceDir)).stdout.trim();
    await git(
      ['push', '--force', 'origin', `${mainHead}:refs/heads/scenario-testing`],
      fixture.sourceDir,
    );

    const broken = await context.indexer.sync();
    assert.equal(broken.status, 'failed');
    assert.equal(context.indexer.indexState().commitSha, indexedCommit);
    assert.equal(context.indexer.listScenarios().length, 1);
  });
});

async function createGitFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase2-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Test'], sourceDir);
  await git(['config', 'user.email', 'luowang@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'initial product\n');
  await git(['add', 'README.md'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  return { rootDir, remoteDir, sourceDir, cloneDir };
}

async function createRepositoryContext(
  fixture: Awaited<ReturnType<typeof createGitFixture>>,
  withApp = false,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase2-data-'));
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: join(dataDir, 'repo'),
    LUOWANG_REPORT_DIR: join(dataDir, 'report'),
    LUOWANG_ADMIN_PASSWORD: withApp ? 'phase2-api-password!' : undefined,
    LUOWANG_MASTER_KEY: 'phase2-master-key-material',
  });
  const database = initializeDatabase(config);
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateRepository({
    repository: fixture.remoteDir,
    scenarioBranch: 'scenario-testing',
  });
  const secretStore = createSecretStore(database.sqlite, config.masterKey);
  const repository = createRepositoryService(database.sqlite, configuration, secretStore, {
    repoDir: config.repoDir,
    allowLocalRepository: true,
  });
  const indexer = createRepositoryIndexer(database.sqlite, repository);
  const app = withApp
    ? await createApp({
        config,
        database,
        configuration,
        secretStore,
        repository,
        indexer,
        logger: pino({ level: 'silent' }),
      })
    : undefined;
  if (app) cleanup.push(async () => app.close());
  if (!app) cleanup.push(async () => database.close());
  return { config, database, indexer, app: app as NonNullable<typeof app> };
}

async function commitAndPush(directory: string, message: string, branch: string) {
  await git(['add', '-A'], directory);
  await git(['commit', '-m', message], directory);
  await git(['push', 'origin', branch], directory);
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function validScenario(id: string): string {
  return `---
id: ${id}
name: 登录状态恢复
description: 验证用户登录后刷新页面仍保持登录状态
status: approved
tags:
  - core
  - module:认证
---

## 期望

用户刷新后仍然保持登录。
`;
}

function validReport(runId: string): string {
  return `---
run_id: ${runId}
trigger: manual
base_commit: null
target_commit: '0000000000000000000000000000000000000000'
included_commits: []
result: passed
started_at: 2026-08-30T00:00:00Z
finished_at: 2026-08-30T00:01:00Z
scenario_results: []
confirmed_bugs: []
---

# Report

No confirmed bugs.
`;
}

function readCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
