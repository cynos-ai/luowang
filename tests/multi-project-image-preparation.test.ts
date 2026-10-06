import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import {
  ensureProjectImage,
  inspectProjectImage,
  type ProjectImagePreparationDependencies,
} from '../src/server/projects/image-preparation.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const COMMIT = 'a'.repeat(40);
const IMAGE_A = `sha256:${'b'.repeat(64)}`;
const IMAGE_B = `sha256:${'c'.repeat(64)}`;

it('builds once, reuses a verified image and rebuilds when it disappears', async () => {
  const database = new Database(':memory:');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateProjectImageState(database);
    const project = createProjectStore(database).createVerified({
      displayName: 'A',
      repository: { githubRepositoryId: '1', owner: 'cynos-ai', name: 'a' },
    });
    const state = createProjectImageStateStore(database);
    const repository = new GitRepository({ directory: '/tmp/example', remoteUrl: '/tmp/example' });
    const input = {
      repository,
      projectId: project.projectId,
      instanceId: project.projectId,
      targetCommit: COMMIT,
      dockerfilePath: 'Dockerfile.test',
      storageRoot: '/tmp',
      state,
    };
    let builds = 0;
    let cleanups = 0;
    let available = true;
    const dependencies: ProjectImagePreparationDependencies = {
      async ensureDocker() {},
      async prepareSource(sourceInput) {
        assert.equal(sourceInput.projectId, project.projectId);
        return {
          directory: '/tmp/source',
          dockerfilePath: 'Dockerfile.test',
          targetCommit: COMMIT,
          cleanup: async () => {
            cleanups += 1;
          },
        };
      },
      async build() {
        builds += 1;
        return {
          projectId: project.projectId,
          targetCommit: COMMIT,
          imageId: builds === 1 ? IMAGE_A : IMAGE_B,
          tag: 'test',
        };
      },
      async inspect() {
        return available;
      },
    };
    assert.deepEqual(await ensureProjectImage(input, dependencies), {
      imageId: IMAGE_A,
      buildDefinition: 'Dockerfile.test',
      reused: false,
    });
    assert.equal((await ensureProjectImage(input, dependencies)).reused, true);
    assert.equal(builds, 1);
    available = false;
    const failedInspection = ensureProjectImage(input, {
      ...dependencies,
      inspect: async ({ imageId }) => imageId === IMAGE_B,
    });
    assert.equal((await failedInspection).imageId, IMAGE_B);
    assert.equal(builds, 2);
    assert.equal(cleanups, 2);
    assert.equal(
      state.get({
        projectId: project.projectId,
        targetCommit: COMMIT,
        dockerfilePath: 'Dockerfile.test',
      })?.imageId,
      IMAGE_B,
    );
    await assert.rejects(
      () =>
        ensureProjectImage(
          { ...input, targetCommit: 'd'.repeat(40) },
          {
            ...dependencies,
            prepareSource: async () => ({
              directory: '/tmp/source',
              dockerfilePath: 'Dockerfile.test',
              targetCommit: 'd'.repeat(40),
              cleanup: async () => {
                cleanups += 1;
              },
            }),
            inspect: async () => false,
          },
        ),
      /IMAGE_MISMATCH/,
    );
    assert.equal(
      state.get({
        projectId: project.projectId,
        targetCommit: 'd'.repeat(40),
        dockerfilePath: 'Dockerfile.test',
      })?.failureCode,
      'IMAGE_MISMATCH',
    );
    assert.equal(cleanups, 3);
    await assert.rejects(
      () =>
        ensureProjectImage(
          { ...input, targetCommit: 'e'.repeat(40) },
          {
            ...dependencies,
            ensureDocker: async () => {
              throw new Error('DOCKER_UNAVAILABLE');
            },
          },
        ),
      /DOCKER_UNAVAILABLE/,
    );
    assert.equal(builds, 3);
    assert.equal(
      state.get({
        projectId: project.projectId,
        targetCommit: 'e'.repeat(40),
        dockerfilePath: 'Dockerfile.test',
      }),
      null,
    );
  } finally {
    database.close();
  }
});

it('rejects mismatched image labels and distinguishes a missing image from a Docker outage', async () => {
  const key = {
    projectId: '00000000-0000-4000-8000-000000000001',
    targetCommit: COMMIT,
    dockerfilePath: 'Dockerfile.test',
    imageId: IMAGE_A,
  };
  assert.equal(
    await inspectProjectImage(key, {
      async run() {
        return {
          stdout: JSON.stringify({
            'luowang.project-id': key.projectId,
            'luowang.target-commit': key.targetCommit,
            'luowang.build-definition': 'other',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    }),
    false,
  );
  const calls: string[] = [];
  assert.equal(
    await inspectProjectImage(key, {
      async run(args) {
        calls.push(args[0]);
        return { stdout: '', stderr: '', exitCode: args[0] === 'image' ? 1 : 0 };
      },
    }),
    false,
  );
  assert.deepEqual(calls, ['image', 'info']);
  await assert.rejects(
    () =>
      inspectProjectImage(key, {
        async run() {
          return { stdout: '', stderr: '', exitCode: 1 };
        },
      }),
    /DOCKER_UNAVAILABLE/,
  );
});

it('propagates cancellation through image preparation and cleans the prepared source', async () => {
  const database = new Database(':memory:');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateProjectImageState(database);
    const project = createProjectStore(database).createVerified({
      displayName: 'cancel',
      repository: { githubRepositoryId: '2', owner: 'cynos-ai', name: 'cancel' },
    });
    const controller = new AbortController();
    let cleanup = 0;
    let startBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      startBuild = resolve;
    });
    const preparation = ensureProjectImage(
      {
        repository: new GitRepository({ directory: '/tmp/cancel', remoteUrl: '/tmp/cancel' }),
        projectId: project.projectId,
        instanceId: project.projectId,
        targetCommit: COMMIT,
        dockerfilePath: 'Dockerfile.test',
        storageRoot: '/tmp',
        state: createProjectImageStateStore(database),
        signal: controller.signal,
      },
      {
        async ensureDocker(signal) {
          assert.equal(signal, controller.signal);
        },
        async prepareSource(input) {
          assert.equal(input.signal, controller.signal);
          return {
            directory: '/tmp/source',
            dockerfilePath: 'Dockerfile.test',
            targetCommit: COMMIT,
            cleanup: async () => {
              cleanup += 1;
            },
          };
        },
        async build(input) {
          assert.equal(input.signal, controller.signal);
          startBuild();
          return new Promise((_, reject) =>
            input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
              once: true,
            }),
          );
        },
        async inspect() {
          return false;
        },
      },
    );
    await buildStarted;
    controller.abort();
    await assert.rejects(preparation, { name: 'AbortError' });
    assert.equal(cleanup, 1);
  } finally {
    database.close();
  }
});
