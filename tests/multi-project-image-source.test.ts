import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, it } from 'vitest';

import { prepareProjectImageSource } from '../src/server/projects/image-source.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const execFileAsync = promisify(execFile);
const PROJECT_A = '00000000-0000-4000-8000-000000000001';
const PROJECT_B = '00000000-0000-4000-8000-000000000002';

describe('project execution image source', () => {
  it('stages the pinned tree in separate project roots, not the current checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-image-source-'));
    try {
      const repo = join(root, 'repo');
      await git(['init', '-b', 'main', repo], root);
      await git(['config', 'user.name', 'LuoWang Test'], repo);
      await git(['config', 'user.email', 'luowang@example.test'], repo);
      await writeFile(
        join(repo, 'Dockerfile.luowang'),
        'FROM scratch\nCOPY value.txt /value.txt\n',
      );
      await writeFile(join(repo, 'value.txt'), 'old');
      await git(['add', '.'], repo);
      await git(['commit', '-m', 'first'], repo);
      const first = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
      await writeFile(join(repo, 'value.txt'), 'new');
      await git(['add', '.'], repo);
      await git(['commit', '-m', 'second'], repo);
      const second = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
      const repository = new GitRepository({ directory: repo, remoteUrl: repo });
      const a = await prepareProjectImageSource({
        repository,
        projectId: PROJECT_A,
        targetCommit: first,
        dockerfilePath: 'Dockerfile.luowang',
        storageRoot: root,
      });
      const b = await prepareProjectImageSource({
        repository,
        projectId: PROJECT_B,
        targetCommit: second,
        dockerfilePath: 'Dockerfile.luowang',
        storageRoot: root,
      });
      try {
        assert.equal(a.targetCommit, first);
        assert.equal(b.targetCommit, second);
        assert.equal(await readFile(join(a.directory, 'value.txt'), 'utf8'), 'old');
        assert.equal(await readFile(join(b.directory, 'value.txt'), 'utf8'), 'new');
        assert.notEqual(a.directory, b.directory);
        assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'new');
      } finally {
        await a.cleanup();
        await b.cleanup();
      }
      await assert.rejects(
        () =>
          prepareProjectImageSource({
            repository,
            projectId: PROJECT_A,
            targetCommit: first,
            dockerfilePath: '../Dockerfile',
            storageRoot: root,
          }),
        /路径无效/,
      );
      await assert.rejects(
        () =>
          prepareProjectImageSource({
            repository,
            projectId: '../outside',
            targetCommit: first,
            dockerfilePath: 'Dockerfile.luowang',
            storageRoot: root,
          }),
        /项目或镜像目标提交无效/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a Dockerfile symlink and a build-context link outside the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-image-source-link-'));
    try {
      const repo = join(root, 'repo');
      await git(['init', '-b', 'main', repo], root);
      await git(['config', 'user.name', 'LuoWang Test'], repo);
      await git(['config', 'user.email', 'luowang@example.test'], repo);
      await writeFile(join(root, 'outside.txt'), 'outside');
      await writeFile(join(repo, 'Dockerfile.luowang'), 'FROM scratch\n');
      await symlink(join(root, 'outside.txt'), join(repo, 'escape'));
      await symlink('Dockerfile.luowang', join(repo, 'linked-Dockerfile'));
      await git(['add', '.'], repo);
      await git(['commit', '-m', 'links'], repo);
      const commit = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
      const repository = new GitRepository({ directory: repo, remoteUrl: repo });
      const input = {
        repository,
        projectId: PROJECT_A,
        targetCommit: commit,
        storageRoot: root,
      };
      await assert.rejects(
        () => prepareProjectImageSource({ ...input, dockerfilePath: 'linked-Dockerfile' }),
        /普通 Dockerfile/,
      );
      await assert.rejects(
        () => prepareProjectImageSource({ ...input, dockerfilePath: 'Dockerfile.luowang' }),
        /路径越界/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true });
  return { stdout: result.stdout };
}
