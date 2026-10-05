import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import { startComposeApplication } from '../src/server/projects/application-runtime.js';
import { normalizeComposeDefinition } from '../src/server/projects/compose-contract.js';
import type { DockerRuntime } from '../src/server/projects/execution-container.js';

it('cancels an in-progress Compose build before create or start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-compose-cancel-'));
  const controller = new AbortController();
  const calls: string[][] = [];
  let markBuildStarted!: () => void;
  const buildStarted = new Promise<void>((resolve) => {
    markBuildStarted = resolve;
  });
  const docker: DockerRuntime = {
    async run(args, options) {
      calls.push(args);
      if (args[0] === 'compose' && args.includes('build')) {
        markBuildStarted();
        return new Promise((_, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const definition = normalizeComposeDefinition({
    source: 'services:\n  app:\n    build: .\n    ports: ["3000"]\n',
    instanceId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    attemptId: '01K00000000000000000000001',
    enabledServices: ['app'],
    applicationService: 'app',
    commandService: 'app',
    servicePort: 3000,
  });
  try {
    const starting = startComposeApplication({
      docker,
      definition,
      buildSourceDirectory: root,
      commandSourceDirectory: root,
      targetCommit: 'a'.repeat(40),
      runtime: {
        workingDirectory: '.',
        prepareCommand: [],
        startCommand: [],
        servicePort: 3000,
        healthPath: '/',
        healthTimeoutSeconds: 30,
        composeFile: 'compose.yml',
        composeServices: ['app'],
        applicationService: 'app',
        commandService: 'app',
      },
      signal: controller.signal,
    });
    await buildStarted;
    controller.abort();
    await assert.rejects(starting, { name: 'AbortError' });
    assert.equal(
      calls.some((args) => args[0] === 'compose' && args.includes('create')),
      false,
    );
    assert.equal(
      calls.some((args) => args[0] === 'compose' && args.includes('start')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
