import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, it } from 'vitest';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import {
  assertScenarioResultsMatchPlan,
  ExecutionPlanError,
  parseExecutionScenarioPlan,
  validateExecutionScenarioPlan,
} from '../src/server/runs/execution-plan.js';
import { createTargetChangeEvidenceTools } from '../src/server/runs/change-evidence.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('scenario design quality execution contract', () => {
  it('uses only the explicit execution section and preserves order', () => {
    const plan = parseExecutionScenarioPlan(`
# Plan

正文提到 AUTH-SECOND-002，但不应选择它。

## execution_scenarios

- AUTH-FIRST-001
- AUTH-SECOND-002

## 依据

历史引用 AUTH-HISTORY-003 也不应选择。
`);
    assert.deepEqual(plan.scenarioIds, ['AUTH-FIRST-001', 'AUTH-SECOND-002']);
    validateExecutionScenarioPlan(plan, [
      { id: 'AUTH-FIRST-001', name: 'first', status: 'approved' },
      { id: 'AUTH-SECOND-002', name: 'second', status: 'approved' },
      { id: 'AUTH-DRAFT-004', name: 'draft', status: 'draft' },
      { id: 'AUTH-HISTORY-003', name: 'history', status: 'deprecated' },
    ]);
    assert.doesNotThrow(() =>
      assertScenarioResultsMatchPlan(
        plan,
        plan.scenarioIds.map((id) => ({ id })),
      ),
    );
  });

  it('rejects duplicate headings, IDs, unknown or non-approved IDs, and mismatched results', () => {
    assert.throws(
      () => parseExecutionScenarioPlan('## execution_scenarios\n- AUTH-A-001\n- AUTH-A-001\n'),
      ExecutionPlanError,
    );
    assert.throws(
      () =>
        parseExecutionScenarioPlan(
          '## execution_scenarios\n- AUTH-A-001\n\n## execution_scenarios\n- AUTH-B-002\n',
        ),
      ExecutionPlanError,
    );
    const plan = parseExecutionScenarioPlan('## execution_scenarios\n- AUTH-A-001\n');
    assert.throws(
      () =>
        validateExecutionScenarioPlan(plan, [{ id: 'AUTH-A-001', name: 'draft', status: 'draft' }]),
      /approved/,
    );
    assert.throws(() => assertScenarioResultsMatchPlan(plan, [{ id: 'AUTH-B-002' }]), /完整顺序/);
    assert.deepEqual(
      parseExecutionScenarioPlan(
        '## execution_scenarios\n\n无需场景测试：固定证据表明本批不影响产品行为。\n',
      ).scenarioIds,
      [],
    );
  });
});

describe('fixed target change evidence', () => {
  it('returns fixed add/modify/delete/rename facts and bounded text reads', async () => {
    const fixture = await createGitFixture();
    const repository = new GitRepository({
      directory: fixture.cloneDir,
      remoteUrl: fixture.remoteDir,
    });

    const changes = await repository.changedFiles(fixture.base, fixture.target);
    const byPath = new Map(changes.map((change) => [change.newPath ?? change.oldPath, change]));
    assert.equal(byPath.get('modified.txt')?.kind, 'modified');
    assert.equal(byPath.get('deleted.txt')?.kind, 'deleted');
    assert.equal(byPath.get('renamed-new.txt')?.kind, 'renamed');
    assert.equal(byPath.get('added.txt')?.kind, 'added');
    assert.equal(byPath.get('binary.bin')?.kind, 'added');
    assert.equal(byPath.get('symlink.txt')?.readable, undefined);

    assert.match(
      await repository.readTextDiff(fixture.base, fixture.target, 'modified.txt'),
      /\+new/,
    );
    assert.equal(
      (await repository.readTextFileAtCommit(fixture.base, 'deleted.txt')).content,
      'deleted before\n',
    );
    assert.equal(
      (await repository.readTextFileAtCommit(fixture.target, 'renamed-new.txt')).content,
      'rename survives\n',
    );
    await assert.rejects(
      () => repository.readTextFileAtCommit(fixture.target, 'binary.bin'),
      (error: unknown) => error instanceof Error && error.message.includes('不是可读文本'),
    );
    await assert.rejects(
      () => repository.readTextDiff(fixture.base, fixture.target, 'symlink.txt'),
      (error: unknown) => error instanceof Error && error.message.includes('普通文本文件'),
    );
    assert.deepEqual(await repository.changedFiles(fixture.target, fixture.target), []);

    await writeFile(join(fixture.sourceDir, 'later.txt'), 'remote moved after Run\n');
    await git(['add', 'later.txt'], fixture.sourceDir);
    await git(['commit', '-m', 'move remote head'], fixture.sourceDir);
    await git(['push', 'origin', 'main'], fixture.sourceDir);
    assert.deepEqual(
      await repository.changedFiles(fixture.base, fixture.target),
      changes,
      'moving remote HEAD must not change fixed base/target facts',
    );
  }, 20_000);

  it('distinguishes no baseline, stable pagination, and cursor scope errors', async () => {
    const descriptors = Array.from({ length: 101 }, (_, index) => ({
      oldPath: null,
      newPath: `src/file-${index}.ts`,
      kind: 'added' as const,
      oldMode: null,
      newMode: '100644',
      oldType: null,
      newType: 'blob' as const,
      readable: true,
    }));
    const tools = createTargetChangeEvidenceTools({
      baseCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      listChanges: async () => descriptors,
      readDiff: async () => ({ status: 'ok', content: 'x'.repeat(32 * 1024 + 3) }),
      readFile: async () => ({ status: 'ok', content: 'fixed' }),
    });
    const first = json(await invoke(tools, 'list_target_changes', {}));
    assert.equal(first.status, 'partial');
    assert.equal((first.changes as unknown[]).length, 100);
    const second = json(
      await invoke(tools, 'list_target_changes', { cursor: first.nextCursor as string }),
    );
    assert.equal(second.status, 'ok');
    assert.equal((second.changes as unknown[]).length, 1);
    const diff = json(await invoke(tools, 'read_target_diff', { path: 'src/file-0.ts' }));
    assert.equal(diff.status, 'partial');
    assert.equal(Buffer.byteLength(diff.content as string, 'utf8'), 32 * 1024);
    const wrongCursor = await invoke(tools, 'read_target_diff', {
      path: 'src/file-1.ts',
      cursor: diff.nextCursor as string,
    });
    assert.equal(wrongCursor.details.error, true);
    const invalidPath = await invoke(tools, 'read_target_diff', { path: '../outside.txt' });
    assert.equal(invalidPath.details.error, true);
    assert.equal(json(invalidPath).status, 'unavailable');

    const unavailable = createTargetChangeEvidenceTools({
      baseCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      listChanges: async () => {
        throw new Error('dependency unavailable');
      },
      readDiff: async () => ({ status: 'unavailable', reason: 'dependency unavailable' }),
      readFile: async () => ({ status: 'unavailable', reason: 'dependency unavailable' }),
    });
    const unavailableList = await invoke(unavailable, 'list_target_changes', {});
    assert.equal(unavailableList.details.error, true);
    assert.equal(json(unavailableList).status, 'unavailable');
    const unavailableFile = await invoke(unavailable, 'read_target_file_version', {
      version: 'target',
      path: 'src/file-0.ts',
    });
    assert.equal(unavailableFile.details.error, true);
    assert.equal(json(unavailableFile).status, 'unavailable');

    const noBaseline = createTargetChangeEvidenceTools({
      baseCommit: null,
      targetCommit: 'b'.repeat(40),
      listChanges: async () => {
        throw new Error('must not read changes without a baseline');
      },
      readDiff: async () => ({ status: 'no_baseline' }),
      readFile: async () => ({ status: 'no_baseline' }),
    });
    assert.equal(json(await invoke(noBaseline, 'list_target_changes', {})).status, 'no_baseline');
    assert.equal(
      json(await invoke(noBaseline, 'read_target_diff', { path: 'src/file-0.ts' })).status,
      'no_baseline',
    );
  });
});

interface Fixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
  cloneDir: string;
  base: string;
  target: string;
}

async function createGitFixture(): Promise<Fixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-sdq-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await git(['init', '--bare', remoteDir], rootDir);
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang SDQ Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-sdq@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'modified.txt'), 'old\n');
  await writeFile(join(sourceDir, 'deleted.txt'), 'deleted before\n');
  await writeFile(join(sourceDir, 'rename-old.txt'), 'rename survives\n');
  await git(['add', '-A'], sourceDir);
  await git(['commit', '-m', 'baseline'], sourceDir);
  const base = (await git(['rev-parse', 'HEAD'], sourceDir)).stdout.trim();

  await writeFile(join(sourceDir, 'modified.txt'), 'new\n');
  await rm(join(sourceDir, 'deleted.txt'));
  await git(['mv', 'rename-old.txt', 'renamed-new.txt'], sourceDir);
  await writeFile(join(sourceDir, 'added.txt'), 'added\n');
  await writeFile(join(sourceDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const linkPayload = join(sourceDir, 'link-payload.tmp');
  await writeFile(linkPayload, '/outside\n');
  const linkSha = (await git(['hash-object', '-w', linkPayload], sourceDir)).stdout.trim();
  await rm(linkPayload);
  await git(['add', '-A'], sourceDir);
  await git(['update-index', '--add', '--cacheinfo', `120000,${linkSha},symlink.txt`], sourceDir);
  await git(['update-index', '--add', '--cacheinfo', `160000,${base},submodule.txt`], sourceDir);
  await git(['commit', '-m', 'net changes'], sourceDir);
  const target = (await git(['rev-parse', 'HEAD'], sourceDir)).stdout.trim();
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  return { rootDir, remoteDir, sourceDir, cloneDir, base, target };
}

async function git(args: string[], cwd: string, input?: string) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function invoke(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute('sdq-test', params as never, undefined, undefined, {} as never) as Promise<
    AgentToolResult<Record<string, unknown>>
  >;
}

function json(result: AgentToolResult<Record<string, unknown>>): Record<string, unknown> {
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text) as Record<string, unknown>;
}
