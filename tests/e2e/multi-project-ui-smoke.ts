import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { chromium } from 'playwright';

const root = resolve('dist/web');
const projects = [
  {
    projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    displayName: '项目 A',
    repositoryOwner: 'cynos-ai',
    repositoryName: 'a',
    status: 'paused',
    configRevision: 1,
  },
  {
    projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    displayName: '项目 B',
    repositoryOwner: 'cynos-ai',
    repositoryName: 'b',
    status: 'active',
    configRevision: 1,
  },
];
const config = {
  language: 'zh-CN',
  scenarioBranch: 'scenario-testing',
  scenarioMode: 'autonomous',
  scenarioLabels: ['core'],
  pollIntervalSeconds: 0,
  cron: '',
  triggerOnCommit: false,
  environmentDescription: '',
  baseUrl: '',
  externalDatabase: '',
  testDataCleanupUrl: '',
  executionDockerfile: '',
};
const secrets = Object.fromEntries(
  ['gitToken', 'testUsername', 'testPassword', 'testDataCleanupToken'].map((key) => [
    key,
    { configured: false, masked: null },
  ]),
);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const path = resolve(root, name);
  if (path !== root && !path.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    const type = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : 'text/html';
    response.writeHead(200, { 'content-type': type }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/mode') return route.fulfill({ json: { mode: 'multi-project' } });
    if (path === '/api/auth/status')
      return route.fulfill({ json: { configured: true, authenticated: true } });
    if (path === '/api/projects') return route.fulfill({ json: { projects } });
    const match = path.match(/^\/api\/projects\/([a-f-]{36})(.*)$/);
    if (!match) return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
    const project = projects.find((item) => item.projectId === match[1]);
    if (!project) return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
    const suffix = match[2];
    if (suffix === '') {
      if (project === projects[0]) await new Promise((done) => setTimeout(done, 500));
      return route.fulfill({ json: { project, configuration: config, secrets } });
    }
    if (suffix === '/readiness') {
      if (project === projects[0])
        return route.fulfill({ status: 503, json: { error: { message: '环境检查失败' } } });
      return route.fulfill({ json: { checkedAt: '2026-09-24', ready: true, checks: [] } });
    }
    if (suffix === '/index')
      return route.fulfill({ json: { index: { commitSha: null, syncedAt: null, errors: [] } } });
    if (suffix === '/queue') return route.fulfill({ json: { queue: [] } });
    if (suffix === '/runs') return route.fulfill({ json: { runs: [] } });
    if (suffix === '/scenarios') return route.fulfill({ json: { scenarios: [] } });
    if (suffix === '/reports') return route.fulfill({ json: { reports: [] } });
    return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
  });
  await page.goto(`${origin}/#/projects/${projects[0].projectId}`);
  await page.getByRole('heading', { name: '项目控制台' }).waitFor();
  await page.getByRole('button', { name: /项目 B/ }).click();
  await page.getByRole('heading', { name: '项目 B' }).waitFor();
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole('heading', { name: '项目 A' }).count(), 0);
  assert.equal(new URL(page.url()).hash, `#/projects/${projects[1].projectId}`);
  await page.reload();
  await page.getByRole('heading', { name: '项目 B' }).waitFor();
  await page.getByRole('button', { name: /项目 A/ }).click();
  await page.getByRole('heading', { name: '项目 A' }).waitFor();
  await page.getByText('环境检查失败').waitFor();
  await page.getByRole('heading', { name: '项目设置' }).waitFor();
  console.log('Multi-project UI smoke passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
