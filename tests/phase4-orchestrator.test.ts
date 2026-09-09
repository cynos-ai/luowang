import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import type { BrowserMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import { createRunOrchestrator, type RunOrchestrator } from '../src/server/runs/orchestrator.js';
import { createTestDataManager } from '../src/server/runs/test-data.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import type { AgentSessionFactory, AgentSessionInput } from '../src/server/runs/types.js';
import { createRepositoryService } from '../src/server/repository/service.js';
import type { OssAdapter } from '../src/server/storage/oss.js';
import type { SecretStore } from '../src/server/security/secret-store.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 4 Run blocking boundaries', () => {
  it.each([
    ['OSS 上传失败', 'upload-failure', /证据上传失败/],
    ['UI 缺少 MCP 或截图', 'browser-missing', /Playwright MCP 未启用|可审核的 evidence/],
    ['Reviewer 无法读取截图', 'review-read-failure', /Reviewer 无法读取/],
    ['Reviewer 缺少图像能力', 'vision-unavailable', /图像输入/],
  ] as const)('%s 会形成 completed blocked Run', async (_label, mode, expectedReason) => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, mode);

    const result = await context.orchestrator.run({
      request: '验证 Phase 4 故障边界',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'blocked', JSON.stringify(result));
    assert.match(result.artifacts['report.md'] ?? '', expectedReason);
    assert.match(result.artifacts['report.md'] ?? '', /^result: blocked$/m);
    if (mode === 'upload-failure' || mode === 'review-read-failure') {
      assert.equal(
        await pathExists(
          join(context.reportDir, 'completed', result.runId, 'evidence', 'login.png'),
        ),
        true,
      );
    }
  });

  it.each(['cleanup-review', 'cleanup-failure'] as const)(
    'preserves passed with visible teardown warnings: %s',
    async (mode) => {
      const fixture = await createGitFixture();
      const context = await createRunContext(fixture, mode);

      const result = await context.orchestrator.run({
        request: '验证 Reviewer 独立确认测试数据清理',
        trigger: 'manual',
      });

      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.result, 'passed', JSON.stringify(result));
      assert.match(result.artifacts['report.md'] ?? '', /Harness 清理收尾[\s\S]*未完成/);
      assert.ok(!result.blockingReasons?.some((reason) => /清理/.test(reason)));
    },
  );

  it('checks visual capability on the Reviewer instead of the text-only Runner', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, 'vision-reviewer');

    const result = await context.orchestrator.run({
      request: '验证截图视觉差异由 Reviewer 审核',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed', JSON.stringify(result));
  });

  it('repairs an invalid Issue action in the owning Session without losing the Bug', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, 'report-correction');
    const result = await context.orchestrator.run({
      request: '验证报告字段纠错',
      trigger: 'manual',
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'failed');
    assert.match(result.artifacts['report.md'] ?? '', /issue_action: create/);
    assert.match(result.artifacts['report.md'] ?? '', /BUG-FIXTURE/);
    assert.match(result.artifacts['report.md'] ?? '', /Issue 查询覆盖缺口/);
  });

  it('does not complete a Run when Main finalization writes a non-schema scenario result', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, 'malformed-report');

    const result = await context.orchestrator.run({
      request: '验证最终报告 schema 校验',
      trigger: 'manual',
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.result, null, JSON.stringify(result));
    assert.equal(result.errorMessage, '角色没有写入必需工件：report.md');
    assert.equal(result.artifacts['report.md'], undefined);
    assert.equal(
      await pathExists(join(context.reportDir, 'completed', result.runId, 'report.md')),
      false,
    );
    assert.equal(
      await pathExists(join(context.reportDir, 'running', result.runId, 'report.md')),
      false,
    );
  });
});

type FailureMode =
  | 'upload-failure'
  | 'cleanup-failure'
  | 'cleanup-review'
  | 'browser-missing'
  | 'review-read-failure'
  | 'vision-reviewer'
  | 'vision-unavailable'
  | 'malformed-report'
  | 'report-correction';

interface Fixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
}

interface RunContextFixture {
  orchestrator: RunOrchestrator;
  reportDir: string;
}

class FailureBoundarySessionFactory implements AgentSessionFactory {
  private cleanupDataId: string | undefined;

  constructor(private readonly mode: FailureMode) {}

  async create(input: AgentSessionInput) {
    return {
      prompt: async () => {
        if (input.role === 'main-a') {
          await invokeTool(input, 'get_run_context', {});
          await invokeTool(input, 'write_plan', {
            requiresBrowser: this.mode !== 'cleanup-failure' && this.mode !== 'cleanup-review',
            content:
              this.mode === 'cleanup-failure' || this.mode === 'cleanup-review'
                ? '# Plan\n\n## execution_scenarios\n\n本次只验证 Harness 清理边界，不涉及产品验证。无浏览器服务，不执行端到端 UI 测试，本次不做截图对比。\n'
                : this.mode === 'vision-reviewer'
                  ? '# Plan\n\nUI 登录场景：打开登录页面并核对截图差异。\n\n## execution_scenarios\n\n- PHASE4-FIXTURE\n'
                  : '# Plan\n\n打开首页，检查按钮是否被其他元素挡住。\n\n## execution_scenarios\n\n- PHASE4-FIXTURE\n',
          });
          return;
        }

        if (input.role === 'runner') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          const scenarioIds =
            this.mode === 'cleanup-failure' || this.mode === 'cleanup-review'
              ? []
              : ['PHASE4-FIXTURE'];
          await invokeTool(input, 'begin_scenario_execution', { scenarioIds });
          for (const scenarioId of scenarioIds) {
            await invokeTool(input, 'start_scenario', { scenarioId });
            await invokeTool(input, 'finish_scenario', { scenarioId });
          }
          const context = parsePromptContext(input.userMessage);
          if (this.mode === 'cleanup-failure' || this.mode === 'cleanup-review') {
            this.cleanupDataId = `luowang-${context.runId}-test-user-1`;
            await invokeTool(input, 'register_test_data', {
              id: this.cleanupDataId,
              description: 'fixture user',
            });
          } else if (this.mode !== 'browser-missing') {
            await mkdir(join(context.runDirectory, 'evidence'), { recursive: true });
            await writeFile(join(context.runDirectory, 'evidence', 'login.png'), 'fixture image');
          }
          await invokeTool(input, 'write_execution', {
            content: '# Execution\n\nRunner 已按计划执行。\n',
          });
          return;
        }

        if (input.role === 'reviewer') {
          const writer = input.customTools.find((tool) => tool.name === 'write_review');
          assert.match(writer?.description ?? '', /仅当 execution_scenarios 为空时/);
          assert.match(input.systemPrompt, /仅当 execution_scenarios 为空时/);
          assert.match(input.systemPrompt, /没有新增或修改场景不等于没有执行场景/);
          assert.match(input.systemPrompt, /模型看图或人工触发 Run 不代表人工复核/);
          assert.match(input.systemPrompt, /操作成功也不能反证截图完整/);
          for (const name of ['plan.md', 'execution.md']) {
            await invokeTool(input, 'read_run_artifact', { name });
          }
          assert.ok(!input.customTools.some((t) => t.name === 'verify_test_data_cleanup'));
          if (
            this.mode === 'review-read-failure' ||
            this.mode === 'vision-reviewer' ||
            this.mode === 'vision-unavailable' ||
            this.mode === 'malformed-report' ||
            this.mode === 'report-correction'
          ) {
            await invokeTool(input, 'list_evidence_files', {});
            const image = (await invokeTool(input, 'read_evidence_image', {
              filename: 'login.png',
            })) as {
              details: Record<string, unknown>;
              content: Array<{ type: string }>;
            };
            if (this.mode === 'vision-unavailable') {
              assert.equal(image.details.error, true);
              assert.ok(image.content.every((part) => part.type !== 'image'));
            }
          }
          await invokeTool(input, 'write_review', {
            content:
              this.mode === 'cleanup-review' || this.mode === 'cleanup-failure'
                ? '# Review\n\n无需场景测试：计划仅验证 Harness 生命周期，不影响产品行为。\n'
                : '# Review\n\n独立审核完成。\n',
          });
          return;
        }

        assert.match(input.systemPrompt, /清单非空时不写零场景通过说明/);
        assert.match(input.systemPrompt, /模型看图或人工触发 Run 不代表人工复核/);
        for (const name of ['plan.md', 'review.md']) {
          await invokeTool(input, 'read_run_artifact', { name });
        }
        const context = parsePromptContext(input.userMessage);
        assert.match(input.systemPrompt, /unavailable 是查询状态，不是 issue_action 的第三个值/);
        if (this.mode === 'report-correction') {
          await invokeTool(input, 'query_issue_candidates', { bug_key: 'BUG-FIXTURE' });
          const report =
            passedReport(context, true)
              .replaceAll('result: passed', 'result: failed')
              .replace(
                'confirmed_bugs: []',
                'confirmed_bugs:\n  - key: BUG-FIXTURE\n    title: fixture bug\n    scenario_ids: [PHASE4-FIXTURE]\n    issue_action: unavailable',
              ) + '\n## Issue 查询覆盖缺口\n\nBUG-FIXTURE：查询不可用，不能确认是否重复。\n';
          const rejected = (await invokeTool(input, 'write_report', { content: report })) as {
            details: { error?: boolean };
            content: Array<{ text: string }>;
          };
          assert.equal(rejected.details.error, true);
          assert.match(
            rejected.content[0]!.text,
            /confirmed_bugs\[0\]\.issue_action 必须是 create 或 link/,
          );
          assert.ok(!rejected.content[0]!.text.includes(context.runDirectory));
          await invokeTool(input, 'write_report', {
            content: report.replace('issue_action: unavailable', 'issue_action: create'),
          });
          return;
        }
        await invokeTool(input, 'write_report', {
          content:
            this.mode === 'malformed-report'
              ? malformedReport(context)
              : passedReport(
                  context,
                  this.mode !== 'cleanup-failure' && this.mode !== 'cleanup-review',
                ),
        });
      },
      dispose: () => undefined,
    };
  }
}

async function createRunContext(fixture: Fixture, mode: FailureMode): Promise<RunContextFixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase4-orchestrator-'));
  const reportDir = join(dataDirectory, 'report');
  cleanup.push(async () => rm(dataDirectory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDirectory,
    LUOWANG_REPO_DIR: join(dataDirectory, 'target'),
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_ADMIN_PASSWORD: 'phase4-orchestrator-password!',
    LUOWANG_MASTER_KEY: 'phase4-orchestrator-master-key',
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateRepository({
    repository: fixture.remoteDir,
    scenarioBranch: 'scenario-testing',
    baseUrl: mode === 'cleanup-failure' ? '' : 'http://127.0.0.1:3000',
  });
  configuration.updateHarness({
    agents: {
      main: { model: 'fixture-main', thinking: 'off' },
      runner: { model: 'fixture-runner', thinking: 'off' },
      reviewer: { model: 'fixture-reviewer', thinking: 'off' },
    },
  });
  const repository = createRepositoryService(database.sqlite, configuration, fakeSecretStore(), {
    repoDir: config.repoDir,
    allowLocalRepository: true,
  });
  const orchestrator = createRunOrchestrator({
    configuration,
    repository,
    reportDir,
    provider: mode === 'vision-unavailable' ? ({} as ProviderAdapter) : visualReviewerProvider(),
    browser: fakeBrowser(mode !== 'browser-missing'),
    oss: mode === 'cleanup-failure' || mode === 'browser-missing' ? undefined : fakeOss(mode),
    testData: createTestDataManager(
      mode === 'cleanup-failure'
        ? {
            cleanupAdapter: {
              id: 'fixture-cleanup',
              cleanupAndVerify: async () => ({
                absent: false,
                content: 'fixture data still exists',
                statusCode: 200,
              }),
            },
          }
        : undefined,
    ),
    sessions: new FailureBoundarySessionFactory(mode),
    logger: pino({ level: 'silent' }),
  });
  return { orchestrator, reportDir };
}

function visualReviewerProvider(): ProviderAdapter {
  return {
    getRuntime: async () => ({}) as never,
    resolveModel: async (role) => {
      assert.notEqual(role, 'runner');
      return { input: ['image'] } as never;
    },
    listModels: async () => [],
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'fixture provider available',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    }),
  };
}

function fakeBrowser(enabled: boolean): BrowserMcpAdapter {
  return {
    isEnabled: () => enabled,
    serverDefinition: () => ({
      command: 'node',
      args: [],
      env: {},
      lifecycle: 'lazy',
      directTools: false,
      excludeTools: [],
      requestTimeoutMs: 1_000,
    }),
    extension: (): InlineExtension => ({
      name: 'phase4-fixture-browser',
      hidden: true,
      factory: async () => undefined,
    }),
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'fixture browser is available',
      checkedAt: '2026-08-30T00:00:00.000Z',
      latencyMs: 1,
    }),
  };
}

function fakeOss(mode: FailureMode): OssAdapter {
  const objects = new Map<string, Buffer>();
  return {
    isConfigured: () => true,
    objectKey: (runId, filename) => `${runId}/${filename}`,
    stableUrlForKey: (key) => `/api/evidence/${Buffer.from(key).toString('base64url')}`,
    uploadFile: async (runId, filename, filePath) => {
      if (mode === 'upload-failure') throw new Error('fixture upload failed');
      const body = await readFile(filePath);
      const key = `${runId}/${filename}`;
      objects.set(key, Buffer.from(body));
      return {
        id: Buffer.from(key).toString('base64url'),
        filename,
        objectKey: key,
        url: `/api/evidence/${Buffer.from(key).toString('base64url')}`,
        contentType: 'image/png',
        sizeBytes: body.byteLength,
        sha256: 'fixture-sha256',
        uploadedAt: '2026-08-30T00:00:00.000Z',
      };
    },
    putObject: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    getObject: async (key) => {
      if (mode === 'review-read-failure') throw new Error('fixture evidence is unavailable');
      const body = objects.get(key) ?? Buffer.from('fixture image');
      return { key, body, contentType: 'image/png', contentLength: body.byteLength, etag: null };
    },
    headObject: async (key) => {
      const body = objects.get(key) ?? Buffer.from('fixture image');
      return { key, contentType: 'image/png', contentLength: body.byteLength, etag: null };
    },
    deleteObject: async (key) => {
      objects.delete(key);
    },
    getEvidenceByStableId: async (stableId) => {
      const body = objects.get(stableId) ?? Buffer.from('fixture image');
      return {
        key: stableId,
        body,
        contentType: 'image/png',
        contentLength: body.byteLength,
        etag: null,
      };
    },
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'fixture OSS is available',
      checkedAt: '2026-08-30T00:00:00.000Z',
      latencyMs: 1,
    }),
  };
}

async function createGitFixture(): Promise<Fixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase4-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 4 Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase4@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'fixture product\n');
  await mkdir(join(sourceDir, 'docs/scenario-testing/scenarios'), { recursive: true });
  await writeFile(
    join(sourceDir, 'docs/scenario-testing/scenarios/PHASE4-FIXTURE.md'),
    `---
id: PHASE4-FIXTURE
name: Phase 4 UI fixture
description: 验证 Phase 4 UI 边界
status: approved
tags:
  - core
---

## 目的

验证 Phase 4 UI 边界。

## 前置条件

使用非生产 fixture 环境。

## 步骤

1. 打开 fixture 页面。

## 期望

页面显示 fixture 内容。
`,
  );
  await git(['add', '-A'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  await git(['checkout', '-b', 'scenario-testing', 'main'], sourceDir);
  await git(['push', '-u', 'origin', 'scenario-testing'], sourceDir);
  return { rootDir, remoteDir, sourceDir };
}

async function invokeTool(
  input: AgentSessionInput,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tool = input.customTools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute('phase4-fixture', params as never, undefined, undefined, {} as never);
}

function parsePromptContext(prompt: string): {
  runId: string;
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  runDirectory: string;
} {
  const match = prompt.match(/动态 Run 上下文：\s*([\s\S]+)$/);
  assert.ok(match?.[1], 'missing prompt context');
  return JSON.parse(match[1]) as ReturnType<typeof parsePromptContext>;
}

function passedReport(
  context: ReturnType<typeof parsePromptContext>,
  includeScenario = false,
): string {
  return `---
run_id: ${context.runId}
trigger: manual
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits: []
result: passed
started_at: 2026-08-30T00:00:00.000Z
finished_at: 2026-08-30T00:01:00.000Z
scenario_results: ${includeScenario ? '\n  - id: PHASE4-FIXTURE\n    result: passed' : ' []'}
confirmed_bugs: []
---

# Report

${includeScenario ? '截图视觉审核 fixture 已通过。' : '无需场景测试：这是 Phase 4 故障边界 fixture。'}\n`;
}

function malformedReport(context: ReturnType<typeof parsePromptContext>): string {
  return `---
run_id: ${context.runId}
trigger: manual
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits: []
result: passed
started_at: 2026-08-30T00:00:00.000Z
finished_at: 2026-08-30T00:01:00.000Z
scenario_results:
  - scenario: PHASE4-FIXTURE
    title: 错误字段
    status: passed
    evidence: []
confirmed_bugs: []
---

# Report

报告 schema fixture。\n`;
}

function fakeSecretStore(): SecretStore {
  return {
    isAvailable: () => true,
    set: () => undefined,
    get: () => undefined,
    has: () => false,
    delete: () => undefined,
    metadata: () => ({}) as SecretStore['metadata'] extends () => infer T ? T : never,
  };
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
