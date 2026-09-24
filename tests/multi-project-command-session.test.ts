import { strict as assert } from 'node:assert';

import { it } from 'vitest';

import {
  createProjectRunCommandSessionFactory,
  type ProjectCommandSessionDependencies,
} from '../src/server/projects/command-session.js';
import type { ProjectImageStateStore } from '../src/server/projects/image-state.js';
import { GitRepository } from '../src/server/repository/git-repository.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const RUN = '01K00000000000000000000001';
const COMMIT = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;

it('prepares one pinned image and patch source, then closes container before deleting source', async () => {
  const calls: string[] = [];
  const repository = new GitRepository({ directory: '/tmp/project', remoteUrl: '/tmp/project' });
  const dependencies: ProjectCommandSessionDependencies = {
    async ensureImage(input) {
      assert.equal(input.projectId, PROJECT);
      assert.equal(input.dockerfilePath, 'Dockerfile.test');
      calls.push('image');
      return { imageId: IMAGE, buildDefinition: 'Dockerfile.test', reused: true };
    },
    async prepareSource(input) {
      assert.equal(input.scenarioPatch, 'validated patch');
      calls.push('source');
      return {
        directory: '/tmp/source',
        projectId: PROJECT,
        runId: RUN,
        targetCommit: COMMIT,
        scenarioPatchSha256: 'c'.repeat(64),
        cleanup: async () => {
          calls.push('source-cleanup');
        },
      };
    },
    async startSession(input) {
      assert.equal(input.imageId, IMAGE);
      assert.equal(input.runSource.scenarioPatchSha256, 'c'.repeat(64));
      calls.push('container');
      return {
        containerId: 'd'.repeat(64),
        async run() {
          calls.push('command');
          return { stdout: 'ok', stderr: '', exitCode: 0, environmentKeys: [] };
        },
        async close() {
          calls.push('container-close');
        },
      };
    },
  };
  const factory = createProjectRunCommandSessionFactory(
    {
      projectId: PROJECT,
      dockerfilePath: 'Dockerfile.test',
      storageRoot: '/tmp',
      imageState: {} as ProjectImageStateStore,
      recordImage(input) {
        assert.deepEqual(input, { runId: RUN, targetCommit: COMMIT, imageId: IMAGE });
        calls.push('record');
      },
    },
    dependencies,
  );
  const session = await factory({
    repository,
    runId: RUN,
    targetCommit: COMMIT,
    scenarioPatch: 'validated patch',
  });
  assert.equal(
    (
      await session.run('node --version', {
        cwd: repository.directory,
        runId: RUN,
        targetCommit: COMMIT,
      })
    ).stdout,
    'ok',
  );
  await session.close();
  assert.deepEqual(calls, [
    'image',
    'source',
    'container',
    'record',
    'command',
    'container-close',
    'source-cleanup',
  ]);
});

it('does not create a container if image preparation fails', async () => {
  const repository = new GitRepository({ directory: '/tmp/project', remoteUrl: '/tmp/project' });
  let sourceCalled = false;
  const factory = createProjectRunCommandSessionFactory(
    {
      projectId: PROJECT,
      dockerfilePath: '',
      storageRoot: '/tmp',
      imageState: {} as ProjectImageStateStore,
    },
    {
      async ensureImage() {
        throw new Error('image failed');
      },
      async prepareSource() {
        sourceCalled = true;
        throw new Error('unexpected');
      },
      async startSession() {
        throw new Error('unexpected');
      },
    },
  );
  await assert.rejects(
    () => factory({ repository, runId: RUN, targetCommit: COMMIT }),
    /image failed/,
  );
  assert.equal(sourceCalled, false);
});

it('deletes the Run source when container startup fails', async () => {
  const repository = new GitRepository({ directory: '/tmp/project', remoteUrl: '/tmp/project' });
  let cleaned = false;
  const factory = createProjectRunCommandSessionFactory(
    {
      projectId: PROJECT,
      dockerfilePath: 'Dockerfile.test',
      storageRoot: '/tmp',
      imageState: {} as ProjectImageStateStore,
    },
    {
      async ensureImage() {
        return { imageId: IMAGE, buildDefinition: 'Dockerfile.test', reused: true };
      },
      async prepareSource() {
        return {
          directory: '/tmp/source',
          projectId: PROJECT,
          runId: RUN,
          targetCommit: COMMIT,
          scenarioPatchSha256: null,
          cleanup: async () => {
            cleaned = true;
          },
        };
      },
      async startSession() {
        throw new Error('container failed');
      },
    },
  );
  await assert.rejects(
    () => factory({ repository, runId: RUN, targetCommit: COMMIT }),
    /container failed/,
  );
  assert.equal(cleaned, true);
});

it('closes the container and source when image recording fails', async () => {
  const repository = new GitRepository({ directory: '/tmp/project', remoteUrl: '/tmp/project' });
  const calls: string[] = [];
  const factory = createProjectRunCommandSessionFactory(
    {
      projectId: PROJECT,
      dockerfilePath: '',
      storageRoot: '/tmp',
      imageState: {} as ProjectImageStateStore,
      recordImage() {
        throw new Error('record failed');
      },
    },
    {
      async ensureImage() {
        return { imageId: IMAGE, buildDefinition: '', reused: true };
      },
      async prepareSource() {
        return {
          directory: '/tmp/source',
          projectId: PROJECT,
          runId: RUN,
          targetCommit: COMMIT,
          scenarioPatchSha256: null,
          cleanup: async () => {
            calls.push('source');
          },
        };
      },
      async startSession() {
        calls.push('started');
        return {
          containerId: 'd'.repeat(64),
          async run() {
            throw new Error('unexpected');
          },
          async close() {
            calls.push('closed');
          },
        };
      },
    },
  );
  await assert.rejects(
    () => factory({ repository, runId: RUN, targetCommit: COMMIT }),
    /record failed/,
  );
  assert.deepEqual(calls, ['started', 'closed', 'source']);
});
