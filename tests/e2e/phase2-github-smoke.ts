import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryUrl = process.env.LUOWANG_SMOKE_REPOSITORY;
const token = process.env.LUOWANG_SMOKE_GITHUB_TOKEN;
if (!repositoryUrl || !token) {
  throw new Error(
    '设置 LUOWANG_SMOKE_REPOSITORY 和 LUOWANG_SMOKE_GITHUB_TOKEN 后才能运行真实 GitHub smoke',
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError = 'unknown error';
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`LuoWang server exited with code ${child.exitCode}: ${lastError}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'request failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`LuoWang server did not become healthy: ${lastError}`);
}

async function request<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase2-github-'));
const port = await availablePort();
const adminPassword = 'phase2-real-smoke-admin-password!';
const masterKey = 'phase2-real-smoke-master-key-material';
const childEnvironment = { ...process.env };
delete childEnvironment.LUOWANG_SMOKE_GITHUB_TOKEN;
const child = spawn(process.execPath, ['dist/server/main.js'], {
  cwd: process.cwd(),
  env: {
    ...childEnvironment,
    NODE_ENV: 'production',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_HOST: '127.0.0.1',
    LUOWANG_PORT: String(port),
    LUOWANG_LOG_LEVEL: 'silent',
    LUOWANG_ADMIN_PASSWORD: adminPassword,
    LUOWANG_MASTER_KEY: masterKey,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stdout?.resume();
child.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(port, child);
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(
    ((await loginResponse.clone().json()) as { authenticated: boolean }).authenticated,
    true,
  );
  const loginCookie = loginResponse.headers.get('set-cookie');
  assert.ok(loginCookie);
  const cookie = loginCookie.split(';', 1)[0];

  await request(
    baseUrl,
    '/api/config/repository',
    {
      method: 'PUT',
      body: JSON.stringify({
        repository: repositoryUrl,
        scenarioBranch: 'scenario-testing',
        secrets: { gitToken: token },
      }),
    },
    cookie,
  );
  const checks = await request<{ checks: Array<{ id: string }> }>(
    baseUrl,
    '/api/connectivity/checks',
    {},
    cookie,
  );
  assert.ok(checks.checks.some((check) => check.id === 'github-repository-read'));
  const readCheck = await request<{ result: { status: string } }>(
    baseUrl,
    '/api/connectivity/checks/github-repository-read',
    { method: 'POST' },
    cookie,
  );
  assert.equal(readCheck.result.status, 'ok');
  const branchCheck = await request<{ result: { status: string } }>(
    baseUrl,
    '/api/connectivity/checks/github-scenario-branch-write',
    { method: 'POST' },
    cookie,
  );
  assert.ok(['ok', 'unknown'].includes(branchCheck.result.status));

  const branch = await request<{ created: boolean }>(
    baseUrl,
    '/api/repository/scenario-branch',
    {
      method: 'POST',
      body: JSON.stringify({ initialRef: 'main' }),
    },
    cookie,
  );
  assert.equal(branch.created, false);
  const sync = await request<{ status: string; scenarios: number; commitSha: string }>(
    baseUrl,
    '/api/repository/sync',
    { method: 'POST' },
    cookie,
  );
  assert.equal(sync.status, 'synced');
  assert.equal(sync.scenarios, 2);
  const scenarios = await request<{ scenarios: Array<{ id: string }> }>(
    baseUrl,
    '/api/scenarios',
    {},
    cookie,
  );
  assert.deepEqual(
    scenarios.scenarios.map((scenario) => scenario.id),
    ['AUTH-LOGIN-001', 'AUTH-REGISTRATION-001'],
  );
  const status = await request<{ remoteHead: string }>(
    baseUrl,
    '/api/repository/status',
    {},
    cookie,
  );
  assert.equal(status.remoteHead, sync.commitSha);
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

console.log('phase 2 GitHub smoke passed');
