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
const projectConfigs = new Map(projects.map((project) => [project.projectId, { ...config }]));
let releaseLateWrite: () => void = () => {};
const lateWriteGate = new Promise<void>((resolve) => {
  releaseLateWrite = resolve;
});
let lateWriteProjectId: string | null = null;
let releaseLateImage: () => void = () => {};
const lateImageGate = new Promise<void>((resolve) => {
  releaseLateImage = resolve;
});
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
    const request = route.request();
    const url = new URL(request.url());
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
    if (suffix === '/configuration' && request.method() === 'PUT') {
      lateWriteProjectId = project.projectId;
      assert.equal(project, projects[0]);
      assert.equal(request.postDataJSON().baseUrl, 'https://a.example.test');
      await lateWriteGate;
      return route.fulfill({
        json: { project, configuration: projectConfigs.get(project.projectId) },
      });
    }
    if (suffix === '/image/prepare' && request.method() === 'POST') {
      assert.equal(project, projects[0]);
      await lateImageGate;
      return route.fulfill({
        json: {
          image: {
            targetCommit: 'a'.repeat(40),
            imageId: `sha256:${'b'.repeat(64)}`,
            reused: false,
          },
        },
      });
    }
    if (suffix === '') {
      if (project === projects[0]) await new Promise((done) => setTimeout(done, 500));
      return route.fulfill({
        json: { project, configuration: projectConfigs.get(project.projectId), secrets },
      });
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
  await page.getByLabel('非生产环境 URL').fill('https://a.example.test');
  const oldWrite = page.waitForRequest(
    (request) =>
      request.url().endsWith(`/api/projects/${projects[0].projectId}/configuration`) &&
      request.method() === 'PUT',
  );
  await page.getByRole('button', { name: '保存项目配置' }).click();
  await oldWrite;
  await page.getByRole('button', { name: /项目 B/ }).click();
  await page.getByRole('heading', { name: '项目 B' }).waitFor();
  assert.equal(await page.getByLabel('非生产环境 URL').inputValue(), '');
  const oldResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/projects/${projects[0].projectId}/configuration`),
  );
  releaseLateWrite();
  await oldResponse;
  await page.waitForTimeout(100);
  assert.equal(lateWriteProjectId, projects[0].projectId);
  assert.equal(new URL(page.url()).hash, `#/projects/${projects[1].projectId}`);
  assert.equal(await page.getByLabel('非生产环境 URL').inputValue(), '');
  assert.equal(await page.getByText('保存项目配置完成').count(), 0);
  await page.getByRole('button', { name: /项目 A/ }).click();
  await page.getByRole('heading', { name: '项目 A' }).waitFor();
  const oldImage = page.waitForRequest(
    (request) =>
      request.url().endsWith(`/api/projects/${projects[0].projectId}/image/prepare`) &&
      request.method() === 'POST',
  );
  await page.getByRole('button', { name: '准备或重建镜像' }).click();
  await oldImage;
  await page.getByRole('button', { name: /项目 B/ }).click();
  await page.getByRole('heading', { name: '项目 B' }).waitFor();
  const oldImageResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/projects/${projects[0].projectId}/image/prepare`),
  );
  releaseLateImage();
  await oldImageResponse;
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('准备镜像完成').count(), 0);
  assert.equal((await page.locator('body').innerText()).includes('sha256:bbbb'), false);

  // Exercise the human onboarding path with stateful API responses, not only project switching.
  const onboarding = await browser.newPage();
  const newProject = {
    projectId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    displayName: '新项目',
    repositoryOwner: 'cynos-ai',
    repositoryName: 'new-project',
    status: 'paused',
    configRevision: 1,
  };
  const newConfig = { ...config };
  const newSecrets = structuredClone(secrets);
  let created = false;
  let imageReady = false;
  let imageAttempts = 0;
  let initialSourceSubmitted = false;
  let pendingRequest = false;
  const writes: Array<{ method: string; path: string }> = [];
  await onboarding.route('**/health', (route) => route.fulfill({ json: { status: 'ok' } }));
  await onboarding.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') writes.push({ method, path });
    if (path === '/api/mode') return route.fulfill({ json: { mode: 'multi-project' } });
    if (path === '/api/auth/status')
      return route.fulfill({ json: { configured: true, authenticated: true } });
    if (path === '/api/projects' && method === 'GET')
      return route.fulfill({ json: { projects: created ? [newProject] : [] } });
    if (path === '/api/projects' && method === 'POST') {
      const body = request.postDataJSON();
      assert.equal(body.displayName, '新项目');
      assert.equal(body.repositoryUrl, 'https://github.com/cynos-ai/new-project');
      created = true;
      return route.fulfill({ status: 201, json: { project: newProject } });
    }
    const base = `/api/projects/${newProject.projectId}`;
    if (!path.startsWith(base))
      return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
    const suffix = path.slice(base.length);
    if (suffix === '' && method === 'GET')
      return route.fulfill({
        json: { project: newProject, configuration: newConfig, secrets: newSecrets },
      });
    if (suffix === '/readiness') {
      const ready = imageReady && Boolean(newConfig.baseUrl) && newSecrets.gitToken.configured;
      return route.fulfill({
        json: {
          checkedAt: '2026-09-26T00:00:00Z',
          ready,
          checks: [
            {
              id: 'image',
              status: imageReady ? 'ok' : 'missing',
              message: imageReady ? '镜像已准备' : '需要准备项目镜像',
            },
          ],
        },
      });
    }
    if (suffix === '/resume' && method === 'POST') {
      if (!imageReady || !newConfig.baseUrl || !newSecrets.gitToken.configured)
        return route.fulfill({ status: 409, json: { error: { message: '项目尚未就绪' } } });
      newProject.status = 'active';
      return route.fulfill({ json: { project: newProject } });
    }
    if (suffix === '/pause' && method === 'POST') {
      newProject.status = 'paused';
      return route.fulfill({ json: { project: newProject } });
    }
    if (suffix === '/configuration' && method === 'PUT') {
      if (pendingRequest)
        return route.fulfill({ status: 409, json: { error: { message: '项目有待处理请求' } } });
      Object.assign(newConfig, request.postDataJSON());
      newProject.configRevision++;
      return route.fulfill({ json: { project: newProject, configuration: newConfig } });
    }
    if (suffix === '/secrets/gitToken' && method === 'PUT') {
      assert.equal(request.postDataJSON().value, 'synthetic-token');
      newSecrets.gitToken = { configured: true, masked: '••••' };
      return route.fulfill({ json: { key: 'gitToken', metadata: newSecrets.gitToken } });
    }
    if (suffix === '/image/prepare' && method === 'POST') {
      imageAttempts++;
      if (imageAttempts === 1)
        return route.fulfill({ status: 503, json: { error: { message: '镜像构建失败' } } });
      imageReady = true;
      return route.fulfill({
        json: {
          image: {
            targetCommit: 'a'.repeat(40),
            imageId: `sha256:${'b'.repeat(64)}`,
            reused: false,
          },
        },
      });
    }
    if (suffix === '/merge' && method === 'POST') {
      assert.deepEqual(request.postDataJSON(), {
        sourceRef: 'main',
        confirmed: true,
        initialization: true,
      });
      initialSourceSubmitted = true;
      return route.fulfill({ status: 202, json: { queue: { queueId: 1 } } });
    }
    if (suffix === '/index')
      return route.fulfill({ json: { index: { commitSha: null, syncedAt: null, errors: [] } } });
    if (suffix === '/queue') return route.fulfill({ json: { queue: [] } });
    if (suffix === '/runs') return route.fulfill({ json: { runs: [] } });
    if (suffix === '/scenarios') return route.fulfill({ json: { scenarios: [] } });
    if (suffix === '/reports') return route.fulfill({ json: { reports: [] } });
    return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
  });
  await onboarding.goto(origin);
  await onboarding.getByText('还没有项目。先连接一个 GitHub 仓库。').waitFor();
  await onboarding.getByLabel('项目名称').fill('新项目');
  await onboarding.getByLabel('GitHub 仓库地址').fill('https://github.com/cynos-ai/new-project');
  await onboarding.getByRole('button', { name: '核验并创建暂停项目' }).click();
  await onboarding.getByRole('heading', { name: '新项目', exact: true }).waitFor();
  assert.equal(newProject.status, 'paused');
  assert.equal(new URL(onboarding.url()).hash, `#/projects/${newProject.projectId}`);
  await onboarding.getByRole('button', { name: '检查并启用' }).click();
  await onboarding.getByText('项目尚未就绪').waitFor();
  assert.equal(newProject.status, 'paused');
  assert.equal(await onboarding.getByRole('button', { name: '提交 Run' }).isDisabled(), true);
  await onboarding.getByLabel('非生产环境 URL').fill('https://staging.example.test');
  await onboarding
    .getByLabel('仓库中的执行 Dockerfile（留空使用内置基础镜像）')
    .fill('Dockerfile.test');
  await onboarding.getByRole('button', { name: '保存项目配置' }).click();
  await onboarding.getByText('保存项目配置完成').waitFor();
  assert.equal(newConfig.executionDockerfile, 'Dockerfile.test');
  assert.equal(newProject.status, 'paused');
  await onboarding.getByLabel('GitHub Token · 未配置').fill('synthetic-token');
  await onboarding.getByRole('button', { name: '保存', exact: true }).first().click();
  await onboarding.getByText('保存GitHub Token完成').waitFor();
  await onboarding.getByRole('button', { name: '准备或重建镜像' }).click();
  await onboarding.getByText('镜像构建失败').waitFor();
  assert.equal(newProject.status, 'paused');
  await onboarding.getByRole('button', { name: '准备或重建镜像' }).click();
  await onboarding.getByText('就绪检查 · 已通过').waitFor();
  await onboarding.getByRole('button', { name: '检查并启用' }).click();
  await onboarding.getByRole('button', { name: '暂停新测试' }).waitFor();
  assert.equal(await onboarding.getByRole('button', { name: '提交 Run' }).isDisabled(), false);
  await onboarding.getByLabel('来源分支、tag 或提交').fill('main');
  await onboarding.getByLabel('首次初始化（场景分支尚不存在时必须勾选）').check();
  assert.equal(await onboarding.getByRole('button', { name: '提交来源并测试' }).isDisabled(), true);
  await onboarding.getByLabel('我确认要把此来源纳入当前项目的场景测试分支').check();
  await onboarding.getByRole('button', { name: '提交来源并测试' }).click();
  await onboarding.getByText('提交来源并测试完成').waitFor();
  assert.equal(initialSourceSubmitted, true);
  pendingRequest = true;
  await onboarding.getByLabel('非生产环境 URL').fill('https://other.example.test');
  await onboarding.getByRole('button', { name: '保存项目配置' }).click();
  await onboarding.getByText('项目有待处理请求').waitFor();
  assert.equal(newConfig.baseUrl, 'https://staging.example.test');
  assert.equal(newProject.status, 'active');
  await onboarding.getByRole('button', { name: '暂停新测试' }).click();
  await onboarding.getByRole('button', { name: '检查并启用' }).waitFor();
  assert.equal(await onboarding.getByRole('button', { name: '提交 Run' }).isDisabled(), true);
  assert.deepEqual(
    writes.map(({ method, path }) => `${method} ${path}`).sort(),
    [
      'POST /api/projects',
      `POST /api/projects/${newProject.projectId}/resume`,
      `PUT /api/projects/${newProject.projectId}/configuration`,
      `PUT /api/projects/${newProject.projectId}/secrets/gitToken`,
      `POST /api/projects/${newProject.projectId}/image/prepare`,
      `POST /api/projects/${newProject.projectId}/image/prepare`,
      `POST /api/projects/${newProject.projectId}/resume`,
      `POST /api/projects/${newProject.projectId}/merge`,
      `PUT /api/projects/${newProject.projectId}/configuration`,
      `POST /api/projects/${newProject.projectId}/pause`,
    ].sort(),
  );
  await onboarding.close();
  console.log('Multi-project UI smoke passed');
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
