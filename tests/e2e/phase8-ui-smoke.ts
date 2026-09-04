import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import type {
  ConfigResponse,
  ConnectivityCheck,
  IndexedReport,
  IndexedScenario,
  OperationsCurrentResponse,
  OperationsDashboardResponse,
  OperationsGitTreeResponse,
  OperationsRunDetail,
  OperationsRunSummary,
  OperationsScenario,
  ProviderModelInfo,
  RepositoryHistoryResponse,
  RepositoryStatusResponse,
} from '../../src/shared/types.js';

const HASHES = {
  base: 'a'.repeat(40),
  target: 'b'.repeat(40),
  indexed: 'c'.repeat(40),
  head: 'd'.repeat(40),
  report: 'e'.repeat(40),
};

const RUN_IDS = {
  passed: '01K000P0000000000000000001',
  failed: '01K000F0000000000000000002',
  blocked: '01K000B0000000000000000003',
  interrupted: '01K000I0000000000000000004',
  active: '01K000A0000000000000000005',
};

const SCENARIO_ID = 'AUTH-LOGIN-001';
const PR_URL = 'https://github.com/cynos-ai/cynos-website/pull/88';
const ISSUE_URL = 'https://github.com/cynos-ai/cynos-website/issues/42';
const ADMIN_PASSWORD = 'phase8-ui-smoke-admin-password!';

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
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : 'request failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${lastError}`);
}

const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase8-ui-'));
const port = await getAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/server/main.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_HOST: '127.0.0.1',
    LUOWANG_PORT: String(port),
    LUOWANG_LOG_LEVEL: 'silent',
    LUOWANG_ADMIN_PASSWORD: ADMIN_PASSWORD,
    LUOWANG_MASTER_KEY: 'phase8-ui-smoke-master-key-material',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stdout?.resume();
child.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});

const scenario = makeScenario();
const reports = [makeReport()];
const history = makeHistory(reports);
const status = makeRepositoryStatus();
const tree = makeGitTree();
const current = makeCurrent();
let config = makeConfig();
let archiveRetried = false;
let nextSubmission = 0;
let expireNextDashboard = false;
const responseBodies: string[] = [];

try {
  await waitForHealth(port, child);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
    const page = await context.newPage();
    page.on('response', (response) => {
      if (!response.url().includes('/api/')) return;
      void response
        .text()
        .then((body) => responseBodies.push(body))
        .catch(() => undefined);
    });
    await installApiFixtures(page);

    await page.goto(baseUrl);
    await page.getByRole('heading', { name: '管理员登录' }).waitFor();
    await page.getByLabel('管理员密码').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: '运维控制台' }).waitFor();
    await page.getByRole('heading', { name: '测试分支与运行状态' }).waitFor();
    await page.getByText('数据可能陈旧：GitHub 与 OSS 暂时不可用', { exact: false }).waitFor();

    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('heading', { name: '模型服务' }).waitFor();
    await page.getByText('已载入 3 个 deepseek 模型', { exact: true }).waitFor();
    await page.getByLabel('Provider Base URL（可选）').fill('https://models.example.test/v1');
    await page.getByLabel('环境说明').fill('尚未保存的环境草稿');
    const providerSection = page.locator('section').filter({ hasText: '模型服务' }).first();
    await providerSection.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('模型服务配置已保存', { exact: true }).waitFor();
    await providerSection.getByText('配置已更新，等待检查', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('环境说明').inputValue(), '尚未保存的环境草稿');
    await providerSection.getByRole('button', { name: '保存并测试', exact: true }).click();
    await page.getByText('模型 Provider 与模型：Provider 可用', { exact: true }).waitFor();

    const reviewerCard = page.locator('.agent-card').filter({ hasText: 'Reviewer' });
    await reviewerCard.getByText('需要视觉', { exact: true }).waitFor();
    await reviewerCard.getByLabel('模型').fill('unknown-reviewer-model');
    await reviewerCard.getByText('未匹配当前 Provider 目录', { exact: false }).waitFor();
    await reviewerCard.getByLabel('模型').fill('deepseek-v4-flash');
    await reviewerCard.getByText('该模型不支持图像输入', { exact: false }).waitFor();
    await reviewerCard.getByLabel('模型').fill('deepseek-v4-flash-vision-exp');
    await reviewerCard.getByText('视觉', { exact: true }).waitFor();

    await page.getByRole('heading', { name: 'GitHub 仓库' }).waitFor();
    await page.getByLabel('目标仓库').fill('https://github.com/cynos-ai/cynos-website');
    const repositorySection = page.locator('section').filter({ hasText: 'GitHub 仓库' }).first();
    await repositorySection.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('GitHub 仓库配置已保存', { exact: true }).waitFor();
    assert.ok((await page.getByText('•••••••• · 已安全保存', { exact: true }).count()) > 0);

    await page.getByRole('button', { name: 'Git 树', exact: true }).click();
    await page.getByRole('heading', { name: '仓库事实与场景' }).waitFor();
    await page.getByRole('button', { name: '同步索引', exact: true }).click();
    await page.getByText('索引已同步', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: 'Git 树' }).click();
    await page.getByText('包含 2 次', { exact: false }).waitFor();
    await page.getByText('目标', { exact: false }).waitFor();

    await page.getByRole('button', { name: '总览', exact: true }).click();
    await page.getByRole('heading', { name: '发起一次测试' }).waitFor();
    await page.getByLabel('测试请求').fill('验证 Cynos 官网登录后的会话保持');
    await page.getByRole('button', { name: '提交测试请求', exact: true }).click();
    await page.getByText('请求已进入队列：#101', { exact: true }).waitFor();

    await page.getByRole('button', { name: '当前测试', exact: true }).click();
    await page.getByRole('heading', { name: /当前测试 · Runner/ }).waitFor();
    await page.getByText('Runner 正在执行场景', { exact: true }).waitFor();
    await page.getByText('AUTH-LOGIN-001', { exact: true }).waitFor();
    assert.equal(await page.getByText('fixture-provider-secret', { exact: false }).count(), 0);

    await page.getByRole('button', { name: '场景', exact: true }).click();
    await page.getByRole('heading', { name: '长期场景' }).waitFor();
    await page.locator('details.scenario-detail summary').click();
    await page.getByText('window.__luowangXss = true', { exact: false }).waitFor();
    assert.equal(
      await page.locator('script').filter({ hasText: 'window.__luowangXss' }).count(),
      0,
    );
    assert.equal(
      await page.evaluate(() => (window as Window & { __luowangXss?: boolean }).__luowangXss),
      undefined,
    );
    await page.getByPlaceholder('ID、名称、描述、正文或标签').fill('不存在的场景');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByText('没有符合筛选条件的场景', { exact: false }).waitFor();

    await page.getByRole('button', { name: 'Runs', exact: true }).click();
    await page.getByRole('heading', { name: '测试 Runs' }).waitFor();
    await page.locator('.run-table tbody tr').first().waitFor();
    assert.equal(await page.locator('.run-table tbody tr').count(), 4);
    for (const result of ['passed', 'failed', 'blocked', '进行中']) {
      await page.locator('.run-table .result-text').filter({ hasText: result }).first().waitFor();
    }
    await page.getByRole('button', { name: RUN_IDS.failed.slice(0, 12), exact: true }).click();
    await page.getByRole('heading', { name: RUN_IDS.failed }).waitFor();
    await page
      .locator('details.artifact-card summary')
      .filter({ hasText: /^report\.md$/ })
      .click();
    await page.getByText('safe final report', { exact: false }).waitFor();
    await page.getByRole('link', { name: /Issue 42/ }).waitFor();
    await page.getByRole('link', { name: /login\.png/ }).waitFor();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '重试归档', exact: true }).click();
    await page.getByText('report：published', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重试归档', exact: true }).count(), 0);

    await page.getByRole('button', { name: RUN_IDS.blocked.slice(0, 12), exact: true }).click();
    await page.getByRole('heading', { name: RUN_IDS.blocked }).waitFor();
    await page
      .locator('details.artifact-card summary')
      .filter({ hasText: /^draft-report\.md$/ })
      .click();
    await page.locator('p.muted:visible').filter({ hasText: '不适用或尚未产生' }).first().waitFor();
    await page.getByText('scenario-changes.patch', { exact: true }).waitFor();
    await page.getByRole('link', { name: PR_URL, exact: true }).waitFor();

    await page.getByRole('button', { name: '总览', exact: true }).click();
    expireNextDashboard = true;
    await page.getByRole('button', { name: '刷新', exact: true }).first().click();
    await page.getByRole('heading', { name: '管理员登录' }).waitFor();
    await page.getByText('登录已过期，请重新登录', { exact: true }).waitFor();

    await page.getByLabel('管理员密码').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: '运维控制台' }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('heading', { name: '管理员登录' }).waitFor();

    await page.waitForTimeout(200);
    const visibleText = await page.locator('body').innerText();
    assert.equal(visibleText.includes('fixture-provider-secret'), false);
    assert.equal(responseBodies.join('\n').includes('fixture-provider-secret'), false);
    assert.equal(responseBodies.join('\n').includes('hidden reasoning'), false);
    await context.close();
  } finally {
    await browser.close();
  }
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

console.log('phase 8 headless UI smoke passed');

async function installApiFixtures(page: import('playwright').Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/config' && request.method() === 'GET') {
      return fulfillJson(route, config);
    }
    if (path === '/api/provider/providers' && request.method() === 'GET') {
      return fulfillJson(route, {
        providers: [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'openai', name: 'OpenAI' },
        ],
      });
    }
    if (path === '/api/provider/models' && request.method() === 'GET') {
      return fulfillJson(route, {
        provider: url.searchParams.get('provider') ?? config.harness.provider,
        models: makeProviderModels(),
      });
    }
    if (path.startsWith('/api/connectivity/checks/') && request.method() === 'POST') {
      const checkId = path.slice('/api/connectivity/checks/'.length);
      const check = makeChecks().find((item) => item.id === checkId);
      return check
        ? fulfillJson(route, check)
        : fulfillJson(route, { error: { message: 'Check not found' } }, 404);
    }
    if (path === '/api/config/repository' && request.method() === 'PUT') {
      const body = readJson(request.postData());
      const repositoryPatch = { ...body };
      delete repositoryPatch.secrets;
      config = {
        ...config,
        repository: { ...config.repository, ...repositoryPatch },
      } as ConfigResponse;
      return fulfillJson(route, config);
    }
    if (path === '/api/config/harness' && request.method() === 'PUT') {
      const body = readJson(request.postData());
      const harnessPatch = { ...body };
      delete harnessPatch.secrets;
      config = { ...config, harness: { ...config.harness, ...harnessPatch } } as ConfigResponse;
      return fulfillJson(route, config);
    }
    if (path === '/api/connectivity/checks' && request.method() === 'GET') {
      return fulfillJson(route, { checks: makeChecks() });
    }
    if (path === '/api/operations/dashboard' && request.method() === 'GET') {
      if (expireNextDashboard) {
        expireNextDashboard = false;
        return fulfillJson(
          route,
          {
            error: {
              code: 'AUTH_REQUIRED',
              message: '登录已过期，请重新登录',
              requestId: 'phase8-ui-smoke',
            },
          },
          401,
        );
      }
      return fulfillJson(route, makeDashboard());
    }
    if (path === '/api/operations/git-tree' && request.method() === 'GET') {
      return fulfillJson(route, tree);
    }
    if (path === '/api/operations/scenarios' && request.method() === 'GET') {
      return fulfillJson(route, {
        scenarios: url.searchParams.get('query') === '不存在的场景' ? [] : [scenario],
      });
    }
    if (path === '/api/operations/runs' && request.method() === 'GET') {
      return fulfillJson(route, { runs: makeRuns() });
    }
    if (path.startsWith('/api/operations/runs/') && request.method() === 'GET') {
      const runId = path.slice('/api/operations/runs/'.length);
      const run = makeRuns().find((item) => item.runId === runId);
      return run
        ? fulfillJson(route, { run: makeDetail(run) })
        : fulfillJson(route, { error: { message: 'Run not found' } }, 404);
    }
    if (path === '/api/operations/current' && request.method() === 'GET') {
      return fulfillJson(route, current);
    }
    if (path === '/api/repository/status' && request.method() === 'GET') {
      return fulfillJson(route, status);
    }
    if (path === '/api/repository/sync' && request.method() === 'POST') {
      return fulfillJson(route, {
        status: 'synced',
        commitSha: HASHES.head,
        syncedAt: '2026-08-30T03:00:00.000Z',
        scenarios: 1,
        reports: 1,
        errors: [],
        message: '索引已同步',
      });
    }
    if (path === '/api/scenarios' && request.method() === 'GET') {
      return fulfillJson(route, { scenarios: [scenario] });
    }
    if (path === '/api/reports' && request.method() === 'GET') {
      return fulfillJson(route, { reports });
    }
    if (path === '/api/history' && request.method() === 'GET') {
      return fulfillJson(route, history);
    }
    if (path === '/api/runs' && request.method() === 'POST') {
      nextSubmission += 1;
      return fulfillJson(route, { queueId: 100 + nextSubmission, status: 'queued' }, 202);
    }
    if (path.match(/^\/api\/runs\/[^/]+\/archive$/) && request.method() === 'POST') {
      archiveRetried = true;
      return fulfillJson(route, { archive: { status: 'completed' } });
    }
    return route.continue();
  });
}

async function fulfillJson(route: import('playwright').Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

function readJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  return JSON.parse(value) as Record<string, unknown>;
}

function makeConfig(): ConfigResponse {
  return {
    harness: {
      language: 'zh-CN',
      provider: 'deepseek',
      providerBaseUrl: '',
      agents: {
        main: { model: 'deepseek-v4-flash', thinking: 'medium' },
        runner: { model: 'deepseek-v4-flash', thinking: 'medium' },
        reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'medium' },
      },
      local: { repoDir: '/data/repository', reportDir: '/data/reports', retentionDays: 7 },
      mcp: { enabled: true, browser: 'chromium', headless: true, timeoutMs: 30_000 },
      oss: {
        endpoint: 'https://oss.example.test',
        region: 'test-region',
        bucket: 'test-evidence',
        publicBaseUrl: '',
        accessMode: 'private',
        objectPrefix: 'phase8',
      },
    },
    repository: {
      repository: 'https://github.com/cynos-ai/cynos-website',
      scenarioBranch: 'scenario-testing',
      scenarioMode: 'review-all',
      scenarioLabels: ['core'],
      pollIntervalSeconds: 60,
      cron: '',
      triggerOnCommit: true,
      environmentDescription: 'Cynos 官网非生产测试环境',
      baseUrl: 'https://staging.example.test',
      externalDatabase: '非生产测试数据库（凭据由 Secret Store 提供）',
    },
    secrets: {
      providerApiKey: { configured: true, masked: '••••••••' },
      gitToken: { configured: true, masked: '••••••••' },
      testUsername: { configured: true, masked: '••••••••' },
      testPassword: { configured: true, masked: '••••••••' },
      ossAccessKeyId: { configured: true, masked: '••••••••' },
      ossAccessKeySecret: { configured: true, masked: '••••••••' },
    },
    secretStore: { available: true },
  };
}

function makeProviderModels(): ProviderModelInfo[] {
  return [
    {
      provider: 'deepseek',
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      reasoning: true,
      input: ['text'],
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      available: true,
    },
    {
      provider: 'deepseek',
      id: 'deepseek-v4-flash-vision-exp',
      name: 'DeepSeek V4 Flash Vision',
      reasoning: true,
      input: ['text', 'image'],
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      available: true,
    },
    {
      provider: 'deepseek',
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      reasoning: false,
      input: ['text'],
      thinkingLevels: ['off'],
      available: true,
    },
  ];
}

function makeChecks(): ConnectivityCheck[] {
  const ok = (id: string, label: string, message = '配置可用'): ConnectivityCheck => ({
    id,
    label,
    available: true,
    result: {
      status: 'ok',
      message,
      checkedAt: '2026-08-30T02:00:00.000Z',
      latencyMs: 12,
    },
  });
  return [
    {
      id: 'test-environment-url',
      label: '测试环境基础 URL',
      available: true,
      result: {
        status: 'ok',
        message: '测试环境可访问',
        checkedAt: '2026-08-30T02:00:00.000Z',
        latencyMs: 12,
      },
    },
    ok('provider-model', '模型 Provider 与模型', 'Provider 可用'),
    ok('github-repository-read', 'GitHub 仓库读取'),
    ok('github-scenario-branch-write', '场景测试分支非 force 写入'),
    ok('github-pull-request', 'GitHub Pull Request 权限'),
    ok('github-issue', 'GitHub Issue 权限'),
    ok('playwright-mcp', 'Playwright MCP'),
    ok('oss', 'OSS 测试对象读写'),
  ];
}

function makeRepositoryStatus(): RepositoryStatusResponse {
  return {
    configured: true,
    availability: 'available',
    errorMessage: null,
    repository: 'https://github.com/cynos-ai/cynos-website',
    scenarioBranch: 'scenario-testing',
    localReady: true,
    remoteHead: HASHES.head,
    indexedCommit: HASHES.indexed,
    lastSyncedAt: '2026-08-30T02:00:00.000Z',
    indexErrors: [],
  };
}

function makeScenario(): OperationsScenario {
  const indexed: IndexedScenario = {
    id: SCENARIO_ID,
    path: `docs/scenario-testing/scenarios/${SCENARIO_ID}.md`,
    name: '登录状态恢复',
    description: '验证用户登录后刷新页面仍保持登录状态',
    status: 'approved',
    tags: ['core', 'flow:登录'],
    content: '<script>window.__luowangXss = true</script>',
    commitSha: HASHES.indexed,
    indexedAt: '2026-08-30T02:00:00.000Z',
  };
  return {
    ...indexed,
    history: [
      {
        runId: RUN_IDS.passed,
        result: 'passed',
        finishedAt: '2026-08-30T01:00:00.000Z',
        targetCommit: HASHES.target,
      },
    ],
    pendingPullRequests: [{ runId: RUN_IDS.blocked, url: PR_URL, targetCommit: HASHES.head }],
  };
}

function makeReport(): IndexedReport {
  return {
    runId: RUN_IDS.passed,
    path: `docs/scenario-testing/reports/${RUN_IDS.passed}/report.md`,
    trigger: 'manual',
    baseCommit: HASHES.base,
    targetCommit: HASHES.target,
    includedCommits: [HASHES.target],
    result: 'passed',
    startedAt: '2026-08-30T00:50:00.000Z',
    finishedAt: '2026-08-30T01:00:00.000Z',
    scenarioResults: [{ id: SCENARIO_ID, result: 'passed' }],
    confirmedBugs: [],
    files: { 'report.md': `docs/scenario-testing/reports/${RUN_IDS.passed}/report.md` },
    content: 'safe archived report',
    commitSha: HASHES.report,
    indexedAt: '2026-08-30T02:00:00.000Z',
  };
}

function makeHistory(nextReports: IndexedReport[]): RepositoryHistoryResponse {
  return {
    status: 'ok',
    reports: nextReports,
    issues: [
      {
        number: 42,
        title: '登录会话问题',
        state: 'open',
        url: ISSUE_URL,
        createdAt: '2026-08-30T01:00:00.000Z',
        updatedAt: '2026-08-30T01:00:00.000Z',
      },
    ],
    issuesAvailable: true,
    issuesMessage: null,
  };
}

function makeGitTree(): OperationsGitTreeResponse {
  return {
    branch: 'scenario-testing',
    commit: HASHES.head,
    stale: true,
    staleReason: 'GitHub 与 OSS 暂时不可用',
    entries: [
      {
        sha: HASHES.head,
        authoredAt: '2026-08-30T02:00:00.000Z',
        subject: '当前场景测试分支 HEAD',
        includedRuns: [],
        targetRuns: [
          { runId: RUN_IDS.blocked, result: 'blocked', issueUrls: [], scenarioPrUrl: PR_URL },
        ],
      },
      {
        sha: HASHES.target,
        authoredAt: '2026-08-30T01:00:00.000Z',
        subject: '官网登录变更',
        includedRuns: [
          { runId: RUN_IDS.passed, result: 'passed', targetCommit: HASHES.target },
          { runId: RUN_IDS.failed, result: 'failed', targetCommit: HASHES.target },
        ],
        targetRuns: [],
      },
    ],
  };
}

function makeRuns(): OperationsRunSummary[] {
  const failed = makeFailedRun();
  if (archiveRetried) {
    failed.archive = {
      ...failed.archive!,
      reportStatus: 'published',
      archiveStatus: 'completed',
      archiveError: null,
    };
  }
  return [makePassedRun(), failed, makeBlockedRun(), makeInterruptedRun()];
}

function makePassedRun(): OperationsRunSummary {
  return {
    ...baseRun(RUN_IDS.passed, 'passed', 'completed', 'completed'),
    request: '验证登录状态恢复',
    includedCommits: [HASHES.target],
    artifactNames: ['plan.md', 'execution.md', 'draft-report.md', 'review.md', 'report.md'],
    scenarioResults: [{ id: SCENARIO_ID, result: 'passed' }],
    confirmedBugs: [],
    issues: [],
    archive: archiveView('published', 'completed', true),
  };
}

function makeFailedRun(): OperationsRunSummary {
  return {
    ...baseRun(RUN_IDS.failed, 'failed', 'completed', 'completed'),
    request: '验证登录后的会话保持',
    includedCommits: [HASHES.target],
    artifactNames: ['plan.md', 'execution.md', 'draft-report.md', 'review.md', 'report.md'],
    scenarioResults: [{ id: SCENARIO_ID, result: 'failed' }],
    confirmedBugs: [
      {
        key: 'BUG-42',
        title: '登录后刷新会话丢失',
        scenarioIds: [SCENARIO_ID],
        issueAction: 'create',
        issueUrl: ISSUE_URL,
      },
    ],
    issues: [
      {
        bugKey: 'BUG-42',
        title: '登录后刷新会话丢失',
        scenarioIds: [SCENARIO_ID],
        issueAction: 'create',
        requestedIssueUrl: ISSUE_URL,
        status: 'succeeded',
        issueNumber: 42,
        issueUrl: ISSUE_URL,
        errorMessage: null,
        attempts: 1,
      },
    ],
    archive: archiveView('failed', 'failed', false, '等待归档：GitHub 暂时不可用'),
  };
}

function makeBlockedRun(): OperationsRunSummary {
  return {
    ...baseRun(RUN_IDS.blocked, 'blocked', 'completed', 'completed'),
    request: '审核新场景候选',
    baseCommit: HASHES.target,
    targetCommit: HASHES.head,
    includedCommits: [],
    artifactNames: ['scenario-changes.patch', 'report.md'],
    scenarioMode: 'review-all',
    scenarioPrUrl: PR_URL,
    scenarioResults: [{ id: SCENARIO_ID, result: 'blocked' }],
    confirmedBugs: [],
    issues: [],
    archive: {
      reportStatus: 'not_applicable',
      reportCommitSha: null,
      archiveStatus: 'completed',
      archiveError: null,
      progressed: false,
      progressedAt: null,
      scenarioStatus: 'pull_request',
      scenarioCommitSha: HASHES.head,
      scenarioPrUrl: PR_URL,
      scenarioError: null,
    },
  };
}

function makeInterruptedRun(): OperationsRunSummary {
  return {
    ...baseRun(RUN_IDS.interrupted, null, 'interrupted', 'interrupted'),
    request: '恢复中断的测试',
    finishedAt: '2026-08-30T01:40:00.000Z',
    errorMessage: '服务重启导致 Run 中断',
    artifactNames: ['plan.md', 'execution.md'],
    scenarioResults: [],
    confirmedBugs: [],
    issues: [],
    archive: null,
  };
}

function baseRun(
  runId: string,
  result: OperationsRunSummary['result'],
  status: OperationsRunSummary['status'],
  phase: OperationsRunSummary['phase'],
): OperationsRunSummary {
  return {
    runId,
    status,
    phase,
    result,
    trigger: 'manual',
    request: '',
    baseCommit: HASHES.base,
    targetCommit: HASHES.target,
    includedCommits: [],
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:30:00.000Z',
    errorMessage: null,
    artifactNames: [],
    scenarioMode: 'review-all',
    initialization: false,
    scenarioPrUrl: null,
    scenarioResults: [],
    confirmedBugs: [],
    issues: [],
    archive: null,
    updatedAt: '2026-08-30T00:30:00.000Z',
  };
}

function archiveView(
  reportStatus: 'pending' | 'published' | 'not_applicable' | 'conflict' | 'failed',
  archiveStatus: 'pending' | 'partial' | 'completed' | 'failed',
  progressed: boolean,
  archiveError: string | null = null,
) {
  return {
    reportStatus,
    reportCommitSha: reportStatus === 'published' ? HASHES.report : null,
    archiveStatus,
    archiveError,
    progressed,
    progressedAt: progressed ? '2026-08-30T00:40:00.000Z' : null,
    scenarioStatus: 'not_applicable' as const,
    scenarioCommitSha: null,
    scenarioPrUrl: null,
    scenarioError: null,
  };
}

function makeDetail(run: OperationsRunSummary): OperationsRunDetail {
  if (run.runId === RUN_IDS.blocked) {
    return {
      ...run,
      artifacts: {
        'scenario-changes.patch': 'diff --git a/docs/scenario-testing/scenarios/new.md',
        'report.md': '场景审核 blocked report',
      },
    };
  }
  if (run.runId === RUN_IDS.interrupted) {
    return { ...run, artifacts: { 'plan.md': 'interrupted plan', 'execution.md': 'interrupted' } };
  }
  return {
    ...run,
    artifacts: {
      'plan.md': 'safe plan',
      'execution.md': 'safe execution',
      'draft-report.md': 'safe draft report',
      'review.md': 'safe review',
      'report.md': run.runId === RUN_IDS.failed ? 'safe final report' : 'safe passed report',
      ...(run.runId === RUN_IDS.failed
        ? {
            'login.png': 'not an actual image; fixture URL is used by the UI',
          }
        : {}),
    },
    evidence:
      run.runId === RUN_IDS.failed
        ? [
            {
              id: 'evidence-42',
              filename: 'login.png',
              objectKey: 'phase8/login.png',
              url: '/api/evidence/evidence-42',
              contentType: 'image/png',
              sizeBytes: 128,
              sha256: 'f'.repeat(64),
              uploadedAt: '2026-08-30T00:25:00.000Z',
            },
          ]
        : [],
  };
}

function makeCurrent(): OperationsCurrentResponse {
  const activeRun: OperationsRunSummary = {
    ...baseRun(RUN_IDS.active, null, 'running', 'runner'),
    request: '执行登录场景',
    baseCommit: HASHES.target,
    targetCommit: HASHES.head,
    includedCommits: [HASHES.head],
    artifactNames: ['plan.md', 'execution.md'],
    currentScenario: SCENARIO_ID,
    scenarioProgress: { completed: 1, total: 2 },
    activities: [
      {
        at: '2026-08-30T02:20:00.000Z',
        message: 'Runner 正在执行场景',
        kind: 'phase',
      },
    ],
    blockingReasons: [],
  };
  return {
    current: {
      run: activeRun,
      role: 'runner',
      stage: 'Runner：执行场景',
      currentScenario: SCENARIO_ID,
      progress: { completed: 1, total: 2 },
      activities: activeRun.activities ?? [],
      blockingReasons: [],
      files: ['plan.md', 'execution.md'],
      updatedAt: '2026-08-30T02:20:00.000Z',
    },
    fetchedAt: '2026-08-30T02:20:00.000Z',
  };
}

function makeDashboard(): OperationsDashboardResponse {
  return {
    fetchedAt: '2026-08-30T02:20:00.000Z',
    stale: true,
    staleReason: 'GitHub 与 OSS 暂时不可用',
    repository: status,
    branch: {
      name: 'scenario-testing',
      head: HASHES.head,
      indexedCommit: HASHES.indexed,
      lastSyncedAt: '2026-08-30T02:00:00.000Z',
    },
    progress: {
      lastCompleted: makeFailedRun(),
      lastCompletedTarget: HASHES.target,
      latestTestableCommit: HASHES.head,
      pendingCommits: [HASHES.head],
      pendingCount: 1,
    },
    activeRun: current.current,
    queue: [
      {
        queueId: 101,
        requestId: 'request-101',
        trigger: 'manual',
        triggerSources: ['manual'],
        requestIds: ['request-101'],
        request: '验证 Cynos 官网登录后的会话保持',
        targetRef: null,
        requestKind: 'manual-current-head',
        sourceRef: null,
        preparedMergeCommit: null,
        preparedMergeMode: null,
        resolvedTargetCommit: HASHES.head,
        status: 'queued',
        runId: null,
        claimedAt: null,
        waitingArchiveAt: null,
        completedAt: null,
        errorMessage: null,
        archiveStatus: null,
        progressed: null,
        createdAt: '2026-08-30T02:20:00.000Z',
        updatedAt: '2026-08-30T02:20:00.000Z',
        initialization: false,
      },
    ],
    workspace: { running: 1, completed: 4, pendingArchive: 1 },
    automation: {
      scheduler: {
        running: true,
        lastPollAt: '2026-08-30T02:19:00.000Z',
        nextPollAt: '2026-08-30T02:20:00.000Z',
        lastArchiveAt: '2026-08-30T02:18:00.000Z',
        nextArchiveAt: '2026-08-30T02:28:00.000Z',
        lastIndexerAt: '2026-08-30T02:00:00.000Z',
        nextIndexerAt: '2026-08-30T07:00:00.000Z',
        lastCleanupAt: '2026-08-30T01:00:00.000Z',
        nextCleanupAt: '2026-08-31T01:00:00.000Z',
        lastCronKey: null,
        lastError: 'OSS 暂时不可用，保留本地归档事实',
      },
      lastArchiveError: 'OSS 暂时不可用，保留本地归档事实',
      pendingScenarioReviews: [
        {
          runId: RUN_IDS.blocked,
          url: PR_URL,
          targetCommit: HASHES.head,
          result: 'blocked',
          createdAt: '2026-08-30T01:30:00.000Z',
          errorMessage: null,
        },
      ],
    },
    dependencies: [
      {
        id: 'sqlite',
        label: 'SQLite',
        status: 'ok',
        message: '数据库可读写',
        checkedAt: '2026-08-30T02:20:00.000Z',
        stale: false,
      },
      {
        id: 'github',
        label: 'GitHub / 场景测试分支',
        status: 'unavailable',
        message: 'GitHub 暂时不可用',
        checkedAt: '2026-08-30T02:00:00.000Z',
        stale: true,
      },
      {
        id: 'oss',
        label: 'OSS 测试对象读写',
        status: 'degraded',
        message: 'OSS 暂时不可用',
        checkedAt: '2026-08-30T02:00:00.000Z',
        stale: true,
      },
    ],
    recentRuns: makeRuns(),
  };
}
