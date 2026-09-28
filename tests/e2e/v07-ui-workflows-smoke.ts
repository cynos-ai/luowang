import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { chromium } from 'playwright';

import { createV07ConsoleFixture } from './fixtures/v07-console-fixture.js';

const root = resolve('dist/web');
const fixture = createV07ConsoleFixture();
const emptyFixture = createV07ConsoleFixture({ state: 'empty' });
const projects = structuredClone(fixture.projects);
const newProject = {
  projectId: '33333333-3333-4333-8333-333333333333',
  displayName: '合成接入项目',
  githubRepositoryId: '1003',
  repositoryOwner: 'cynos-ai',
  repositoryName: 'synthetic-onboarding',
  status: 'paused' as 'active' | 'paused',
  configRevision: 1,
  createdAt: fixture.now,
  updatedAt: fixture.now,
};
const configuration = {
  language: 'zh-CN',
  scenarioBranch: 'scenario-testing',
  scenarioMode: 'autonomous',
  scenarioLabels: [],
  pollIntervalSeconds: 0,
  cron: '',
  triggerOnCommit: false,
  environmentDescription: '',
  baseUrl: '',
  externalDatabase: '',
  testDataCleanupUrl: '',
  executionDockerfile: '',
};
const secrets = {
  gitToken: { configured: false, masked: null },
  testUsername: { configured: false, masked: null },
  testPassword: { configured: false, masked: null },
  testDataCleanupToken: { configured: false, masked: null },
};
let created = false;
let ready = false;
let resumeCalls = 0;
let emptyWorkspace = false;
let holdWorkspace = false;
let releaseWorkspace: () => void = () => undefined;
const workspaceGate = new Promise<void>((resolve) => {
  releaseWorkspace = resolve;
});
const writes: string[] = [];

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  let path = candidate;
  try {
    await readFile(path);
  } catch {
    path = resolve(root, 'index.html');
  }
  const bytes = await readFile(path);
  const extension = extname(path);
  response
    .writeHead(200, {
      'content-type':
        extension === '.js' ? 'text/javascript' : extension === '.css' ? 'text/css' : 'text/html',
    })
    .end(bytes);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (method !== 'GET') writes.push(`${method} ${pathname}`);
    if (pathname === '/api/mode') return route.fulfill({ json: { mode: 'multi-project' } });
    if (pathname === '/api/auth/status') {
      return route.fulfill({ json: { configured: true, authenticated: true } });
    }
    if (pathname === '/api/workspace') {
      if (holdWorkspace) await workspaceGate;
      if (emptyWorkspace) return route.fulfill({ json: emptyFixture.workspace });
      const workspace = structuredClone(fixture.workspace);
      workspace.projects[0].project.status = projects[0].status;
      return route.fulfill({ json: workspace });
    }
    if (pathname === '/api/projects' && method === 'GET') {
      return route.fulfill({ json: { projects: created ? [...projects, newProject] : projects } });
    }
    if (pathname === '/api/projects' && method === 'POST') {
      const body = request.postDataJSON();
      assert.equal(body.displayName, newProject.displayName);
      assert.equal(body.repositoryUrl, 'https://github.com/cynos-ai/synthetic-onboarding');
      created = true;
      return route.fulfill({ status: 201, json: { project: newProject } });
    }
    if (pathname === `/api/projects/${projects[0].projectId}/pause` && method === 'POST') {
      projects[0].status = 'paused';
      return route.fulfill({ json: { project: projects[0] } });
    }
    const base = `/api/projects/${newProject.projectId}`;
    if (!pathname.startsWith(base)) {
      return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
    }
    const suffix = pathname.slice(base.length);
    if (suffix === '' && method === 'GET') {
      return route.fulfill({ json: { project: newProject, configuration, secrets } });
    }
    if (suffix === '/readiness/status' && method === 'GET') {
      return route.fulfill({ json: { readiness: readiness() } });
    }
    if (suffix === '/configuration' && method === 'PUT') {
      Object.assign(configuration, request.postDataJSON());
      newProject.configRevision += 1;
      return route.fulfill({ json: { project: newProject, configuration } });
    }
    const secretMatch = suffix.match(
      /^\/secrets\/(gitToken|testUsername|testPassword|testDataCleanupToken)$/,
    );
    if (secretMatch && method === 'PUT') {
      const key = secretMatch[1] as keyof typeof secrets;
      assert.ok(request.postDataJSON().value);
      secrets[key] = { configured: true, masked: '••••' };
      return route.fulfill({ json: { key, metadata: secrets[key] } });
    }
    if (suffix === '/image/prepare' && method === 'POST') {
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
    if (suffix === '/readiness/check' && method === 'POST') {
      ready = true;
      return route.fulfill({ json: { readiness: readiness() } });
    }
    if (suffix === '/resume' && method === 'POST') {
      resumeCalls += 1;
      assert.equal(ready, true);
      newProject.status = 'active';
      return route.fulfill({ json: { project: newProject, readiness: readiness() } });
    }
    return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
  });

  await page.goto(`${origin}/workspace`);
  await page.getByRole('heading', { name: '需要处理' }).waitFor();
  await page.getByText('Runner 执行').waitFor();
  await page.getByText('3/8').waitFor();
  await page.getByText('验证固定验收场景').waitFor();
  emptyWorkspace = true;
  await page.reload();
  await page.getByText('还没有项目').waitFor();
  assert.deepEqual(await page.locator('.empty-callout li').allTextContents(), [
    '连接 GitHub 仓库',
    '配置非生产测试环境',
    '检查并明确启用项目',
  ]);
  emptyWorkspace = false;

  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: '已暂停' }).click();
  assert.equal(await page.getByText('Closure 7 Fixture').count(), 1);
  await page.getByRole('button', { name: '全部' }).click();
  const firstProject = page.locator('.project-directory > li').first();
  assert.ok((await firstProject.innerText()).includes('官网非生产测试'));
  await firstProject.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认暂停' }).click();
  await page.getByText('官网非生产测试').waitFor();
  assert.ok(writes.includes(`POST /api/projects/${projects[0].projectId}/pause`));

  await page.goto(`${origin}/projects/new`);
  await page.getByLabel('项目名称').fill(newProject.displayName);
  await page.getByLabel('GitHub 仓库地址').fill('https://github.com/cynos-ai/synthetic-onboarding');
  await page.getByLabel('GitHub Token（私有仓库必填）').fill('synthetic-secret-token');
  await page.getByRole('button', { name: '核验并创建暂停项目' }).click();
  await page.getByRole('heading', { name: '配置测试' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('projectId'), newProject.projectId);
  assert.equal((await page.locator('body').innerText()).includes('synthetic-secret-token'), false);

  await page.getByLabel('生成语言').fill('en-US');
  await page.getByRole('button', { name: '保存测试配置' }).click();
  await page.getByText('保存测试配置完成').waitFor();
  await page.getByLabel('非生产环境 URL').fill('https://synthetic.example.test');
  await page.getByRole('button', { name: '保存环境配置' }).click();
  await page.getByText('保存环境配置完成').waitFor();

  await page.getByLabel(/测试账号 · 未配置/).fill('synthetic-user');
  await page
    .getByLabel(/测试账号 · 未配置/)
    .locator('xpath=ancestor::div[contains(@class,"secret-editor")]')
    .getByRole('button', { name: '保存' })
    .click();
  await page.getByText('保存测试账号完成').waitFor();
  assert.equal((await page.locator('body').innerText()).includes('synthetic-user'), false);

  await page.getByRole('button', { name: '准备执行镜像' }).click();
  await page.getByText('准备执行镜像完成').waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '准备并启用' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('projectId'), newProject.projectId);
  assert.equal(resumeCalls, 0);
  await page.getByRole('button', { name: '运行全部检查' }).click();
  await page.getByText('运行准备检查完成').waitFor();
  assert.equal(resumeCalls, 0);
  await page.getByRole('button', { name: '明确启用项目' }).click();
  await page.getByText('启用项目完成').waitFor();
  assert.equal(resumeCalls, 1);
  await page.getByRole('button', { name: '项目已启用' }).waitFor();

  holdWorkspace = true;
  const delayedRequest = page.waitForRequest((request) => request.url().endsWith('/api/workspace'));
  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await delayedRequest;
  await page.getByRole('link', { name: '系统状态', exact: true }).click();
  await page.getByRole('heading', { name: '系统状态' }).waitFor();
  releaseWorkspace();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Runner 执行').count(), 0);

  await page.setViewportSize({ width: 768, height: 900 });
  for (const path of ['/workspace', `/projects/new?projectId=${newProject.projectId}`]) {
    await page.goto(`${origin}${path}`);
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(dimensions.scrollWidth, dimensions.clientWidth);
    assert.equal(await page.locator('h1').count(), 1);
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

function readiness() {
  const status = ready ? ('ok' as const) : ('not_checked' as const);
  return {
    status: ready ? ('ready' as const) : ('not_checked' as const),
    checkedAt: ready ? fixture.now : null,
    staleReason: null,
    checks: [
      {
        id: 'repository',
        label: '仓库身份',
        status,
        message: ready ? '通过' : '尚未检查',
        checkedAt: ready ? fixture.now : null,
      },
      {
        id: 'environment',
        label: '非生产环境',
        status,
        message: ready ? '通过' : '尚未检查',
        checkedAt: ready ? fixture.now : null,
      },
      {
        id: 'credentials',
        label: '测试凭据',
        status,
        message: ready ? '通过' : '尚未检查',
        checkedAt: ready ? fixture.now : null,
      },
      {
        id: 'image',
        label: '执行镜像',
        status,
        message: ready ? '通过' : '尚未检查',
        checkedAt: ready ? fixture.now : null,
      },
    ],
  };
}
