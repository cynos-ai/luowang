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
const projectAConfiguration = {
  language: 'zh-CN',
  scenarioBranch: 'scenario-testing',
  scenarioMode: 'autonomous',
  scenarioLabels: ['core'],
  pollIntervalSeconds: 60,
  cron: '',
  triggerOnCommit: true,
  environmentDescription: '合成非生产环境',
  baseUrl: 'https://fixture.example.test',
  externalDatabase: '',
  testDataCleanupUrl: '',
  executionDockerfile: 'Dockerfile',
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
const deploymentConfiguration = {
  language: 'zh-CN',
  provider: 'openai-compatible',
  providerBaseUrl: 'https://provider.example.test/v1',
  agents: {
    main: { model: 'deepseek-v4-flash', thinking: 'medium' },
    runner: { model: 'deepseek-v4-flash', thinking: 'low' },
    reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'high' },
  },
  local: { repoDir: '/data/repositories', reportDir: '/data/reports', retentionDays: 30 },
  mcp: { enabled: true, browser: 'chromium', headless: true, timeoutMs: 30000 },
  oss: {
    endpoint: 'https://oss.example.test',
    region: 'fixture',
    bucket: 'evidence',
    publicBaseUrl: 'https://evidence.example.test',
    accessMode: 'private',
    objectPrefix: 'luowang',
  },
};
const deploymentSecrets = {
  providerApiKey: { configured: true, masked: '••••' },
  ossAccessKeyId: { configured: false, masked: null },
  ossAccessKeySecret: { configured: false, masked: null },
};
let adminDisplayName = '管理员';
let created = false;
let ready = false;
let resumeCalls = 0;
let emptyWorkspace = false;
let readinessFailure = false;
let readinessGitTimeout = false;
let parallelPreparing = false;
let testPollingFailure = false;
let completedRun = false;
let zeroProgressRun = false;
let projectACurrentReads = 0;
let holdWorkspace = false;
let holdConfiguration = false;
let globalSettingsUnlocked = false;
let resourceInventoryFailure = false;
let catalogFailure = false;
let delayOpenAiCatalog = false;
let systemCheckFailure = false;
let releaseWorkspace: () => void = () => undefined;
let releaseConfiguration: () => void = () => undefined;
const workspaceGate = new Promise<void>((resolve) => {
  releaseWorkspace = resolve;
});
const configurationGate = new Promise<void>((resolve) => {
  releaseConfiguration = resolve;
});
const writes: string[] = [];
const apiRequests: string[] = [];

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
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    apiRequests.push(`${method} ${pathname}`);
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
      if (parallelPreparing) {
        workspace.activeRuns.push({
          ...workspace.activeRuns[0],
          project: projects[1],
          queueId: 2,
          runId: null,
          phase: 'preparing',
          stage: '准备目标，尚未创建 Run',
          progress: null,
        });
        workspace.capacity.occupied = 2;
      }
      if (globalSettingsUnlocked) workspace.activeRuns = [];
      if (zeroProgressRun && workspace.activeRuns[0]) {
        workspace.activeRuns[0].progress = { completed: 0, total: 0 };
        workspace.activeRuns[0].currentScenario = null;
      }
      return route.fulfill({ json: workspace });
    }
    if (pathname === '/api/system/status' && method === 'GET') {
      return route.fulfill({ json: fixture.systemStatus });
    }
    if (pathname === '/api/system/resources' && method === 'GET') {
      if (resourceInventoryFailure) {
        return route.fulfill({
          status: 503,
          json: { error: { message: '无法确认 Docker 资源归属' } },
        });
      }
      return route.fulfill({ json: fixture.systemResources });
    }
    if (/^\/api\/system\/checks\/(provider|browser|oss)$/.test(pathname) && method === 'POST') {
      const id = pathname.split('/').at(-1);
      const check = fixture.systemStatus.dependencies.find((item) => item.id === id)!;
      if (systemCheckFailure) {
        return route.fulfill({
          status: 500,
          json: { error: { message: '检查执行失败，请查看服务日志并重试' } },
        });
      }
      if (id === 'oss') {
        return route.fulfill({
          json: {
            check,
            result: {
              status: 'not_available',
              message: 'OSS 能力尚未提供',
              checkedAt: null,
              latencyMs: null,
            },
          },
        });
      }
      return route.fulfill({
        json: {
          check,
          result: {
            status: 'ok',
            message: check.message,
            checkedAt: check.checkedAt,
            latencyMs: 12,
          },
        },
      });
    }
    if (pathname === '/api/provider/providers' && method === 'GET') {
      return route.fulfill({
        json: {
          providers: [
            {
              id: 'openai-compatible',
              name: 'OpenAI compatible',
              baseUrl: 'https://provider.example.test/v1',
            },
            { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.example.test/v1' },
          ],
        },
      });
    }
    if (pathname === '/api/provider/models' && method === 'GET') {
      const provider = new URL(request.url()).searchParams.get('provider');
      if (provider === 'openai' && delayOpenAiCatalog)
        await new Promise((resolve) => setTimeout(resolve, 500));
      if (catalogFailure) {
        return route
          .fulfill({ status: 503, json: { error: { message: '目录暂不可用' } } })
          .catch(() => undefined);
      }
      return route
        .fulfill({
          json: {
            provider,
            models:
              provider === 'openai-compatible'
                ? [
                    {
                      id: 'deepseek-v4-flash',
                      name: 'DeepSeek Flash',
                      input: ['text'],
                      reasoning: true,
                      thinkingLevels: ['off', 'low'],
                      available: false,
                    },
                    {
                      id: 'deepseek-v4-flash-vision-exp',
                      name: 'DeepSeek Vision',
                      input: ['text', 'image'],
                      reasoning: true,
                      thinkingLevels: ['off', 'low'],
                      available: false,
                    },
                  ]
                : provider === 'openai'
                  ? [
                      {
                        id: 'gpt-vision-fixture',
                        name: 'OpenAI Vision',
                        input: ['text', 'image'],
                        reasoning: false,
                        thinkingLevels: ['off'],
                        available: false,
                      },
                    ]
                  : [],
          },
        })
        .catch(() => undefined);
    }
    if (pathname === '/api/deployment' && method === 'GET') {
      return route.fulfill({
        json: { configuration: deploymentConfiguration, secrets: deploymentSecrets },
      });
    }
    if (pathname === '/api/deployment' && method === 'PUT') {
      const patch = request.postDataJSON();
      if (patch.agents) deploymentConfiguration.agents = patch.agents;
      if (patch.mcp) deploymentConfiguration.mcp = patch.mcp;
      if (patch.oss) deploymentConfiguration.oss = patch.oss;
      if (patch.local)
        deploymentConfiguration.local = { ...deploymentConfiguration.local, ...patch.local };
      if (patch.provider !== undefined) deploymentConfiguration.provider = patch.provider;
      if (patch.providerBaseUrl !== undefined)
        deploymentConfiguration.providerBaseUrl = patch.providerBaseUrl;
      return route.fulfill({ json: { configuration: deploymentConfiguration } });
    }
    const deploymentSecretMatch = pathname.match(
      /^\/api\/deployment\/secrets\/(providerApiKey|ossAccessKeyId|ossAccessKeySecret)$/,
    );
    if (deploymentSecretMatch && ['PUT', 'DELETE'].includes(method)) {
      const key = deploymentSecretMatch[1] as keyof typeof deploymentSecrets;
      deploymentSecrets[key] =
        method === 'PUT'
          ? { configured: true, masked: '••••' }
          : { configured: false, masked: null };
      return route.fulfill({ json: { key, metadata: deploymentSecrets[key] } });
    }
    if (pathname === '/api/account' && method === 'GET') {
      return route.fulfill({ json: { profile: { displayName: adminDisplayName } } });
    }
    if (pathname === '/api/account' && method === 'PUT') {
      adminDisplayName = request.postDataJSON().displayName;
      return route.fulfill({ json: { profile: { displayName: adminDisplayName } } });
    }
    if (pathname === '/api/auth/password' && method === 'POST') {
      assert.equal(request.postDataJSON().currentPassword, 'current-password');
      return route.fulfill({ json: { authenticated: false, passwordChanged: true } });
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
    const projectABase = `/api/projects/${projects[0].projectId}`;
    if (pathname.startsWith(projectABase)) {
      const suffix = pathname.slice(projectABase.length);
      const projectData = fixture.projectData[projects[0].projectId];
      if (suffix === '' && method === 'GET') {
        return route.fulfill({
          json: {
            project: projects[0],
            configuration: projectAConfiguration,
            secrets: {
              gitToken: { configured: true, masked: '••••' },
              testUsername: { configured: true, masked: '••••' },
              testPassword: { configured: true, masked: '••••' },
              testDataCleanupToken: { configured: false, masked: null },
            },
          },
        });
      }
      if (suffix === '/readiness/status') {
        if (readinessGitTimeout)
          return route.fulfill({
            json: {
              readiness: {
                ...projectData.readiness,
                status: 'not_ready',
                checks: projectData.readiness.checks.map((check) =>
                  check.id === 'image'
                    ? {
                        ...check,
                        status: 'failed',
                        message: 'Git 远程检查超时，请检查仓库网络后重新检查',
                      }
                    : check,
                ),
              },
            },
          });
        if (readinessFailure) {
          return route.fulfill({
            status: 504,
            json: { error: { code: 'GIT_REMOTE_TIMEOUT', message: 'Git 远程检查超时' } },
          });
        }
        return route.fulfill({ json: { readiness: projectData.readiness } });
      }
      if (suffix === '/index') {
        return route.fulfill({
          json: {
            index: {
              commitSha: fixture.workspace.projects[0].indexedCommit,
              syncedAt: fixture.now,
              errors: [],
            },
          },
        });
      }
      if (suffix === '/runs') {
        const currentRun = zeroProgressRun
          ? {
              ...projectData.runs[0],
              scenarioProgress: { completed: 0, total: 0 },
              currentScenario: null,
              blockingReasons: ['Agent 会话异常，等待 Harness 收敛'],
              activities: [
                ...(projectData.runs[0].activities ?? []),
                { at: fixture.now, message: 'Agent 会话异常', kind: 'warning' },
              ],
            }
          : projectData.runs[0];
        const runs = completedRun
          ? [
              {
                ...currentRun,
                status: 'completed',
                phase: 'completed',
                result: 'passed',
                finishedAt: fixture.now,
                scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
                archive: {
                  reportStatus: 'published',
                  reportCommitSha: 'f'.repeat(40),
                  archiveStatus: 'completed',
                  archiveError: null,
                  progressed: true,
                  progressedAt: fixture.now,
                  scenarioStatus: 'pull_request',
                  scenarioCommitSha: null,
                  scenarioPrUrl: 'https://github.com/cynos-ai/cynos-website/pull/123',
                  scenarioError: null,
                },
              },
            ]
          : [currentRun];
        return route.fulfill({ json: { runs } });
      }
      if (suffix === '/runs/current') {
        projectACurrentReads += 1;
        if (testPollingFailure) {
          return route.fulfill({
            status: 503,
            json: { error: { code: 'TEMPORARY', message: '合成轮询失败' } },
          });
        }
        const run = zeroProgressRun
          ? {
              ...projectData.runs[0],
              scenarioProgress: { completed: 0, total: 0 },
              currentScenario: null,
              blockingReasons: ['Agent 会话异常，等待 Harness 收敛'],
              activities: [
                ...(projectData.runs[0].activities ?? []),
                { at: fixture.now, message: 'Agent 会话异常', kind: 'warning' },
              ],
            }
          : projectData.runs[0];
        return route.fulfill({ json: { run: completedRun ? null : run } });
      }
      if (suffix === '/queue') return route.fulfill({ json: { queue: projectData.queue } });
      if (suffix === '/scenarios') {
        return route.fulfill({ json: { scenarios: projectData.scenarios } });
      }
      const scenarioMatch = suffix.match(/^\/scenarios\/(.+)$/);
      if (scenarioMatch) {
        const scenario = structuredClone(projectData.scenarios[0]);
        scenario.content += '\n\n<script>window.__v07Xss = true</script>';
        return route.fulfill({ json: { scenario } });
      }
      if (suffix === '/reports') {
        return route.fulfill({ json: { reports: projectData.reports } });
      }
      if (suffix === `/reports/${projectData.runs[0].runId}`) {
        const report = structuredClone(projectData.reports[0]);
        report.content += '\n\n<img src=x onerror="window.__v07Xss=true">';
        return route.fulfill({ json: { report } });
      }
      if (suffix.startsWith(`/runs/${projectData.runs[0].runId}/evidence/`)) {
        return route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        });
      }
      if (suffix === `/runs/${projectData.runs[0].runId}`) {
        const baseRun = projectData.runs[0];
        return route.fulfill({
          json: {
            run: {
              ...baseRun,
              status: 'completed',
              phase: 'completed',
              result: 'passed',
              finishedAt: fixture.now,
              scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
              activities: [
                ...(baseRun.activities ?? []),
                {
                  at: fixture.now,
                  message: '合成清理告警',
                  kind: 'warning',
                  code: 'test_data_cleanup_failed',
                },
              ],
              archive: {
                reportStatus: 'published',
                reportCommitSha: 'f'.repeat(40),
                archiveStatus: 'completed',
                archiveError: null,
                progressed: true,
                progressedAt: fixture.now,
                scenarioStatus: 'pull_request',
                scenarioCommitSha: null,
                scenarioPrUrl: 'https://github.com/cynos-ai/cynos-website/pull/123',
                scenarioError: null,
              },
              issues: [],
              artifacts: {
                'review.md': '# AI Reviewer 审核\n\n审核结论：通过。',
                'report.md': '# 正式报告\n\n通过。',
              },
            },
          },
        });
      }
      if (suffix === '/repository/sync' && method === 'POST') {
        return route.fulfill({
          json: { sync: { status: 'synced', commitSha: 'a'.repeat(40), errors: [] } },
        });
      }
      if (suffix === '/readiness/check' && method === 'POST') {
        return route.fulfill({ json: { readiness: projectData.readiness } });
      }
    }
    const projectBBase = `/api/projects/${projects[1].projectId}`;
    if (pathname.startsWith(projectBBase)) {
      const suffix = pathname.slice(projectBBase.length);
      const projectData = fixture.projectData[projects[1].projectId];
      if (suffix === '' && method === 'GET') {
        return route.fulfill({
          json: {
            project: projects[1],
            configuration: projectAConfiguration,
            secrets,
          },
        });
      }
      if (suffix === '/readiness/status') {
        return route.fulfill({ json: { readiness: projectData.readiness } });
      }
      if (suffix === '/runs/current') return route.fulfill({ json: { run: null } });
      if (suffix === '/runs') return route.fulfill({ json: { runs: projectData.runs } });
      if (suffix === '/queue') return route.fulfill({ json: { queue: projectData.queue } });
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
    if (suffix === '/index' && method === 'GET') {
      return route.fulfill({
        json: { index: { commitSha: 'a'.repeat(40), syncedAt: fixture.now, errors: [] } },
      });
    }
    if (suffix === '/runs' && method === 'GET') {
      return route.fulfill({ json: { runs: [] } });
    }
    if (suffix === '/runs' && method === 'POST') {
      assert.ok(request.postDataJSON().request);
      return route.fulfill({ status: 202, json: { queue: { queueId: 31 } } });
    }
    if (suffix === '/merge' && method === 'POST') {
      const body = request.postDataJSON();
      assert.equal(body.confirmed, true);
      assert.equal(body.sourceRef, 'refs/heads/feat/synthetic');
      return route.fulfill({ status: 202, json: { queue: { queueId: 32 } } });
    }
    if (suffix === '/runs/current' && method === 'GET') {
      return route.fulfill({ json: { run: null } });
    }
    if (suffix === '/queue' && method === 'GET') {
      return route.fulfill({ json: { queue: [] } });
    }
    if (suffix === '/scenarios' && method === 'GET') {
      return route.fulfill({ json: { scenarios: [] } });
    }
    if (suffix === '/profile' && method === 'PUT') {
      newProject.displayName = request.postDataJSON().displayName;
      return route.fulfill({ json: { project: newProject } });
    }
    if (suffix === '/configuration' && method === 'PUT') {
      if (holdConfiguration) await configurationGate;
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
  parallelPreparing = true;
  await page.reload();
  await page.getByText('2/2 个项目正在处理').waitFor();
  assert.equal(await page.locator('.active-run-block .run-focus').count(), 2);
  assert.equal(
    await page.locator('.active-run-block a').nth(1).getAttribute('href'),
    `/projects/${projects[1].projectId}/test`,
  );
  parallelPreparing = false;
  await page.reload();
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
  const pauseButton = firstProject.getByRole('button', { name: '暂停', exact: true });
  await pauseButton.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await pauseButton.evaluate((element) => element === document.activeElement), true);
  await pauseButton.click();
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

  await page.goto(`${origin}/projects/${projects[0].projectId}/overview`);
  await page
    .getByRole('heading', { name: '测试正在执行' })
    .waitFor({ timeout: 5_000 })
    .catch(async () => {
      throw new Error(
        `${await page.locator('body').innerText()}\n${apiRequests.slice(-12).join('\n')}`,
      );
    });
  assert.equal(await page.locator('.overview-hero .button').count(), 1);
  await page.getByRole('link', { name: '运行准备', exact: true }).click();
  await page.getByRole('heading', { name: '仓库与同步' }).waitFor();
  assert.equal(await page.getByLabel('场景维护模式').count(), 0);
  await page.getByRole('button', { name: '同步场景与报告' }).click();
  await page.getByText(/同步场景与报告完成/).waitFor();
  await page.getByRole('button', { name: '准备或重建镜像' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '返回' }).click();
  readinessFailure = true;
  await page.reload();
  await page.getByText('Git 远程检查超时').waitFor();
  await page.getByRole('heading', { name: '仓库与同步' }).waitFor();
  readinessFailure = false;
  readinessGitTimeout = true;
  await page.reload();
  await page
    .getByRole('region', { name: '执行镜像', exact: true })
    .locator('p')
    .filter({ hasText: 'Git 远程检查超时，请检查仓库网络后重新检查' })
    .waitFor();
  readinessGitTimeout = false;

  await page.goto(`${origin}/projects/${projects[0].projectId}/settings/testing`);
  await page.getByText('设置暂时锁定').waitFor();
  assert.equal(await page.getByLabel('场景分支').isDisabled(), true);
  assert.ok(
    (await page.locator('.lock-notice').innerText()).includes(
      fixture.projectData[projects[0].projectId].runs[0].runId,
    ),
  );

  await page.goto(`${origin}/projects/${newProject.projectId}/settings/environment`);
  await page.getByLabel('环境说明').fill('有未保存修改的合成环境');
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /未保存/);
    await dialog.dismiss();
  });
  await page.getByRole('link', { name: '概览', exact: true }).click();
  assert.match(page.url(), /\/settings\/environment$/);
  holdConfiguration = true;
  const pendingWrite = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().endsWith(`/api/projects/${newProject.projectId}/configuration`),
  );
  await page.getByRole('button', { name: '保存测试环境' }).click();
  await pendingWrite;
  await page.getByRole('link', { name: '项目', exact: true }).click();
  assert.match(page.url(), /\/settings\/environment$/);
  releaseConfiguration();
  await page.getByText(/已保存不代表连通或就绪/).waitFor();
  assert.ok(writes.includes(`PUT /api/projects/${newProject.projectId}/configuration`));

  await page.goto(`${origin}/projects/${newProject.projectId}/test`);
  await page.getByRole('heading', { name: '发起测试' }).waitFor();
  await page.getByRole('button', { name: '纳入来源后测试' }).click();
  await page.getByLabel('测试要求').fill('验证合成来源变更');
  await page.getByLabel('来源 branch、tag 或 commit').fill('refs/heads/feat/synthetic');
  await page.getByLabel('我确认把该来源纳入当前项目场景测试分支后再测试').check();
  await page.getByRole('button', { name: '检查请求' }).click();
  const requestDialog = page.getByRole('dialog');
  await requestDialog.getByText('refs/heads/feat/synthetic').waitFor();
  await requestDialog.getByRole('button', { name: '确认进入队列' }).click();
  await page.getByText('测试请求已进入项目队列。').waitFor();
  assert.ok(writes.includes(`POST /api/projects/${newProject.projectId}/merge`));

  await page.goto(`${origin}/projects/${projects[1].projectId}/test`);
  await page.getByRole('heading', { name: '测试请求正在等待' }).waitFor();
  await page.getByText('项目已暂停', { exact: true }).waitFor();
  await page.getByLabel('项目内第 1 位').waitFor();

  await page.goto(`${origin}/projects/${projects[0].projectId}/test`);
  await page.getByRole('heading', { name: '验证登录状态恢复与注册错误处理' }).waitFor();
  assert.equal(await page.locator('.run-stages > li').count(), 8);
  await page.getByText('3/8').waitFor();
  zeroProgressRun = true;
  await page.reload();
  await page.getByText('0/0').waitFor();
  await page.getByText('Agent 会话异常', { exact: true }).waitFor();
  await page.getByText('Agent 会话异常，等待 Harness 收敛').waitFor();
  zeroProgressRun = false;
  await page.reload();
  await page.getByText('3/8').waitFor();
  testPollingFailure = true;
  await page.getByText(/自动刷新失败.*合成轮询失败/).waitFor({ timeout: 5_000 });
  await page.getByText('3/8').waitFor();
  testPollingFailure = false;
  const readsBeforeLeaving = projectACurrentReads;
  await page.getByRole('link', { name: '概览', exact: true }).click();
  await page.waitForTimeout(2_200);
  assert.equal(projectACurrentReads, readsBeforeLeaving);

  completedRun = true;
  await page.goto(`${origin}/projects/${projects[0].projectId}/test`);
  await page.getByRole('heading', { name: '验证登录状态恢复与注册错误处理' }).waitFor();
  await page.getByText('刚刚完成').waitFor();
  await page.getByRole('button', { name: '发起新测试' }).waitFor();

  const fixtureRunId = fixture.projectData[projects[0].projectId].runs[0].runId;
  await page.goto(`${origin}/projects/${projects[0].projectId}/runs`);
  await page.getByRole('heading', { name: '测试记录' }).waitFor();
  await page.getByText('正式报告已发布').waitFor();
  await page.goto(`${origin}/projects/${projects[0].projectId}/runs/${fixtureRunId}`);
  await page.getByText('数据清理告警：合成清理告警。该告警不改写正式测试结论。').waitFor();
  await page.getByRole('link', { name: '审核', exact: true }).click();
  await page
    .locator('.detail-panel > header')
    .getByRole('heading', { name: 'AI Reviewer 审核' })
    .waitFor();
  await page.getByText('这是 AI 角色工件，不是人工评分。').waitFor();
  await page.getByRole('link', { name: '正式报告', exact: true }).click();
  await page.locator('.detail-panel > header').getByRole('heading', { name: '正式报告' }).waitFor();
  assert.equal(await page.locator('.markdown-view script').count(), 0);
  assert.equal(
    await page.evaluate(() => (window as Window & { __v07Xss?: boolean }).__v07Xss),
    undefined,
  );
  await page.getByRole('link', { name: '证据', exact: true }).click();
  await page.getByText('页面含可见表单值').waitFor();
  await page.getByAltText('证据 login.png').waitFor();
  await page.getByRole('link', { name: '技术信息', exact: true }).click();
  await page.getByText(projects[0].projectId, { exact: true }).waitFor();

  await page.goto(`${origin}/projects/${projects[0].projectId}/scenarios`);
  await page.getByRole('link', { name: /AUTH-LOGIN-001 · 登录状态恢复/ }).click();
  await page.getByRole('heading', { name: '场景定义' }).waitFor();
  assert.equal(await page.locator('.markdown-view script').count(), 0);
  assert.equal(
    await page.evaluate(() => (window as Window & { __v07Xss?: boolean }).__v07Xss),
    undefined,
  );

  await page.goto(`${origin}/projects/${projects[1].projectId}/runs/${fixtureRunId}`);
  await page.getByText('读取失败').waitFor();
  await page.goto(`${origin}/projects/${projects[1].projectId}/scenarios/AUTH-LOGIN-001`);
  await page.getByText('读取失败').waitFor();

  resourceInventoryFailure = true;
  await page.goto(`${origin}/system`);
  await page.getByRole('heading', { name: '系统状态' }).waitFor();
  await page.getByText('无法确认 Docker 资源归属').waitFor();
  assert.equal(await page.getByText(`sha256:${'d'.repeat(64)}`).count(), 0);
  resourceInventoryFailure = false;
  await page.getByRole('button', { name: '重试' }).click();
  await page.getByText('正在引用').waitFor();
  await page.getByRole('button', { name: '立即检查' }).last().click();
  assert.ok(writes.includes('POST /api/system/checks/oss'));
  await page.getByText('OSS 能力尚未提供').waitFor();
  systemCheckFailure = true;
  await page.getByRole('button', { name: '立即检查' }).nth(1).click();
  await page.getByText('检查执行失败，请查看服务日志并重试').waitFor();
  systemCheckFailure = false;

  await page.goto(`${origin}/settings/models`);
  await page.getByText(/全局执行配置已锁定，相关测试记录/).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存本分组' }).isDisabled(), true);
  globalSettingsUnlocked = true;
  await page.reload();
  await page.getByRole('heading', { name: '模型与角色' }).waitFor();
  await page.getByText('已载入 2 个已知模型').waitFor();
  assert.equal(await page.locator('#global-provider-catalog option').count(), 2);
  assert.equal(await page.locator('#global-model-catalog-reviewer option').count(), 2);
  const roleModels = page.locator('.agent-config input[type="search"]');
  await roleModels.nth(2).fill('deepseek-v4-flash');
  await page.getByText('该模型不支持图像输入，视觉场景将被阻塞。').waitFor();
  await roleModels.nth(2).fill('deepseek-v4-flash-vision-exp');
  assert.equal(await page.getByText('该模型不支持图像输入，视觉场景将被阻塞。').count(), 0);
  const providerInput = page.locator('input[list="global-provider-catalog"]');
  const baseUrlInput = page.getByLabel('Provider Base URL');
  assert.equal(await baseUrlInput.inputValue(), 'https://provider.example.test/v1');
  const assertCatalogLayout = async () => {
    const status = await page.locator('.catalog-summary').boundingBox();
    assert.ok(status);
    for (const role of await page.locator('.agent-config').all()) {
      const box = await role.boundingBox();
      assert.ok(box && box.y >= status.y + status.height - 1, 'catalog occupies its own row');
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
    );
  };
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await assertCatalogLayout();
    delayOpenAiCatalog = true;
    await providerInput.fill('openai');
    await page.getByText('正在加载已知模型目录…').waitFor();
    await assertCatalogLayout();
    await page.getByText('已载入 1 个已知模型').waitFor();
    await assertCatalogLayout();
    await providerInput.fill('unknown-fixture');
    await page.getByText('暂无已知模型', { exact: true }).waitFor();
    await assertCatalogLayout();
    catalogFailure = true;
    await providerInput.fill('openai-compatible');
    await page.getByText(/目录加载失败：目录暂不可用/).waitFor();
    await assertCatalogLayout();
    catalogFailure = false;
    await providerInput.fill('openai');
    await page.getByText('已载入 1 个已知模型').waitFor();
    await providerInput.fill('openai-compatible');
    await page.getByText('已载入 2 个已知模型').waitFor();
  }
  delayOpenAiCatalog = true;
  const pendingCatalog = page.waitForRequest((request) =>
    request.url().includes('/api/provider/models?provider=openai'),
  );
  await providerInput.fill('openai');
  assert.equal(await baseUrlInput.inputValue(), 'https://api.openai.example.test/v1');
  await pendingCatalog;
  await providerInput.fill('openai-compatible');
  assert.equal(await baseUrlInput.inputValue(), 'https://provider.example.test/v1');
  await page.getByText('已载入 2 个已知模型').waitFor();
  await page.waitForTimeout(550);
  assert.equal(
    await page.locator('#global-model-catalog-main option[value="gpt-vision-fixture"]').count(),
    0,
  );
  delayOpenAiCatalog = false;
  catalogFailure = true;
  await providerInput.fill('openai');
  await page.getByText(/目录加载失败：目录暂不可用/).waitFor();
  await roleModels.nth(0).fill('manual-model-id');
  assert.equal(await roleModels.nth(0).inputValue(), 'manual-model-id');
  catalogFailure = false;
  await providerInput.fill('openai-compatible');
  await page.getByText('已载入 2 个已知模型').waitFor();
  await roleModels.nth(0).fill('deepseek-v4-flash');
  await providerInput.fill('fixture-provider');
  assert.equal(await baseUrlInput.inputValue(), '');
  await page.getByLabel('Provider API Key').fill('synthetic-provider-key');
  await page.getByRole('button', { name: '保存本分组' }).click();
  await page.getByText('配置与 Provider API Key 已保存。').waitFor();
  assert.ok(writes.includes('PUT /api/deployment'));
  assert.ok(writes.includes('PUT /api/deployment/secrets/providerApiKey'));
  assert.equal((await page.locator('body').innerText()).includes('synthetic-provider-key'), false);
  await page.goto(`${origin}/settings/credentials`);
  assert.equal((await page.locator('body').innerText()).includes('GitHub Token'), false);
  assert.equal((await page.locator('body').innerText()).includes('测试账号'), false);
  await page.getByLabel('新值（不会回显）').nth(1).fill('synthetic-oss-key');
  await page.getByRole('button', { name: '保存', exact: true }).nth(0).click();
  await page.getByText('凭据已更新。', { exact: true }).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('synthetic-oss-key'), false);

  await page.goto(`${origin}/account`);
  await page.getByLabel('管理员显示名称').fill('罗网管理员');
  await page.getByRole('button', { name: '保存显示名称' }).click();
  await page.getByText('显示名称已更新为“罗网管理员”。').waitFor();

  holdWorkspace = true;
  const delayedRequest = page.waitForRequest((request) => request.url().endsWith('/api/workspace'));
  await page.getByRole('link', { name: '工作台', exact: true }).click();
  await delayedRequest;
  await page.getByRole('link', { name: '系统状态', exact: true }).click();
  await page.getByRole('heading', { name: '系统状态' }).waitFor();
  releaseWorkspace();
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Runner 执行').count(), 0);

  const responsivePaths = [
    '/workspace',
    `/projects/new?projectId=${newProject.projectId}`,
    `/projects/${projects[0].projectId}/overview`,
    `/projects/${projects[0].projectId}/readiness`,
    `/projects/${newProject.projectId}/settings/credentials`,
    `/projects/${projects[0].projectId}/test`,
    `/projects/${projects[0].projectId}/runs`,
    `/projects/${projects[0].projectId}/runs/${fixtureRunId}/evidence`,
    `/projects/${projects[0].projectId}/scenarios/AUTH-LOGIN-001`,
    '/system',
    '/settings/models',
    '/settings/credentials',
    '/account',
  ];
  for (const width of [1440, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of responsivePaths) {
      await page.goto(`${origin}${path}`);
      await page.locator('h1').waitFor();
      await page.addStyleTag({ content: 'html { overflow-y: scroll; scrollbar-gutter: stable; }' });
      assert.ok(
        await page.evaluate(() => document.documentElement.clientWidth < window.innerWidth),
        'vertical scrollbar must consume layout width',
      );
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.equal(
        dimensions.scrollWidth,
        dimensions.clientWidth,
        `overflow at ${width}px: ${path}`,
      );
      assert.equal(await page.locator('h1').count(), 1, `expected one h1 at ${path}`);
    }
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 768,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 1536,
    screenHeight: 1800,
  });
  await page.goto(`${origin}/settings/models`);
  await page.getByRole('heading', { name: '全局设置' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    '跳到主要内容',
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle),
    'solid',
  );
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  assert.equal(await page.evaluate(() => window.devicePixelRatio), 2);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
    true,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animationDuration = '10s';
    probe.style.transitionDuration = '10s';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = { animation: style.animationDuration, transition: style.transitionDuration };
    probe.remove();
    return result;
  });
  assert.ok(['0.01ms', '1e-05s'].includes(reducedMotion.animation));
  assert.ok(['0.01ms', '1e-05s'].includes(reducedMotion.transition));
  await cdp.detach();

  await page.goto(`${origin}/account`);
  await page.getByLabel('当前密码').fill('current-password');
  await page.getByLabel('新密码', { exact: true }).fill('new-password-123');
  await page.getByLabel('确认新密码').fill('different-password');
  await page.getByRole('button', { name: '更新密码并退出' }).click();
  await page.getByText('两次输入的新密码不一致').waitFor();
  await page.getByLabel('确认新密码').fill('new-password-123');
  await page.getByRole('button', { name: '更新密码并退出' }).click();
  await page.getByRole('heading', { name: '管理员登录' }).waitFor();
  assert.ok(writes.includes('POST /api/auth/password'));

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
