import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDockerRuntime,
  startProjectCommandSession,
  type ProjectCommandSession,
} from '../../src/server/projects/execution-container.js';
import { createRunId } from '../../src/server/runs/workspace.js';
import { randomBytes } from 'node:crypto';

// Explicit native proof: requires Docker and a locally available, immutable Node image.
// Never uses a production project, an existing Run, or global Docker cleanup.
const base = process.env.LUOWANG_STOP_PROOF_BASE_IMAGE;
assert.match(base ?? '', /^sha256:[a-f0-9]{64}$/);
const docker = createDockerRuntime();
const root = await mkdtemp(join(tmpdir(), 'luowang-stop-docker-'));
const instanceId = randomUUID();
const sessions: ProjectCommandSession[] = [];
const images: string[] = [];
const command = async (args: string[], timeoutMs = 30000) => {
  const result = await docker.run(args, { timeoutMs });
  assert.equal(result.exitCode, 0, `Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
try {
  for (let i = 0; i < 2; i++) {
    const projectId = randomUUID();
    const runId = createRunId(Date.now(), randomBytes(10));
    const targetCommit = String(i + 1).repeat(40);
    const seed = await command(['create', base!]);
    let imageId: string;
    try {
      imageId = await command([
        'commit',
        '--change',
        `LABEL luowang.instance-id=${instanceId}`,
        '--change',
        `LABEL luowang.project-id=${projectId}`,
        '--change',
        `LABEL luowang.target-commit=${targetCommit}`,
        seed,
      ]);
    } finally {
      await command(['rm', seed]);
    }
    images.push(imageId);
    const directory = join(root, 'projects', projectId, 'run-sources', 'source-proof', 'context');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'wait.cjs'),
      "require('fs').writeFileSync('/tmp/stop-proof-started', 'yes'); setInterval(() => {}, 1000);",
    );
    await writeFile(
      join(directory, 'done.cjs'),
      "setTimeout(() => console.log('B completed independently'), 1000);",
    );
    sessions.push(
      await startProjectCommandSession(
        {
          projectId,
          instanceId,
          runId,
          targetCommit,
          imageId,
          repositoryDirectory: directory,
          sourceRoot: root,
          runSource: {
            projectId,
            runId,
            targetCommit,
            directory,
            scenarioPatchSha256: null,
            cleanup: async () => {},
          },
        },
        docker,
      ),
    );
  }
  const abort = new AbortController();
  const bindings = await Promise.all(
    sessions.map(
      async (session) =>
        JSON.parse(
          await command(['inspect', '--format', '{{json .Config.Labels}}', session.containerId]),
        ) as Record<string, string>,
    ),
  );
  const options = (i: number) => ({
    cwd: join(
      root,
      'projects',
      bindings[i]['luowang.project-id'],
      'run-sources',
      'source-proof',
      'context',
    ),
    runId: bindings[i]['luowang.run-id'],
    targetCommit: bindings[i]['luowang.target-commit'],
  });
  const a = assert.rejects(
    sessions[0].run('node wait.cjs', { ...options(0), signal: abort.signal }),
  );
  const deadline = Date.now() + 10000;
  let started = false;
  while (Date.now() < deadline) {
    const result = await docker.run(
      ['exec', sessions[0].containerId, 'cat', '/tmp/stop-proof-started'],
      { timeoutMs: 3000 },
    );
    if (result.exitCode === 0) {
      started = true;
      break;
    }
    await delay(50);
  }
  assert.ok(started, 'A process must actually execute before stop');
  const b = sessions[1].run('node done.cjs', options(1));
  abort.abort();
  await a;
  await Promise.all([sessions[0].close(), sessions[0].close()]);
  assert.equal(
    await command(['ps', '--all', '--quiet', '--filter', `id=${sessions[0].containerId}`]),
    '',
  );
  assert.equal(
    await command(['inspect', '--format', '{{.State.Running}}', sessions[1].containerId]),
    'true',
  );
  const resultB = await b;
  assert.equal(resultB.exitCode, 0);
  assert.match(resultB.stdout, /B completed independently/);
  console.log(
    JSON.stringify({
      status: 'passed',
      instanceId,
      actualAProcessStarted: true,
      actualAContainerRemoved: true,
      simultaneousCloseIdempotent: true,
      independentBCompleted: true,
      containers: sessions.map((item) => item.containerId),
    }),
  );
} finally {
  await Promise.all(sessions.map((session) => session.close()));
  for (const image of images) await command(['image', 'rm', image]);
  await rm(root, { recursive: true, force: true });
}
