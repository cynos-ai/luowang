import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError = 'unknown error';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check (code ${child.exitCode}): ${lastError}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : 'request failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${lastError}`);
}

const dataDir = await mkdtemp(join(tmpdir(), 'luowang-e2e-'));
const port = await getAvailablePort();
const child = spawn(process.execPath, ['dist/server/main.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_HOST: '127.0.0.1',
    LUOWANG_PORT: String(port),
    LUOWANG_LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stdout?.resume();
child.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(port, child);
  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  const health = (await healthResponse.json()) as { status: string; database: string };
  assert.equal(health.status, 'ok');
  assert.equal(health.database, 'ok');

  const shellResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(shellResponse.status, 200);
  assert.match(await shellResponse.text(), /LuoWang/);
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`,
  );
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  await rm(dataDir, { recursive: true, force: true });
}

console.log('e2e smoke passed');
