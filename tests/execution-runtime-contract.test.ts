import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import {
  normalizeComposeDefinition,
  resolveNativeComposeConfig,
} from '../src/server/projects/compose-contract.js';
import type { ExecutionAdapter } from '../src/server/projects/execution-adapter.js';
import {
  createAttachedProjectCommandSession,
  type DockerRuntime,
} from '../src/server/projects/execution-container.js';
import { StreamingSecretRedactor } from '../src/server/projects/managed-file-runtime.js';
import { normalizeRuntimeDefinition } from '../src/server/projects/configuration.js';

const identity = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  attemptId: '01K00000000000000000000001',
  enabledServices: ['app', 'db'],
  applicationService: 'app',
  commandService: 'app',
  servicePort: 3000,
};

describe('execution runtime safety contracts', () => {
  it('normalizes a two-service Compose definition and replaces global names and host ports', () => {
    const result = normalizeComposeDefinition({
      ...identity,
      source: `services:\n  app:\n    build: .\n    ports: ["3000"]\n    depends_on: [db]\n  db:\n    image: postgres:17\n    volumes: [data:/var/lib/postgresql/data]\nvolumes:\n  data: {}\n`,
    });
    assert.match(result.projectName, /^lw-/);
    assert.equal(result.services.app.ports?.[0], '127.0.0.1::3000');
    assert.deepEqual(result.services.app.networks, ['default']);
    assert.match(result.networkNames[0], /^lw-/);
    assert.match(result.volumeNames[0], /^lw-/);
    assert.deepEqual(result.services.db.volumes, ['data:/var/lib/postgresql/data:rw']);
    assert.equal(result.definitionHash.length, 64);
  });
  it('keeps build hashes stable across Runs while isolating runtime resources', () => {
    const source = `services:\n  app:\n    build: .\n    ports: ["3000"]\n    volumes: [".:/app"]\n`;
    const first = normalizeComposeDefinition({
      ...identity,
      enabledServices: ['app'],
      source,
    });
    const second = normalizeComposeDefinition({
      ...identity,
      attemptId: '01K00000000000000000000002',
      enabledServices: ['app'],
      source,
    });
    assert.equal(first.definitionHash, second.definitionHash);
    assert.notEqual(first.projectName, second.projectName);
    assert.notDeepEqual(first.networkNames, second.networkNames);
    assert.deepEqual(first.services.app.volumes, ['.:/app:ro']);
    const changed = normalizeComposeDefinition({
      ...identity,
      enabledServices: ['app'],
      source: source.replace(
        'build: .',
        'build:\n      context: .\n      dockerfile: Dockerfile.alt',
      ),
    });
    assert.notEqual(first.definitionHash, changed.definitionHash);
  });
  it('rejects privileged, host namespaces, unresolved interpolation and escaping build roots', () => {
    for (const source of [
      'services:\n  app:\n    image: alpine\n    privileged: true',
      'services:\n  app:\n    image: alpine\n    network_mode: host',
      'services:\n  app:\n    image: ${IMAGE}',
      'services:\n  app:\n    build: ../outside',
      'services:\n  app:\n    image: alpine\n    volumes: [".:/app:rw"]',
      'services:\n  app:\n    image: alpine\nvolumes:\n  data:\n    driver_opts:\n      device: /etc',
    ])
      assert.throws(
        () => normalizeComposeDefinition({ ...identity, enabledServices: ['app'], source }),
        /Compose|路径|端口|插值|危险/,
      );
  });
  it('accepts common resolved Compose fields and replaces a fixed host port', () => {
    const result = normalizeComposeDefinition({
      ...identity,
      enabledServices: ['app'],
      source: `services:\n  app:\n    build:\n      context: .\n      args:\n        NODE_ENV: test\n    profiles: [test]\n    restart: unless-stopped\n    ports:\n      - target: 3000\n        published: "8080"\n        protocol: tcp\n`,
    });
    assert.deepEqual(result.services.app.ports, ['127.0.0.1::3000']);
    assert.deepEqual((result.services.app.build as { args: unknown }).args, { NODE_ENV: 'test' });
    assert.deepEqual(result.services.app.profiles, ['test']);
    const nextRun = normalizeComposeDefinition({
      ...identity,
      attemptId: '01K00000000000000000000002',
      enabledServices: ['app'],
      source: `services:\n  app:\n    build:\n      context: .\n      args:\n        NODE_ENV: test\n    ports: ["3000"]\n`,
    });
    assert.notEqual(result.definitionHash, nextRun.definitionHash);
  });
  it('uses the selected execution adapter for native Compose resolution without exposing output', async () => {
    let captured: readonly string[] = [];
    const adapter: ExecutionAdapter = {
      locationId: 'server:fixture',
      async execute(_program, args) {
        captured = args;
        return { stdout: '{"services":{"app":{"image":"alpine"}}}', stderr: '', code: 0 };
      },
      async upload() {},
      async download() {},
      async uploadTree() {},
      async downloadTree() {},
      async removeTree() {},
      async close() {},
    };
    const resolved = await resolveNativeComposeConfig({
      adapter,
      sourceDirectory: '/tmp/run-source',
      composeFile: 'deploy/compose.yml',
    });
    assert.match(resolved, /services/);
    assert.deepEqual(captured.slice(-6), [
      '--profile',
      '*',
      'config',
      '--format',
      'json',
      '--no-path-resolution',
    ]);
    const failing = {
      ...adapter,
      async execute() {
        return { stdout: '', stderr: 'TOKEN=synthetic-secret', code: 1 };
      },
    } satisfies ExecutionAdapter;
    await assert.rejects(
      resolveNativeComposeConfig({
        adapter: failing,
        sourceDirectory: '/tmp/run-source',
        composeFile: 'compose.yml',
      }),
      (error: Error) => !error.message.includes('synthetic-secret'),
    );
  });
  it('resolves Compose paths from the configured file directory', () => {
    const result = normalizeComposeDefinition({
      ...identity,
      enabledServices: ['app'],
      composeFile: 'deploy/compose.yml',
      source: `services:\n  app:\n    build: .\n    ports: ["3000"]\n    volumes: ["../config:/app/config"]\n`,
    });
    assert.equal((result.services.app.build as { context: string }).context, 'deploy');
    assert.deepEqual(result.services.app.volumes, ['./config:/app/config:ro']);
    assert.throws(
      () =>
        normalizeComposeDefinition({
          ...identity,
          enabledServices: ['app'],
          composeFile: 'deploy/compose.yml',
          source: 'services:\n  app:\n    build: ../../outside\n',
        }),
      /越界/,
    );
  });
  it('redacts env, JSON and YAML scalar values even when stream chunks split a secret', () => {
    const redactor = new StreamingSecretRedactor([
      'TOKEN=alpha-secret\njson: bravo-secret\n{"password":"charlie-secret"}',
    ]);
    const output =
      redactor.push('before alpha-se') +
      redactor.push('cret bravo-secret charlie-') +
      redactor.push('secret after') +
      redactor.finish();
    assert.equal(output.includes('alpha-secret'), false);
    assert.equal(output.includes('bravo-secret'), false);
    assert.equal(output.includes('charlie-secret'), false);
  });
  it('accepts argv arrays and rejects shell-like runtime command strings', () => {
    assert.deepEqual(
      normalizeRuntimeDefinition({ startCommand: ['npm', 'start'], servicePort: 3000 })
        .startCommand,
      ['npm', 'start'],
    );
    assert.throws(() => normalizeRuntimeDefinition({ startCommand: 'npm start' }), /参数数组/);
  });
  it('runs normal shell commands only inside the owned command service', async () => {
    const calls: string[][] = [];
    const docker: DockerRuntime = {
      async run(args) {
        calls.push(args);
        if (args[0] === 'inspect')
          return {
            stdout: JSON.stringify({
              'luowang.project-id': identity.projectId,
              'luowang.run-id': identity.attemptId,
            }),
            stderr: '',
            exitCode: 0,
          };
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    };
    const session = await createAttachedProjectCommandSession(
      {
        projectId: identity.projectId,
        runId: identity.attemptId,
        targetCommit: 'a'.repeat(40),
        repositoryDirectory: '/tmp/project',
        containerId: 'b'.repeat(64),
        sourceRoot: '/luowang-source',
        workingDirectory: '/luowang-source',
      },
      docker,
    );
    const result = await session.run('npm test && npm run lint', {
      cwd: '/tmp/project',
      runId: identity.attemptId,
      targetCommit: 'a'.repeat(40),
    });
    assert.equal(result.stdout, 'ok');
    assert.deepEqual(calls.at(-1)?.slice(-3), ['/bin/sh', '-lc', 'npm test && npm run lint']);
  });
  it('stops the owned command service when a container shell result is uncertain', async () => {
    const calls: string[][] = [];
    const docker: DockerRuntime = {
      async run(args) {
        calls.push(args);
        if (args[0] === 'inspect')
          return {
            stdout: JSON.stringify({
              'luowang.project-id': identity.projectId,
              'luowang.run-id': identity.attemptId,
            }),
            stderr: '',
            exitCode: 0,
          };
        if (args[0] === 'exec') throw new Error('connection closed');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const session = await createAttachedProjectCommandSession(
      {
        projectId: identity.projectId,
        runId: identity.attemptId,
        targetCommit: 'a'.repeat(40),
        repositoryDirectory: '/tmp/project',
        containerId: 'b'.repeat(64),
        sourceRoot: '/luowang-source',
        workingDirectory: '/luowang-source',
      },
      docker,
    );
    await assert.rejects(
      session.run('sleep 300', {
        cwd: '/tmp/project',
        runId: identity.attemptId,
        targetCommit: 'a'.repeat(40),
      }),
      /connection closed/,
    );
    assert.equal(calls.at(-1)?.[0], 'kill');
  });
});
