import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { it } from 'vitest';

import { buildProjectImage } from '../src/server/projects/image-builder.js';
import { startProjectCommandSession } from '../src/server/projects/execution-container.js';
import { inspectProjectImage } from '../src/server/projects/image-preparation.js';
import {
  BUILTIN_IMAGE_DEFINITION,
  prepareBuiltInProjectImageSource,
  prepareProjectImageSource,
} from '../src/server/projects/image-source.js';
import { prepareProjectRunSource } from '../src/server/projects/run-source.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const execFileAsync = promisify(execFile);
const dockerIt = process.env.LUOWANG_DOCKER_SMOKE === '1' ? it : it.skip;

dockerIt(
  'runs a real fixed-commit image against its validated Run scenario patch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-project-run-docker-'));
    const repo = join(root, 'repo');
    const projectId = randomUUID();
    const runId = '01K00000000000000000000002';
    const scenarioPath = 'docs/scenario-testing/scenarios/CHECK-001.md';
    let imageId: string | undefined;
    let builtInImageId: string | undefined;
    let containerId: string | undefined;
    try {
      await execFileAsync('git', ['init', '-b', 'main', repo], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 'LuoWang Test'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'luowang@example.test'], { cwd: repo });
      await mkdir(join(repo, 'docs/scenario-testing/scenarios'), { recursive: true });
      await writeFile(
        join(repo, 'Dockerfile.luowang'),
        'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\nWORKDIR /workspace\n',
      );
      await writeFile(
        join(repo, 'read-scenario.js'),
        "process.stdout.write(require('node:fs').readFileSync('docs/scenario-testing/scenarios/CHECK-001.md', 'utf8'));\n",
      );
      await writeFile(join(repo, scenarioPath), scenario('before'));
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'target'], { cwd: repo });
      const targetCommit = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })
      ).stdout.trim();
      await writeFile(join(repo, scenarioPath), scenario('after'));
      const patch = (await execFileAsync('git', ['diff', '--', scenarioPath], { cwd: repo }))
        .stdout;
      const repository = new GitRepository({ directory: repo, remoteUrl: repo });
      const imageSource = await prepareProjectImageSource({
        repository,
        projectId,
        targetCommit,
        dockerfilePath: 'Dockerfile.luowang',
        storageRoot: root,
      });
      const runSource = await prepareProjectRunSource({
        repository,
        projectId,
        runId,
        targetCommit,
        scenarioPatch: patch,
        storageRoot: root,
      });
      try {
        imageId = (await buildProjectImage({ projectId, source: imageSource })).imageId;
        const builtInSource = await prepareBuiltInProjectImageSource({
          repository,
          projectId,
          targetCommit,
          storageRoot: root,
        });
        try {
          builtInImageId = (await buildProjectImage({ projectId, source: builtInSource })).imageId;
          assert.equal(
            await inspectProjectImage({
              projectId,
              targetCommit,
              dockerfilePath: BUILTIN_IMAGE_DEFINITION,
              imageId: builtInImageId,
            }),
            true,
          );
        } finally {
          await builtInSource.cleanup();
        }
        const session = await startProjectCommandSession({
          projectId,
          runId,
          targetCommit,
          imageId,
          repositoryDirectory: repo,
          sourceRoot: root,
          runSource,
        });
        containerId = session.containerId;
        const result = await session.run('node read-scenario.js', {
          cwd: repo,
          runId,
          targetCommit,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.replaceAll('\r\n', '\n'), scenario('after'));
        await session.close();
        containerId = undefined;
      } finally {
        await imageSource.cleanup();
        await runSource.cleanup();
      }
    } finally {
      if (containerId) await execFileAsync('docker', ['rm', '--force', containerId]);
      if (builtInImageId) await execFileAsync('docker', ['image', 'rm', '--force', builtInImageId]);
      if (imageId) await execFileAsync('docker', ['image', 'rm', '--force', imageId]);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

function scenario(description: string): string {
  return `---\nid: CHECK-001\nname: Check\ndescription: ${description}\nstatus: approved\ntags: []\n---\n\nCheck.\n`;
}

dockerIt(
  'builds one real reusable project image and resolves its immutable ID',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-project-image-docker-'));
    const projectId = randomUUID();
    const context = join(root, 'projects', projectId, 'run-sources', 'source-smoke', 'context');
    const targetCommit = randomBytes(20).toString('hex');
    let imageId: string | undefined;
    let containerId: string | undefined;
    try {
      await mkdir(context, { recursive: true });
      await writeFile(
        join(context, 'Dockerfile.luowang'),
        'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\nWORKDIR /workspace\nCOPY marker.txt /workspace/marker.txt\n',
      );
      await writeFile(join(context, 'marker.txt'), targetCommit);
      await writeFile(
        join(context, 'marker.js'),
        "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'));\n",
      );
      const built = await buildProjectImage({
        projectId,
        source: {
          directory: context,
          dockerfilePath: 'Dockerfile.luowang',
          targetCommit,
          cleanup: async () => {},
        },
      });
      imageId = built.imageId;
      const inspected = await execFileAsync('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        built.tag,
      ]);
      assert.equal(inspected.stdout.trim(), imageId);
      await writeFile(join(context, 'marker.txt'), 'run-scenario-patch');
      const session = await startProjectCommandSession({
        projectId,
        runId: '01K00000000000000000000001',
        targetCommit,
        imageId,
        repositoryDirectory: context,
        sourceRoot: root,
        runSource: {
          directory: context,
          projectId,
          runId: '01K00000000000000000000001',
          targetCommit,
          scenarioPatchSha256: 'a'.repeat(64),
          cleanup: async () => {},
        },
      });
      containerId = session.containerId;
      const result = await session.run('node marker.js', {
        cwd: context,
        runId: '01K00000000000000000000001',
        targetCommit,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'run-scenario-patch');
      await session.close();
      await assert.rejects(
        () => execFileAsync('docker', ['container', 'inspect', containerId!]),
        /Command failed/,
      );
      containerId = undefined;
    } finally {
      if (containerId) await execFileAsync('docker', ['rm', '--force', containerId]);
      if (imageId) await execFileAsync('docker', ['image', 'rm', '--force', imageId]);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
