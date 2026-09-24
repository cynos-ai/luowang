import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import { recoverProjectDockerResources } from '../src/server/projects/docker-recovery.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createProjectStore } from '../src/server/projects/store.js';
import type { DockerRuntime } from '../src/server/projects/execution-container.js';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const RUN = '01K00000000000000000000001';
const CONTAINER = 'a'.repeat(64);
const READY = `sha256:${'b'.repeat(64)}`;
const ORPHAN = `sha256:${'c'.repeat(64)}`;
const BUSY = `sha256:${'d'.repeat(64)}`;
const DERIVED = `sha256:${'f'.repeat(64)}`;
const orphanTag = (projectId: string) => `luowang-project-${projectId}:${'c'.repeat(40)}`;
const busyTag = (projectId: string) => `luowang-project-${projectId}:${'d'.repeat(40)}`;

function fixture() {
  const database = new Database(':memory:');
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'test', id: () => INSTANCE });
  runMigrations(database, [projectIdentityMigration]);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  const project = createProjectStore(database).createVerified({
    displayName: 'A',
    repository: { githubRepositoryId: '1', owner: 'cynos-ai', name: 'a' },
  });
  const state = createProjectImageStateStore(database);
  const key = {
    projectId: project.projectId,
    targetCommit: 'e'.repeat(40),
    dockerfilePath: 'Dockerfile',
  };
  state.begin(key);
  state.ready(key, READY);
  return { database, projectId: project.projectId };
}

it('removes only verified own orphan containers and unreferenced images before queue recovery', async () => {
  const { database, projectId } = fixture();
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
        return ok(`${READY}\n${ORPHAN}\n${BUSY}\n${DERIVED}\n${ORPHAN}`);
      if (args[0] === 'image' && args[1] === 'inspect')
        return ok(
          JSON.stringify({
            Config: {
              Labels: {
                'luowang.instance-id': INSTANCE,
                'luowang.project-id': projectId,
                'luowang.target-commit': args[4] === ORPHAN ? 'c'.repeat(40) : 'd'.repeat(40),
              },
            },
            RepoTags: [
              args[4] === DERIVED
                ? 'other:tag'
                : args[4] === ORPHAN
                  ? orphanTag(projectId)
                  : busyTag(projectId),
            ],
          }),
        );
      if (args[0] === 'image' && args[1] === 'rm' && args[2] === BUSY)
        return { stdout: '', stderr: 'in use', exitCode: 1 };
      return ok('');
    },
  };
  try {
    assert.deepEqual(await recoverProjectDockerResources(database, docker), {
      removedContainers: 1,
      removedImages: 1,
      retainedImages: 3,
    });
    assert.deepEqual(
      calls.filter((args) => args[0] === 'rm'),
      [['rm', '--force', CONTAINER]],
    );
    assert.deepEqual(
      calls.filter((args) => args[0] === 'image' && args[1] === 'rm').map((args) => args[2]),
      [ORPHAN, BUSY],
    );
    assert.ok(calls[0].includes(`label=luowang.instance-id=${INSTANCE}`));
  } finally {
    database.close();
  }
});

it('stops without deleting a container whose identity does not match its Run', async () => {
  const { database, projectId } = fixture();
  const calls: string[][] = [];
  try {
    await assert.rejects(
      () =>
        recoverProjectDockerResources(database, {
          async run(args) {
            calls.push(args);
            if (args[0] === 'ps') return ok(CONTAINER);
            if (args[0] === 'inspect')
              return ok(
                JSON.stringify({
                  Name: '/unrelated',
                  Config: {
                    Labels: {
                      'luowang.instance-id': INSTANCE,
                      'luowang.project-id': projectId,
                      'luowang.run-id': RUN,
                    },
                  },
                }),
              );
            return ok('');
          },
        }),
      /归属核验失败/,
    );
    assert.equal(
      calls.some((args) => args[0] === 'rm'),
      false,
    );
  } finally {
    database.close();
  }
});

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}
