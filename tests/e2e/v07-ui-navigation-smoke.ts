import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { chromium } from 'playwright';

const root = resolve('dist/web');
const project = {
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  displayName: '合成导航项目',
  repositoryOwner: 'cynos-ai',
  repositoryName: 'synthetic-navigation',
  status: 'active',
  configRevision: 1,
};
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
  const contentType =
    extension === '.js'
      ? 'text/javascript'
      : extension === '.css'
        ? 'text/css'
        : extension === '.png'
          ? 'image/png'
          : extension === '.ico'
            ? 'image/x-icon'
            : 'text/html';
  response.writeHead(200, { 'content-type': contentType }).end(bytes);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 768, height: 900 } });
  let authenticated = true;
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/mode') return route.fulfill({ json: { mode: 'multi-project' } });
    if (pathname === '/api/auth/status') {
      return route.fulfill({ json: { configured: true, authenticated } });
    }
    if (pathname === '/api/projects') return route.fulfill({ json: { projects: [project] } });
    if (pathname === '/api/auth/login') {
      authenticated = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    if (pathname === '/api/auth/logout') {
      authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: { message: '不存在' } } });
  });

  await page.goto(`${origin}/#/projects/${project.projectId}`);
  await page.getByRole('heading', { name: '项目概览' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/projects/${project.projectId}/overview`);
  assert.equal(new URL(page.url()).hash, '');
  await page.getByRole('region', { name: '当前项目' }).getByText(project.displayName).waitFor();
  const brandLink = page.getByRole('link', { name: '罗网工作台', exact: true });
  assert.equal(await brandLink.getAttribute('href'), '/workspace');
  await brandLink.locator('img').evaluate((image: HTMLImageElement) => image.decode());
  const userMenu = page.locator('.operator-menu');
  assert.equal(await userMenu.locator('.operator-avatar').textContent(), '管');
  await userMenu.locator('summary').click();
  assert.notEqual(await userMenu.getAttribute('open'), null);
  await page.keyboard.press('Escape');
  assert.equal(await userMenu.getAttribute('open'), null);
  await userMenu.locator('summary').click();
  await page.locator('.lw-header').click({ position: { x: 5, y: 5 } });
  assert.equal(await userMenu.getAttribute('open'), null);

  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('heading', { name: '项目', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/projects');
  await page.goBack();
  await page.getByRole('heading', { name: '项目概览' }).waitFor();

  await page.goto(`${origin}/system`);
  await page.getByRole('heading', { name: '系统状态' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '系统状态' }).waitFor();
  assert.equal(
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('link').count(),
    4,
  );
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '总览');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '项目');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '项目', exact: true }).waitFor();

  const projectRoot = `/projects/${project.projectId}`;
  const stableRoutes: Array<[string, string]> = [
    ['/workspace', '总览'],
    ['/projects', '项目'],
    ['/system', '系统状态'],
    ['/settings/models', '全局设置'],
    ['/settings/browser', '全局设置'],
    ['/settings/object-storage', '全局设置'],
    ['/settings/local-data', '全局设置'],
    ['/account', '账号设置'],
    [`${projectRoot}/overview`, '项目概览'],
    [`${projectRoot}/test`, '测试'],
    [`${projectRoot}/runs`, '测试记录'],
    [`${projectRoot}/runs/synthetic-run`, '测试 synthetic-run'],
    [`${projectRoot}/runs/synthetic-run/scenarios`, '测试 synthetic-run'],
    [`${projectRoot}/runs/synthetic-run/review`, '测试 synthetic-run'],
    [`${projectRoot}/runs/synthetic-run/report`, '测试 synthetic-run'],
    [`${projectRoot}/runs/synthetic-run/evidence`, '测试 synthetic-run'],
    [`${projectRoot}/runs/synthetic-run/technical`, '测试 synthetic-run'],
    [`${projectRoot}/scenarios`, '场景'],
    [`${projectRoot}/scenarios/synthetic-scenario`, 'synthetic-scenario'],
    [`${projectRoot}/readiness`, '运行准备'],
    ...['general', 'testing', 'environment', 'execution', 'automation', 'credentials'].map(
      (section) => [`${projectRoot}/settings/${section}`, '项目设置'] as [string, string],
    ),
  ];
  for (const [path, title] of stableRoutes) {
    await page.goto(`${origin}${path}`);
    await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
    assert.equal(await page.locator('h1').count(), 1);
  }

  await page.goto(`${origin}/projects/new`);
  await page.getByRole('heading', { level: 1, name: '项目', exact: true }).waitFor();
  const onboardingDialog = page.getByRole('dialog');
  await onboardingDialog.getByRole('heading', { name: '连接仓库', exact: true }).waitFor();
  assert.equal(await page.locator('h1').count(), 1);
  await onboardingDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForURL(`${origin}/projects`);

  await page.goto(`${origin}/settings/credentials`);
  await page.getByRole('heading', { level: 1, name: '全局设置', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/settings/models');
  assert.equal(await page.getByRole('link', { name: '全局凭据', exact: true }).count(), 0);

  await page.goto(`${origin}/does-not-exist`);
  await page.getByRole('heading', { name: '页面不存在' }).waitFor();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth);

  authenticated = false;
  await page.goto(`${origin}${projectRoot}/overview`);
  await page.getByRole('heading', { level: 1, name: '管理员登录' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login');
  await page.getByLabel('管理员密码').fill('synthetic-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { level: 1, name: '项目概览' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `${projectRoot}/overview`);
} finally {
  await browser.close();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}
