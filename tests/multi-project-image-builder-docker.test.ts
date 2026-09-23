import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { it } from 'vitest';

import { buildProjectImage } from '../src/server/projects/image-builder.js';

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
    try {
      await mkdir(context);
      await writeFile(
        join(context, 'Dockerfile.luowang'),
        'FROM scratch\nCOPY marker.txt /marker.txt\n',
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
    } finally {
      if (imageId) await execFileAsync('docker', ['image', 'rm', '--force', imageId]);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
