import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { it } from 'vitest';

import { prepareProjectRunSource } from '../src/server/projects/run-source.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const execFileAsync = promisify(execFile);
const PROJECT = '00000000-0000-4000-8000-000000000001';
const RUN = '01K00000000000000000000001';
const SCENARIO = 'docs/scenario-testing/scenarios/CHECK-001.md';

it('exports the pinned commit plus this Run patch without modifying the repository checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-run-source-'));
  try {
    const repo = join(root, 'repo');
    await git(['init', '-b', 'main', repo], root);
    await git(['config', 'user.name', 'LuoWang Test'], repo);
    await git(['config', 'user.email', 'luowang@example.test'], repo);
    await mkdir(join(repo, 'docs/scenario-testing/scenarios'), { recursive: true });
    await writeFile(join(repo, 'value.txt'), 'fixed commit\n');
    await writeFile(join(repo, SCENARIO), scenario('old description'));
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'target'], repo);
    const targetCommit = (await git(['rev-parse', 'HEAD'], repo)).stdout.trim();
    await writeFile(join(repo, SCENARIO), scenario('new description'));
    const patch = (await git(['diff', '--', SCENARIO], repo)).stdout;
    await writeFile(join(repo, 'value.txt'), 'uncommitted checkout\n');

    const source = await prepareProjectRunSource({
      repository: new GitRepository({ directory: repo, remoteUrl: repo }),
      projectId: PROJECT,
      runId: RUN,
      targetCommit,
      scenarioPatch: patch,
      storageRoot: root,
    });
    try {
      assert.equal(source.targetCommit, targetCommit);
      assert.match(source.scenarioPatchSha256!, /^[0-9a-f]{64}$/);
      assert.equal(await readFile(join(source.directory, 'value.txt'), 'utf8'), 'fixed commit\n');
      assert.equal(
        await readFile(join(source.directory, SCENARIO), 'utf8'),
        scenario('new description'),
      );
      assert.equal(await readFile(join(repo, SCENARIO), 'utf8'), scenario('new description'));
      assert.equal(await readFile(join(repo, 'value.txt'), 'utf8'), 'uncommitted checkout\n');
    } finally {
      await source.cleanup();
    }

    await assert.rejects(
      () =>
        prepareProjectRunSource({
          repository: new GitRepository({ directory: repo, remoteUrl: repo }),
          projectId: PROJECT,
          runId: RUN,
          targetCommit,
          scenarioPatch: patch.replace('docs/scenario-testing/scenarios/', 'src/'),
          storageRoot: root,
        }),
      /场景路径越界|文件头与变更路径不一致/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function scenario(description: string): string {
  return `---\nid: CHECK-001\nname: Check\ndescription: ${description}\nstatus: approved\ntags: []\n---\n\nCheck.\n`;
}

async function git(args: string[], cwd: string): Promise<{ stdout: string }> {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true });
  return { stdout: result.stdout };
}
