import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

import {
  createLocalExecutionAdapter,
  type ExecutionAdapter,
} from '../src/server/projects/execution-adapter.js';
import type { DockerRuntime } from '../src/server/projects/execution-container.js';
import { injectManagedFiles } from '../src/server/projects/managed-file-runtime.js';

it('accepts a hidden project file and creates remote staging before docker cp', async () => {
  const events: string[] = [];
  const docker: DockerRuntime = {
    async run(args) {
      if (args[0] === 'inspect') return { stdout: 'false\n', stderr: '', exitCode: 0 };
      events.push(`docker:${args.join(' ')}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const adapter: ExecutionAdapter = {
    locationId: 'server:fixture',
    async execute() {
      return { stdout: '', stderr: '', code: 0 };
    },
    async upload() {},
    async download() {},
    async uploadTree(_local, remote) {
      events.push(`upload:${remote}`);
    },
    async downloadTree() {
      events.push('download:inspection');
    },
    async removeTree() {},
    async close() {},
  };
  await injectManagedFiles({
    docker,
    executionAdapter: adapter,
    containerId: 'a'.repeat(64),
    files: [
      {
        id: 'fixture',
        revision: 1,
        path: '.env.test',
        serviceName: null,
        content: 'MODE=test\n',
      },
    ],
  });
  assert.match(events[0], /^upload:.*\/inspection$/);
  assert.match(events[1], /^docker:cp .*:\/luowang-source\/\. /);
  assert.equal(
    events.some((event) => event.includes('/payload')),
    true,
  );
});

it('rejects an aborted controlled file transfer before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-transfer-cancel-'));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createLocalExecutionAdapter('local:test').uploadTree(root, join(root, 'copy'), {
        signal: controller.signal,
        timeoutMs: 1000,
      }),
      { name: 'AbortError' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
