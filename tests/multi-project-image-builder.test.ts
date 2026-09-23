import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it } from 'vitest';

import { buildProjectImage, type DockerCommand } from '../src/server/projects/image-builder.js';
import type { ProjectImageSource } from '../src/server/projects/image-source.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const COMMIT = 'a'.repeat(40);

describe('project image builder', () => {
  it('builds from the staged context and records the immutable image ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-image-builder-'));
    try {
      const source = await createSource(root);
      let built = false;
      const docker: DockerCommand = {
        async run(args, options) {
          assert.equal(args[0], 'build');
          assert.equal(args[args.length - 1], source.directory);
          assert.equal(
            args[args.indexOf('--file') + 1],
            join(source.directory, 'Dockerfile.luowang'),
          );
          assert.equal(args[args.indexOf('--tag') + 1], `luowang-project-${PROJECT}:${COMMIT}`);
          assert.ok(args.includes(`luowang.project-id=${PROJECT}`));
          assert.ok(args.includes(`luowang.target-commit=${COMMIT}`));
          assert.equal(options.cwd, source.directory);
          await writeFile(args[args.indexOf('--iidfile') + 1], `sha256:${'b'.repeat(64)}\n`);
          built = true;
        },
      };
      const result = await buildProjectImage({ projectId: PROJECT, source }, docker);
      assert.equal(built, true);
      assert.deepEqual(result, {
        projectId: PROJECT,
        targetCommit: COMMIT,
        imageId: `sha256:${'b'.repeat(64)}`,
        tag: `luowang-project-${PROJECT}:${COMMIT}`,
      });
      await assert.rejects(() => readFile(join(root, 'image-id.txt')), /ENOENT/);
      await assert.rejects(
        () =>
          buildProjectImage(
            { projectId: PROJECT, source: { ...source, dockerfilePath: '../x' } },
            docker,
          ),
        /路径越界/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid image ID rather than recording an unverified tag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-image-builder-invalid-'));
    try {
      const source = await createSource(root);
      const docker: DockerCommand = {
        async run(args) {
          await writeFile(args[args.indexOf('--iidfile') + 1], 'mutable-tag');
        },
      };
      await assert.rejects(
        () => buildProjectImage({ projectId: PROJECT, source }, docker),
        /镜像 ID/,
      );
      await assert.rejects(() => readFile(join(root, 'image-id.txt')), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createSource(root: string): Promise<ProjectImageSource> {
  const directory = resolve(root, 'context');
  await mkdir(directory);
  await writeFile(join(directory, 'Dockerfile.luowang'), 'FROM scratch\n');
  return {
    directory,
    dockerfilePath: 'Dockerfile.luowang',
    targetCommit: COMMIT,
    cleanup: async () => {},
  };
}
