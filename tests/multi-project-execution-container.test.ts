import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  startProjectCommandSession,
  type DockerRuntime,
  type DockerRuntimeResult,
} from '../src/server/projects/execution-container.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const INSTANCE = '00000000-0000-4000-8000-000000000002';
const RUN = '01K00000000000000000000001';
const COMMIT = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const CONTAINER = 'c'.repeat(64);
const CWD = '/tmp/project-a';
let sourceRoot: string;
let sourceDirectory: string;

beforeAll(async () => {
  sourceRoot = await mkdtemp(join(tmpdir(), 'luowang-command-source-'));
  sourceDirectory = join(sourceRoot, 'projects', PROJECT, 'run-sources', 'source-test', 'context');
  await mkdir(sourceDirectory, { recursive: true });
});

afterAll(async () => {
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true });
});

describe('project command container', () => {
  it('checks image ownership, shares the command allowlist, and binds every command to one Run', async () => {
    const calls: string[][] = [];
    const docker: DockerRuntime = {
      async run(args): Promise<DockerRuntimeResult> {
        calls.push(args);
        switch (args[0]) {
          case 'image':
            return ok(
              JSON.stringify({
                'luowang.project-id': PROJECT,
                'luowang.target-commit': COMMIT,
              }),
            );
          case 'create':
            return ok(CONTAINER);
          case 'cp':
          case 'start':
          case 'rm':
            return ok('');
          case 'exec':
            return { stdout: 'v24.0.0\n', stderr: '', exitCode: 0 };
          default:
            throw new Error('unexpected docker command');
        }
      },
    };
    const session = await startProjectCommandSession(binding(), docker);
    assert.equal(session.containerId, CONTAINER);
    const create = calls.find((args) => args[0] === 'create')!;
    assert.equal(create.includes('--mount'), false);
    assert.ok(create.includes(`luowang.instance-id=${INSTANCE}`));
    const copy = calls.find((args) => args[0] === 'cp')!;
    assert.deepEqual(copy, ['cp', `${sourceDirectory}/.`, `${CONTAINER}:/luowang-source`]);
    const result = await session.run('node --version', commandOptions());
    assert.equal(result.stdout, 'v24.0.0\n');
    assert.deepEqual(result.environmentKeys, ['LUOWANG_RUN_ID', 'LUOWANG_TARGET_COMMIT']);
    const exec = calls.find((args) => args[0] === 'exec')!;
    assert.deepEqual(exec.slice(-2), ['node', '--version']);
    assert.ok(exec.includes('/luowang-source'));
    assert.ok(exec.includes(`LUOWANG_RUN_ID=${RUN}`));
    assert.ok(exec.includes(`LUOWANG_TARGET_COMMIT=${COMMIT}`));
    await assert.rejects(
      () => session.run('node -e "process.exit(0)"', commandOptions()),
      /内联代码/,
    );
    await assert.rejects(
      () => session.run('node --version', { ...commandOptions(), runId: 'other' }),
      /上下文不符/,
    );
    assert.equal(calls.filter((args) => args[0] === 'exec').length, 1);
    await session.close();
    await session.close();
    assert.equal(calls.filter((args) => args[0] === 'rm').length, 1);
    await assert.rejects(() => session.run('node --version', commandOptions()), /已关闭/);
  });

  it('refuses a cross-project image before creating a container and removes a failed start', async () => {
    const wrongCalls: string[][] = [];
    const wrong: DockerRuntime = {
      async run(args) {
        wrongCalls.push(args);
        return ok(
          JSON.stringify({ 'luowang.project-id': 'other', 'luowang.target-commit': COMMIT }),
        );
      },
    };
    await assert.rejects(() => startProjectCommandSession(binding(), wrong), /归属或目标提交不符/);
    assert.deepEqual(
      wrongCalls.map((args) => args[0]),
      ['image'],
    );

    await assert.rejects(
      () =>
        startProjectCommandSession(
          { ...binding(), runSource: { ...binding().runSource, projectId: 'other' } },
          wrong,
        ),
      /Run 源码与执行容器归属不符/,
    );
    await assert.rejects(
      () => startProjectCommandSession({ ...binding(), sourceRoot: '/' }, wrong),
      /受控目录/,
    );

    const failedCalls: string[][] = [];
    const failed: DockerRuntime = {
      async run(args) {
        failedCalls.push(args);
        if (args[0] === 'image') {
          return ok(
            JSON.stringify({ 'luowang.project-id': PROJECT, 'luowang.target-commit': COMMIT }),
          );
        }
        if (args[0] === 'create') return ok(CONTAINER);
        if (args[0] === 'start') return { stdout: '', stderr: 'failed', exitCode: 1 };
        return ok('');
      },
    };
    await assert.rejects(
      () => startProjectCommandSession(binding(), failed),
      /Docker start 操作失败/,
    );
    assert.deepEqual(
      failedCalls.map((args) => args[0]),
      ['image', 'create', 'cp', 'start', 'rm'],
    );

    const copyCalls: string[] = [];
    await assert.rejects(
      () =>
        startProjectCommandSession(binding(), {
          async run(args) {
            copyCalls.push(args[0]);
            if (args[0] === 'image')
              return ok(
                JSON.stringify({ 'luowang.project-id': PROJECT, 'luowang.target-commit': COMMIT }),
              );
            if (args[0] === 'create') return ok(CONTAINER);
            if (args[0] === 'cp') return { stdout: '', stderr: 'copy failed', exitCode: 1 };
            return ok('');
          },
        }),
      /Docker cp 操作失败/,
    );
    assert.deepEqual(copyCalls, ['image', 'create', 'cp', 'rm']);
  });
});

function binding() {
  return {
    projectId: PROJECT,
    instanceId: INSTANCE,
    runId: RUN,
    targetCommit: COMMIT,
    imageId: IMAGE,
    repositoryDirectory: CWD,
    sourceRoot,
    runSource: {
      directory: sourceDirectory,
      projectId: PROJECT,
      runId: RUN,
      targetCommit: COMMIT,
      scenarioPatchSha256: null,
      cleanup: async () => {},
    },
  };
}

function commandOptions() {
  return { cwd: CWD, runId: RUN, targetCommit: COMMIT };
}

function ok(stdout: string): DockerRuntimeResult {
  return { stdout, stderr: '', exitCode: 0 };
}
