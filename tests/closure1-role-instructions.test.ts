import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, it } from 'vitest';

import {
  createRoleInstructionLoader,
  RoleInstructionError,
} from '../src/server/runs/role-instructions.js';
import type { AgentSessionKind } from '../src/server/runs/types.js';

const cleanup: Array<() => Promise<void>> = [];
const sourceDirectory = resolve('resources/agent-roles');

const expectedByKind: Record<AgentSessionKind, string[]> = {
  'main-planning': ['common', 'main-planning', 'code-understanding'],
  'runner-execution': ['common', 'runner-execution'],
  'reviewer-audit': ['common', 'reviewer-audit'],
  'main-finalization': ['common', 'main-finalization'],
};

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Closure 1 built-in role instructions', () => {
  it('loads only the fixed resources for each isolated Session kind', async () => {
    const loader = createRoleInstructionLoader({ applicationVersion: 'closure1-test' });
    for (const [kind, expectedIds] of Object.entries(expectedByKind) as Array<
      [AgentSessionKind, string[]]
    >) {
      const loaded = await loader.load(kind, false);
      assert.deepEqual(
        loaded.versions.map((item) => item.id),
        expectedIds,
      );
      assert.match(loaded.content, /luowang-role-id: common/);
      assert.equal(
        loaded.versions.every((item) => item.applicationVersion === 'closure1-test'),
        true,
      );
      assert.equal(
        loaded.versions.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)),
        true,
      );
      for (const other of Object.keys(expectedByKind).filter((id) => !expectedIds.includes(id))) {
        assert.doesNotMatch(loaded.content, new RegExp(`luowang-role-id: ${other}`));
      }
      assert.equal(
        loaded.content.includes('luowang-role-id: code-understanding;'),
        kind === 'main-planning',
      );
    }
  });

  it('adds initialization rules only to Main planning and finalization', async () => {
    const loader = createRoleInstructionLoader();
    for (const kind of Object.keys(expectedByKind) as AgentSessionKind[]) {
      const loaded = await loader.load(kind, true);
      const ids = loaded.versions.map((item) => item.id);
      assert.equal(ids.includes('code-understanding'), kind === 'main-planning');
      assert.equal(
        loaded.content.includes('luowang-role-id: code-understanding;'),
        kind === 'main-planning',
      );
      if (kind === 'main-planning' || kind === 'main-finalization') {
        assert.equal(ids.at(-1), 'scenario-initialization');
      } else {
        assert.equal(ids.includes('scenario-initialization'), false);
      }
    }
  });

  it('pins the current browser target contract for Runner recovery', async () => {
    const loaded = await createRoleInstructionLoader().load('runner-execution', false);
    assert.match(loaded.content, /browser_fill_form/);
    assert.match(loaded.content, /browser_type/);
    assert.match(loaded.content, /schema 的 `target` 参数/);
    assert.match(loaded.content, /不得传 `ref` 参数/);
    assert.match(loaded.content, /按当前工具 schema 修正后继续/);
  });

  it('keeps Reviewer applicability judgments attributed during finalization', async () => {
    const loaded = await createRoleInstructionLoader().load('main-finalization', false);
    assert.match(loaded.content, /期望适用性、范围解释和结论依据仍归 Reviewer/);
    assert.match(loaded.content, /不能声称 Reviewer 未作该判断/);
    assert.match(loaded.content, /不重新决定期望是否适用/);
    assert.match(loaded.content, /不得把“没有某类证据”改写为“证据列表为空”/);
    assert.match(loaded.content, /证据文件数量与类别须和 review\.md 的清单一致/);
    assert.match(loaded.content, /不得遗漏或反转“不代表、仅限、未验证、无法确认”等限定/);
    assert.match(loaded.content, /须先修正一致再调用 write_report/);
  });

  it('ignores ambient target, host and user resources outside the fixed allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-closure1-ambient-'));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const fixed = join(root, 'fixed');
    await cp(sourceDirectory, fixed, { recursive: true });
    for (const path of [
      join(root, 'target', '.pi', 'skills', 'evil', 'SKILL.md'),
      join(root, 'target', '.agents', 'skills', 'evil', 'SKILL.md'),
      join(root, 'target', 'AGENTS.md'),
      join(root, 'host-agent-dir', 'prompts', 'evil.md'),
      join(root, 'user-home', '.pi', 'context.md'),
    ]) {
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, 'AMBIENT_MARKER_MUST_NOT_LOAD\n');
    }

    const loaded = await createRoleInstructionLoader({ resourceDirectory: fixed }).load(
      'main-planning',
      false,
    );
    assert.doesNotMatch(loaded.content, /AMBIENT_MARKER_MUST_NOT_LOAD/);
    assert.deepEqual(
      loaded.versions.map((item) => item.id),
      ['common', 'main-planning', 'code-understanding'],
    );
  });

  it('records the exact built-in method bytes and updates their hash on a new revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-code-understanding-version-'));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    await cp(sourceDirectory, root, { recursive: true });
    const loader = createRoleInstructionLoader({
      resourceDirectory: root,
      applicationVersion: 'code-understanding-test',
    });
    const methodPath = join(root, 'code-understanding.md');
    const original = await readFile(methodPath, 'utf8');
    const first = await loader.load('main-planning', false);
    const version = first.versions.find((item) => item.id === 'code-understanding');
    assert.deepEqual(version, {
      id: 'code-understanding',
      formatVersion: '1',
      applicationVersion: 'code-understanding-test',
      sha256: createHash('sha256').update(original, 'utf8').digest('hex'),
    });
    const revised = original + '\nMethod revision fixture.\n';
    await writeFile(methodPath, revised);
    const second = await loader.load('main-planning', true);
    assert.equal(
      second.versions.find((item) => item.id === 'code-understanding')?.sha256,
      createHash('sha256').update(revised, 'utf8').digest('hex'),
    );
    assert.ok(second.content.includes(revised.trim()));
    assert.notEqual(
      second.versions.find((item) => item.id === 'code-understanding')?.sha256,
      version?.sha256,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an unreadable method without exposing paths',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'luowang-code-understanding-unreadable-'));
      const target = join(root, 'code-understanding.md');
      cleanup.push(async () => {
        await chmod(target, 0o600);
        await rm(root, { recursive: true, force: true });
      });
      await cp(sourceDirectory, root, { recursive: true });
      await chmod(target, 0o000);
      await assert.rejects(
        () => createRoleInstructionLoader({ resourceDirectory: root }).load('main-planning', false),
        (error: unknown) => {
          assert.ok(error instanceof RoleInstructionError);
          assert.equal(error.message, '内置角色指令缺失、为空或格式错误：code-understanding');
          return true;
        },
      );
    },
  );

  it.each(['runner-execution', 'main-planning'] as const)(
    'fails closed for invalid %s resources without exposing paths',
    async (kind) => {
      const resourceId = kind === 'main-planning' ? 'code-understanding' : kind;
      for (const mode of ['missing', 'empty', 'marker', 'symlink'] as const) {
        const root = await mkdtemp(join(tmpdir(), `luowang-closure1-${mode}-`));
        cleanup.push(async () => rm(root, { recursive: true, force: true }));
        await cp(sourceDirectory, root, { recursive: true });
        const target = join(root, `${resourceId}.md`);
        if (mode === 'missing') await rm(target);
        if (mode === 'empty') await writeFile(target, '\n');
        if (mode === 'marker') await writeFile(target, '# wrong role\n');
        if (mode === 'symlink') {
          await rm(target);
          // Windows file symlinks require Developer Mode or elevation. A directory
          // junction exercises the same lstat fail-closed boundary without either
          // requirement; POSIX keeps the narrower file-symlink fixture.
          await symlink(
            process.platform === 'win32'
              ? sourceDirectory
              : join(sourceDirectory, `${resourceId}.md`),
            target,
            process.platform === 'win32' ? 'junction' : 'file',
          );
        }

        await assert.rejects(
          () => createRoleInstructionLoader({ resourceDirectory: root }).load(kind, false),
          (error: unknown) => {
            assert.equal(error instanceof RoleInstructionError, true);
            assert.ok((error as Error).message.includes(resourceId));
            assert.equal((error as Error).message.includes(root), false);
            return true;
          },
        );
      }
    },
  );
});
