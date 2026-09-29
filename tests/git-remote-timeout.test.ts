import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { it } from 'vitest';

import { GitCommandError } from '../src/server/repository/errors.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

it('bounds a stalled ls-remote, kills it, redacts diagnostics, and removes askpass files', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'luowang-git-timeout-test-'));
  const bin = join(root, 'bin');
  const repositoryPath = join(root, 'repo');
  const temporary = join(root, 'tmp');
  await mkdir(bin);
  await mkdir(repositoryPath);
  await mkdir(temporary);
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '.git\\n'
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  exec sleep 60
fi
exit 2
`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  const originalTemp = process.env.TEMP;
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  process.env.TEMP = temporary;
  const token = 'github_pat_timeout_secret_value';
  const remoteUrl = 'https://user:credential@example.test/private/repository.git';
  try {
    const repository = new GitRepository({
      directory: repositoryPath,
      remoteUrl,
      tokenProvider: () => token,
      timeouts: { localMs: 1_000, remoteReadMs: 50, transferMs: 2_000 },
    });
    const startedAt = Date.now();
    let failure: GitCommandError | null = null;
    try {
      await repository.remoteBranchHead('scenario-testing');
    } catch (error) {
      assert.ok(error instanceof GitCommandError);
      failure = error;
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(failure);
    assert.equal(failure.message, 'Git 远程检查超时');
    assert.equal(failure.exitCode, null);
    assert.ok(elapsed < 1_000, `远程检查耗时 ${elapsed}ms`);
    const serialized = JSON.stringify({
      message: failure.message,
      command: failure.command,
      stderr: failure.stderr,
    });
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('credential'), false);
    assert.equal(serialized.includes(repositoryPath), false);
    assert.equal(serialized.includes(remoteUrl), false);
    assert.deepEqual(
      (await readdir(temporary)).filter((name) => name.startsWith('luowang-askpass-')),
      [],
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = originalTemp;
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects invalid timeout injection instead of creating an unbounded command', () => {
  assert.throws(
    () =>
      new GitRepository({
        directory: '.',
        remoteUrl: 'https://example.test/repository.git',
        timeouts: { remoteReadMs: 0 },
      }),
    /Git 命令超时配置无效/,
  );
});
