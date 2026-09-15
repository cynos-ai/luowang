import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  'main-planning': ['common', 'main-planning'],
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
    }
  });

  it('adds initialization rules only to Main planning and finalization', async () => {
    const loader = createRoleInstructionLoader();
    for (const kind of Object.keys(expectedByKind) as AgentSessionKind[]) {
      const loaded = await loader.load(kind, true);
      const ids = loaded.versions.map((item) => item.id);
      if (kind === 'main-planning' || kind === 'main-finalization') {
        assert.equal(ids.at(-1), 'scenario-initialization');
      } else {
        assert.equal(ids.includes('scenario-initialization'), false);
      }
    }
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
      ['common', 'main-planning'],
    );
  });

  it('fails closed for missing, empty or incorrectly marked resources without exposing paths', async () => {
    for (const mode of ['missing', 'empty', 'marker', 'symlink'] as const) {
      const root = await mkdtemp(join(tmpdir(), `luowang-closure1-${mode}-`));
      cleanup.push(async () => rm(root, { recursive: true, force: true }));
      await cp(sourceDirectory, root, { recursive: true });
      const target = join(root, 'runner-execution.md');
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
            : join(sourceDirectory, 'runner-execution.md'),
          target,
          process.platform === 'win32' ? 'junction' : 'file',
        );
      }

      await assert.rejects(
        () =>
          createRoleInstructionLoader({ resourceDirectory: root }).load('runner-execution', false),
        (error: unknown) => {
          assert.equal(error instanceof RoleInstructionError, true);
          assert.match((error as Error).message, /runner-execution/);
          assert.doesNotMatch((error as Error).message, new RegExp(root));
          return true;
        },
      );
    }
  });
});
