import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { normalizeComposeDefinition } from '../src/server/projects/compose-contract.js';
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
  it('rejects privileged, host namespaces, fixed ports, interpolation and escaping build roots', () => {
    for (const source of [
      'services:\n  app:\n    image: alpine\n    privileged: true',
      'services:\n  app:\n    image: alpine\n    network_mode: host',
      'services:\n  app:\n    image: alpine\n    ports: ["8080:3000"]',
      'services:\n  app:\n    image: ${IMAGE}',
      'services:\n  app:\n    build: ../outside',
      'services:\n  app:\n    image: alpine\n    volumes: [".:/app:rw"]',
    ])
      assert.throws(
        () => normalizeComposeDefinition({ ...identity, enabledServices: ['app'], source }),
        /Compose|路径|端口|插值|危险/,
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
});
