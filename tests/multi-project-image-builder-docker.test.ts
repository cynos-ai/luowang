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

const execFileAsync = promisify(execFile);
const dockerIt = process.env.LUOWANG_DOCKER_SMOKE === '1' ? it : it.skip;

dockerIt(
  'builds one real reusable project image and resolves its immutable ID',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-project-image-docker-'));
    const context = join(root, 'context');
    const projectId = randomUUID();
    const targetCommit = randomBytes(20).toString('hex');
    let imageId: string | undefined;
    let containerId: string | undefined;
    try {
      await mkdir(context);
      await writeFile(
        join(context, 'Dockerfile.luowang'),
        'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\nWORKDIR /workspace\nCOPY marker.txt /workspace/marker.txt\n',
      );
      await writeFile(join(context, 'marker.txt'), targetCommit);
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
      const session = await startProjectCommandSession({
        projectId,
        runId: '01K00000000000000000000001',
        targetCommit,
        imageId,
        repositoryDirectory: context,
      });
      containerId = session.containerId;
      const result = await session.run('node --version', {
        cwd: context,
        runId: '01K00000000000000000000001',
        targetCommit,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^v24\./);
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
