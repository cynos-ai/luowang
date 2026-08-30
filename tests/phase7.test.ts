import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, it } from 'vitest';

import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { RepositoryError } from '../src/server/repository/errors.js';
import { GitRepository } from '../src/server/repository/git-repository.js';
import {
  validateScenarioPatchText,
  type ScenarioPatchValidation,
} from '../src/server/repository/scenario-patch.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import { createRunArchiver } from '../src/server/runs/archiver.js';
import { createRunStore, type RunStore } from '../src/server/runs/store.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 7 scenario patch lifecycle', () => {
  it('validates against the requested target and cleans the worktree on rejection', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });
    const patch = await createPatch(fixture, (directory) =>
      writeFile(
        join(directory, 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'),
        scenario('AUTH-LOGIN-001', '刷新后保持登录。'),
      ),
    );

    await repository.checkoutTarget(fixture.mainHead);
    const validation = await repository.validateScenarioPatch(fixture.scenarioHead, patch);
    assert.deepEqual(validation.modifiedPaths, [
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
    ]);
    assert.equal((await git(['status', '--porcelain'], fixture.cloneDir)).stdout.trim(), '');
    assert.equal(
      (await git(['rev-parse', 'HEAD'], fixture.cloneDir)).stdout.trim(),
      fixture.scenarioHead,
    );

    await assert.rejects(
      () => repository.applyScenarioPatch(fixture.scenarioHead, 'not a git patch'),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'SCENARIO_PATCH_INVALID',
    );
    assert.equal((await git(['status', '--porcelain'], fixture.cloneDir)).stdout.trim(), '');
  }, 30_000);

  it('publishes direct changes idempotently and supports stable-ID renames', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });
    const addPatch = await createPatch(fixture, async (directory) => {
      const path = join(directory, 'docs/scenario-testing/scenarios/AUTH-REGISTER-001.md');
      await writeFile(path, scenario('AUTH-REGISTER-001', '用户可以注册并进入登录页。'));
      await git(['add', '-N', path], directory);
    });
    const first = await repository.publishScenarioPatch(
      'scenario-testing',
      runIdAt(1),
      addPatch,
      'direct',
    );
    const second = await repository.publishScenarioPatch(
      'scenario-testing',
      runIdAt(1),
      addPatch,
      'direct',
    );
    assert.equal(first.status, 'published');
    assert.equal(second.status, 'already_published');
    assert.equal(first.commitSha, second.commitSha);
    assert.equal(
      await gitShow(
        fixture.remoteDir,
        'scenario-testing:docs/scenario-testing/scenarios/AUTH-REGISTER-001.md',
      ),
      scenario('AUTH-REGISTER-001', '用户可以注册并进入登录页。'),
    );

    const renamePatch = await createPatch(fixture, async (directory) => {
      await git(
        [
          'mv',
          'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
          'docs/scenario-testing/scenarios/AUTH-LOGIN-RENAMED.md',
        ],
        directory,
      );
    });
    const renamed = await repository.publishScenarioPatch(
      'scenario-testing',
      runIdAt(2),
      renamePatch,
      'direct',
    );
    assert.equal(renamed.status, 'published');
    assert.equal(
      await gitShow(
        fixture.remoteDir,
        'scenario-testing:docs/scenario-testing/scenarios/AUTH-LOGIN-RENAMED.md',
      ),
      scenario('AUTH-LOGIN-001', '用户刷新后仍然保持登录。'),
    );
    await assert.rejects(() =>
      gitShow(
        fixture.remoteDir,
        'scenario-testing:docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      ),
    );
  }, 30_000);

  it('rejects paths, file types, deletion and invalid resulting scenarios before publication', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });
    const outsidePatch = unifiedPatch('src/app.ts', 'src/app.ts', 'product');
    const deletePatch = `diff --git a/docs/scenario-testing/scenarios/AUTH-LOGIN-001.md b/docs/scenario-testing/scenarios/AUTH-LOGIN-001.md\ndeleted file mode 100644\nindex 0000000..0000000\n--- a/docs/scenario-testing/scenarios/AUTH-LOGIN-001.md\n+++ /dev/null\n`;
    const symlinkPatch = `diff --git a/docs/scenario-testing/scenarios/link.md b/docs/scenario-testing/scenarios/link.md\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/scenario-testing/scenarios/link.md\n@@ -0,0 +1 @@\n+/outside\n`;
    const submodulePatch = `diff --git a/docs/scenario-testing/scenarios/module.md b/docs/scenario-testing/scenarios/module.md\nnew file mode 160000\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/scenario-testing/scenarios/module.md\n@@ -0,0 +1 @@\n+1111111111111111111111111111111111111111\n`;
    const binaryPatch = `diff --git a/docs/scenario-testing/scenarios/image.md b/docs/scenario-testing/scenarios/image.md\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 1\nA0\n`;

    for (const invalid of [outsidePatch, deletePatch, symlinkPatch, submodulePatch, binaryPatch]) {
      assert.throws(
        () => validateScenarioPatchText(invalid),
        (error: unknown) =>
          error instanceof RepositoryError && error.code === 'SCENARIO_PATCH_INVALID',
      );
    }

    const invalidFrontmatter = await createPatch(fixture, async (directory) => {
      const path = join(directory, 'docs/scenario-testing/scenarios/INVALID.md');
      await writeFile(path, '---\nid: INVALID\nstatus: approved\n---\n');
      await git(['add', '-N', path], directory);
    });
    const duplicateId = await createPatch(fixture, async (directory) => {
      const path = join(directory, 'docs/scenario-testing/scenarios/DUPLICATE.md');
      await writeFile(path, scenario('AUTH-LOGIN-001', '重复稳定 ID。'));
      await git(['add', '-N', path], directory);
    });
    await assert.rejects(
      () => repository.validateScenarioPatch(fixture.scenarioHead, invalidFrontmatter),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'SCENARIO_PATCH_INVALID',
    );
    await assert.rejects(
      () => repository.validateScenarioPatch(fixture.scenarioHead, duplicateId),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'SCENARIO_PATCH_INVALID',
    );
    assert.equal((await git(['status', '--porcelain'], fixture.cloneDir)).stdout.trim(), '');
  }, 30_000);
});

describe('Phase 7 Run archiving boundaries', () => {
  it('distinguishes a normal five-file patch Run from the special two-file review Run', async () => {
    const context = await createArchiveContext();
    const normalRun = runIdAt(10);
    const normalPatch = unifiedPatch(
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'normal',
    );
    await writeCompletedRun(
      context.reportDir,
      normalRun,
      reportFor(normalRun, 'passed'),
      normalPatch,
    );
    context.store.importCompleted({
      runId: normalRun,
      trigger: 'manual',
      baseCommit: null,
      targetCommit: 'a'.repeat(40),
      includedCommits: [],
      result: 'passed',
      startedAt: '2026-08-30T00:00:00Z',
      finishedAt: '2026-08-30T00:01:00Z',
      completedDirectory: join(context.reportDir, 'completed', normalRun),
      artifacts: completedArtifacts(reportFor(normalRun, 'passed'), normalPatch),
      scenarioResults: [],
      confirmedBugs: [],
      scenarioMode: 'autonomous',
    });

    const normal = await context.archiver.archive(normalRun);
    assert.equal(normal.status, 'completed');
    assert.equal(normal.reportStatus, 'published');
    assert.equal(normal.scenarioStatus, 'published');
    assert.equal(normal.progressed, true);
    assert.deepEqual(context.repository.scenarioModes, ['direct']);
    assert.equal(context.repository.reportCalls, 1);

    const specialRun = runIdAt(11);
    const specialPatch = unifiedPatch(
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'special',
    );
    await writeSpecialRun(
      context.reportDir,
      specialRun,
      reportFor(specialRun, 'blocked'),
      specialPatch,
    );
    const special = await context.archiver.archive(specialRun);
    assert.equal(special.status, 'completed');
    assert.equal(special.reportStatus, 'not_applicable');
    assert.equal(special.scenarioStatus, 'pull_request');
    assert.equal(special.progressed, false);
    assert.equal(context.repository.reportCalls, 1);
    assert.deepEqual(context.repository.scenarioModes, ['direct', 'pull-request']);
  });

  it('sends add-only mixed changes and review-all changes to PR without creating a scenario Issue', async () => {
    const context = await createArchiveContext();
    const cases = [
      { index: 20, mode: 'add-only' as const, onlyAdds: false },
      { index: 21, mode: 'review-all' as const, onlyAdds: true },
    ];
    for (const item of cases) {
      const runId = runIdAt(item.index);
      const patch = unifiedPatch(
        'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
        'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
        `case-${item.index}`,
      );
      context.repository.nextPatch = {
        ...emptyPatchValidation(),
        onlyAdds: item.onlyAdds,
        modifiedPaths: item.onlyAdds ? [] : ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'],
        addedPaths: item.onlyAdds ? ['docs/scenario-testing/scenarios/NEW.md'] : [],
      };
      await writeCompletedRun(context.reportDir, runId, reportFor(runId, 'blocked'), patch);
      context.store.importCompleted({
        runId,
        trigger: 'manual',
        baseCommit: null,
        targetCommit: 'a'.repeat(40),
        includedCommits: [],
        result: 'blocked',
        startedAt: '2026-08-30T00:00:00Z',
        finishedAt: '2026-08-30T00:01:00Z',
        completedDirectory: join(context.reportDir, 'completed', runId),
        artifacts: completedArtifacts(reportFor(runId, 'blocked'), patch),
        scenarioResults: [],
        confirmedBugs: [],
        scenarioMode: item.mode,
      });
      const result = await context.archiver.archive(runId);
      assert.equal(result.scenarioStatus, 'pull_request');
      assert.equal(result.progressed, false);
    }
    assert.deepEqual(context.repository.scenarioModes.slice(-2), ['pull-request', 'pull-request']);
    assert.equal(context.repository.createdIssues, 0);
  });
});

interface GitFixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
  cloneDir: string;
  mainHead: string;
  scenarioHead: string;
}

interface ArchiveContext {
  reportDir: string;
  store: RunStore;
  archiver: ReturnType<typeof createRunArchiver>;
  repository: LifecycleRepository;
}

class LifecycleRepository {
  scenarioModes: Array<'direct' | 'pull-request'> = [];
  reportCalls = 0;
  createdIssues = 0;
  nextPatch: ScenarioPatchValidation | undefined;

  getRepositoryUrl(): string {
    return 'https://github.com/cynos-ai/cynos-website';
  }

  async validateScenarioPatch(): Promise<ScenarioPatchValidation> {
    return this.nextPatch ?? emptyPatchValidation();
  }

  async publishScenarioChanges(_runId: string, _patch: string, mode: 'direct' | 'pull-request') {
    this.scenarioModes.push(mode);
    return mode === 'direct'
      ? {
          status: 'published' as const,
          commitSha: 'b'.repeat(40),
          scenarioBranchHead: 'b'.repeat(40),
          scenarioPrUrl: null,
        }
      : {
          status: 'pull_request' as const,
          commitSha: 'c'.repeat(40),
          scenarioBranchHead: 'a'.repeat(40),
          scenarioPrUrl: `https://github.com/cynos-ai/cynos-website/pull/${this.scenarioModes.length}`,
        };
  }

  async publishRunReports() {
    this.reportCalls += 1;
    return {
      status: 'published' as const,
      commitSha: 'd'.repeat(40),
      scenarioBranchHead: 'd'.repeat(40),
    };
  }

  async findIssuesByMarkers() {
    return [];
  }

  async createIssue() {
    this.createdIssues += 1;
    throw new Error('scenario PR must not create an Issue');
  }

  async getIssueByUrl() {
    throw new Error('not used');
  }
}

async function createArchiveContext(): Promise<ArchiveContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase7-data-'));
  const reportDir = join(dataDir, 'report');
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_REPO_DIR: join(dataDir, 'repo'),
  });
  const database = initializeDatabase(config);
  const store = createRunStore(database.sqlite, { now: () => '2026-08-30T00:10:00Z' });
  const repository = new LifecycleRepository();
  const archiver = createRunArchiver({
    database: database.sqlite,
    reportDir,
    repository: repository as unknown as RepositoryService,
    runStore: store,
  });
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  cleanup.push(async () => database.close());
  return { reportDir, store, archiver, repository };
}

async function createGitFixture(): Promise<GitFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase7-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 7 Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase7@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'fixture product\n');
  await git(['add', 'README.md'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  await git(['checkout', '-b', 'scenario-testing', 'main'], sourceDir);
  await mkdir(join(sourceDir, 'docs/scenario-testing/scenarios'), { recursive: true });
  await writeFile(
    join(sourceDir, 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'),
    scenario('AUTH-LOGIN-001', '用户刷新后仍然保持登录。'),
  );
  await git(['add', 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'], sourceDir);
  await git(['commit', '-m', 'seed scenario'], sourceDir);
  await git(['push', '-u', 'origin', 'scenario-testing'], sourceDir);
  const mainHead = (await git(['rev-parse', 'main'], sourceDir)).stdout.trim();
  const scenarioHead = (await git(['rev-parse', 'scenario-testing'], sourceDir)).stdout.trim();
  return { rootDir, remoteDir, sourceDir, cloneDir, mainHead, scenarioHead };
}

async function createPatch(
  fixture: GitFixture,
  change: (directory: string) => Promise<void> | void,
): Promise<string> {
  const directory = join(fixture.rootDir, `patch-${Math.random().toString(16).slice(2)}`);
  await git(['clone', '--no-tags', fixture.remoteDir, directory], fixture.rootDir);
  await git(['checkout', 'scenario-testing'], directory);
  await change(directory);
  return (await git(['diff', 'HEAD', '--find-renames'], directory)).stdout;
}

async function writeCompletedRun(
  reportDir: string,
  runId: string,
  report: string,
  patch: string,
): Promise<void> {
  const directory = join(reportDir, 'completed', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'plan.md'), '# Plan\n');
  await writeFile(join(directory, 'execution.md'), '# Execution\n');
  await writeFile(join(directory, 'draft-report.md'), '# Draft\n');
  await writeFile(join(directory, 'review.md'), '# Review\n');
  await writeFile(join(directory, 'report.md'), report);
  await writeFile(join(directory, 'scenario-changes.patch'), patch);
}

async function writeSpecialRun(
  reportDir: string,
  runId: string,
  report: string,
  patch: string,
): Promise<void> {
  const directory = join(reportDir, 'completed', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.md'), report);
  await writeFile(join(directory, 'scenario-changes.patch'), patch);
}

function completedArtifacts(report: string, patch: string): Record<string, string> {
  return {
    'plan.md': '# Plan\n',
    'execution.md': '# Execution\n',
    'draft-report.md': '# Draft\n',
    'review.md': '# Review\n',
    'report.md': report,
    'scenario-changes.patch': patch,
  };
}

function reportFor(runId: string, result: 'passed' | 'blocked'): string {
  return `---
run_id: ${runId}
trigger: manual
base_commit: null
target_commit: ${'a'.repeat(40)}
included_commits: []
result: ${result}
started_at: 2026-08-30T00:00:00Z
finished_at: 2026-08-30T00:01:00Z
scenario_results: []
confirmed_bugs: []
---

# Report
`;
}

function scenario(id: string, description: string): string {
  return `---
id: ${id}
name: ${id} 场景
description: ${description}
status: approved
tags:
  - core
---

## 期望

${description}
`;
}

function unifiedPatch(oldPath: string, newPath: string, body: string): string {
  return `diff --git a/${oldPath} b/${newPath}
index 1111111..2222222 100644
--- a/${oldPath}
+++ b/${newPath}
@@ -1,1 +1,1 @@
-old
+${body}
`;
}

function emptyPatchValidation(): ScenarioPatchValidation {
  return {
    changes: [],
    changedPaths: ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'],
    addedPaths: [],
    modifiedPaths: ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'],
    renamedPaths: [],
    onlyAdds: false,
  };
}

function runIdAt(index: number): string {
  return `01K000000000000000000000${index.toString().padStart(2, '0')}`;
}

async function gitShow(directory: string, ref: string): Promise<string> {
  return (await git(['show', ref], directory)).stdout;
}

function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
