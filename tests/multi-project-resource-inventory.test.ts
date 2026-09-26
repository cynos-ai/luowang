import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import type { DockerRuntime } from '../src/server/projects/execution-container.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { inspectProjectResources } from '../src/server/projects/resource-inventory.js';
import { createProjectStore } from '../src/server/projects/store.js';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const RUN = '01K00000000000000000000001';
const CONTAINER = 'a'.repeat(64);
const READY = `sha256:${'b'.repeat(64)}`;
const ORPHAN = `sha256:${'c'.repeat(64)}`;
const DERIVED = `sha256:${'d'.repeat(64)}`;

it('previews owned containers and image references without calling destructive Docker commands', async () => {
  const database = new Database(':memory:');
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'test', id: () => INSTANCE });
  runMigrations(database, [projectIdentityMigration]);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  const { projectId } = createProjectStore(database).createVerified({
    displayName: 'A',
    repository: { githubRepositoryId: '1', owner: 'cynos-ai', name: 'a' },
  });
  const state = createProjectImageStateStore(database);
  const key = { projectId, targetCommit: 'e'.repeat(40), dockerfilePath: 'Dockerfile' };
  state.begin(key);
  state.ready(key, READY);
  const calls: string[][] = [];
  const docker: DockerRuntime = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'ps') return ok(CONTAINER);
      if (args[0] === 'inspect')
        return ok(
          JSON.stringify({
            Name: `/luowang-run-${RUN.toLowerCase()}`,
            Config: {
              Labels: {
                'luowang.instance-id': INSTANCE,
                'luowang.project-id': projectId,
                'luowang.run-id': RUN,
              },
            },
          }),
        );
      if (args[0] === 'image' && args[1] === 'ls')
        return ok(`${READY}\n${ORPHAN}\n${DERIVED}\n${ORPHAN}`);
      if (args[0] === 'image' && args[1] === 'inspect') {
        const imageId = args[4];
        const commit = imageId === ORPHAN ? 'c'.repeat(40) : 'd'.repeat(40);
        return ok(
          JSON.stringify({
            Config: {
              Labels: {
                'luowang.instance-id': INSTANCE,
                'luowang.project-id': projectId,
                'luowang.target-commit': commit,
              },
            },
            RepoTags: [
              imageId === DERIVED ? 'other:tag' : `luowang-project-${projectId}:${commit}`,
            ],
            Size: imageId === ORPHAN ? 1024 : 2048,
          }),
        );
      }
      throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
    },
  };
  try {
    const inventory = await inspectProjectResources(database, docker);
    assert.equal(inventory.instanceId, INSTANCE);
    assert.deepEqual(inventory.projects, [projectId]);
    assert.deepEqual(inventory.containers, [{ containerId: CONTAINER, projectId, runId: RUN }]);
    assert.deepEqual(
      inventory.images.map(({ imageId, disposition }) => [imageId, disposition]),
      [
        [READY, 'referenced'],
        [ORPHAN, 'restart-candidate'],
        [DERIVED, 'manual-review'],
      ],
    );
    assert.equal(inventory.candidateImageBytes, 1024);
    assert.equal(
      calls.some((args) => ['rm', 'prune'].includes(args[0]) || args[1] === 'rm'),
      false,
    );
  } finally {
    database.close();
  }
});

it('refuses to preview Docker resources that fail instance ownership checks', async () => {
  const database = new Database(':memory:');
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'test', id: () => INSTANCE });
  runMigrations(database, [projectIdentityMigration]);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  try {
    await assert.rejects(
      () =>
        inspectProjectResources(database, {
          async run(args) {
            if (args[0] === 'ps') return ok(CONTAINER);
            return ok(JSON.stringify({ Name: '/unrelated', Config: { Labels: {} } }));
          },
        }),
      /归属核验失败/,
    );
  } finally {
    database.close();
  }
});

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}
