import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createConfigurationStore } from '../src/server/configuration.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { createRunOrchestrator, type RunOrchestrator } from '../src/server/runs/orchestrator.js';
import { createControlledCommandRunner } from '../src/server/runs/command-runner.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import type { AgentSessionFactory, AgentSessionInput } from '../src/server/runs/types.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { createRepositoryService } from '../src/server/repository/service.js';
import type { SecretStore } from '../src/server/security/secret-store.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 3 agent run', () => {
  it('runs four independent sessions, fixes target SHA, writes five artifacts, and atomically completes', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);

    const result = await context.orchestrator.run({
      request: '验证最新版本中无需 UI 场景的文档变化',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.equal(result.baseCommit, null);
    assert.equal(result.targetCommit, fixture.initialHead);
    assert.deepEqual(result.includedCommits, []);
    assert.deepEqual(Object.keys(result.artifacts).sort(), [
      'draft-report.md',
      'execution.md',
      'plan.md',
      'report.md',
      'review.md',
    ]);
    assert.match(result.artifacts['plan.md'] ?? '', /无需场景测试/);
    assert.match(result.artifacts['review.md'] ?? '', /无需场景测试/);
    assert.equal(await pathExists(join(context.reportDir, 'running', result.runId)), false);
    assert.equal(await pathExists(join(context.reportDir, 'completed', result.runId)), true);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.deepEqual(context.sessions.disposed, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.equal(new Set(context.sessions.sessionObjects).size, 4);
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.sessionKind),
      ['main-planning', 'runner-execution', 'reviewer-audit', 'main-finalization'],
    );
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.roleInstructionVersions.map((item) => item.id)),
      [
        ['common', 'main-planning'],
        ['common', 'runner-execution'],
        ['common', 'reviewer-audit'],
        ['common', 'main-finalization'],
      ],
    );
    assert.deepEqual(
      context.sessions.messages,
      context.sessions.inputs.map((input) => input.userMessage),
    );
    assert.deepEqual(context.sessions.inputs[0]?.config, context.sessions.inputs[3]?.config);
    for (const input of context.sessions.inputs) {
      assert.match(input.systemPrompt, /luowang-role-id: common/);
      assert.doesNotMatch(input.userMessage, /luowang-role-id:/);
      assert.doesNotMatch(input.systemPrompt, new RegExp(fixture.initialHead));
      assert.match(input.userMessage, new RegExp(fixture.initialHead));
      assert.equal(
        input.customTools.some((tool) => tool.name === 'read'),
        false,
      );
      for (const version of input.roleInstructionVersions) {
        assert.match(version.sha256, /^[a-f0-9]{64}$/);
        assert.equal(version.applicationVersion, '0.1.0');
        assert.equal(version.formatVersion, '1');
      }
    }
    assert.match(context.sessions.inputs[0]?.systemPrompt ?? '', /luowang-role-id: main-planning/);
    assert.doesNotMatch(context.sessions.inputs[0]?.systemPrompt ?? '', /runner-execution/);
    assert.match(
      context.sessions.inputs[1]?.systemPrompt ?? '',
      /luowang-role-id: runner-execution/,
    );
    assert.match(context.sessions.inputs[2]?.systemPrompt ?? '', /luowang-role-id: reviewer-audit/);
    assert.match(
      context.sessions.inputs[3]?.systemPrompt ?? '',
      /luowang-role-id: main-finalization/,
    );
    const mainToolContext = commandText(
      await invokeTool(context.sessions.inputs[0] as AgentSessionInput, 'get_run_context', {}),
    );
    const runnerToolContext = commandText(
      await invokeTool(context.sessions.inputs[1] as AgentSessionInput, 'get_run_context', {}),
    );
    assert.match(mainToolContext, /historyIssuesAvailable/);
    assert.match(mainToolContext, /indexedReports/);
    assert.doesNotMatch(runnerToolContext, /historyIssues|indexedReports|indexedScenarios/);
  });

  it('moves one recognizable final report frontmatter block before an agent preamble', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '# Final Report\n\n',
    );

    const result = await context.orchestrator.run({
      request: '验证最终报告 frontmatter 位置',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.match(result.artifacts['report.md'] ?? '', /^---\nrun_id:/);
    assert.match(result.artifacts['report.md'] ?? '', /# Final Report/);
  });

  it('preserves CRLF content while moving final report frontmatter', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '# Final Report\n\n',
      '\r\n',
    );

    const result = await context.orchestrator.run({
      request: '验证 CRLF 最终报告 frontmatter 位置',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    const report = result.artifacts['report.md'] ?? '';
    assert.match(report, /^---\r\nrun_id:/);
    assert.equal(report.replaceAll('\r\n', '').includes('\n'), false);
  });

  it('isolates repeated Main and Runner Sessions during initialization', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed', 'passed']);

    const result = await context.orchestrator.run({
      request: '初始化陌生项目的长期场景',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(
      context.sessions.created,
      ['main-a', 'runner', 'main-a', 'runner', 'reviewer', 'main-b'],
      JSON.stringify(result),
    );
    assert.equal(new Set(context.sessions.sessionObjects).size, 6);
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.sessionKind),
      [
        'main-planning',
        'runner-execution',
        'main-planning',
        'runner-execution',
        'reviewer-audit',
        'main-finalization',
      ],
    );
    for (const index of [0, 2, 5]) {
      assert.equal(
        context.sessions.inputs[index]?.roleInstructionVersions.some(
          (item) => item.id === 'scenario-initialization',
        ),
        true,
      );
      assert.deepEqual(context.sessions.inputs[index]?.config, context.sessions.inputs[0]?.config);
    }
    for (const index of [1, 3, 4]) {
      assert.equal(
        context.sessions.inputs[index]?.roleInstructionVersions.some(
          (item) => item.id === 'scenario-initialization',
        ),
        false,
      );
    }
    assert.deepEqual(context.sessions.inputs[1]?.config, context.sessions.inputs[3]?.config);
    assert.notEqual(context.sessions.messages[0], context.sessions.messages[2]);
    assert.notEqual(context.sessions.messages[1], context.sessions.messages[3]);
  });

  it('rejects a second start while the first Run is still being prepared', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);

    const firstStart = context.orchestrator.start({
      request: '执行一次人工回归',
      trigger: 'manual',
    });
    await assert.rejects(
      () =>
        context.orchestrator.start({
          request: '不应并发执行',
          trigger: 'api',
        }),
      (error: unknown) => error instanceof Error && error.message.includes('已有一个 Run 正在执行'),
    );
    const first = await firstStart;
    const completed = await context.orchestrator.wait(first.runId);
    assert.equal(completed?.status, 'completed', JSON.stringify(completed));
  });

  it('passes read-only historical Issue context to Main planning', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);
    context.repository.listIssues = async () => [
      {
        number: 42,
        title: '历史登录问题',
        state: 'open',
        url: 'https://github.com/example/fixture/issues/42',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    ];

    await context.orchestrator.run({
      request: '结合历史 Issue 复核文档变化',
      trigger: 'manual',
    });

    assert.equal(context.sessions.inputs[0]?.role, 'main-a');
    assert.doesNotMatch(context.sessions.inputs[0]?.systemPrompt ?? '', /历史登录问题/);
    assert.match(context.sessions.inputs[0]?.userMessage ?? '', /历史登录问题/);
    assert.match(context.sessions.inputs[0]?.userMessage ?? '', /historyIssuesAvailable/);
    for (const input of context.sessions.inputs.slice(1)) {
      assert.doesNotMatch(input.userMessage, /历史登录问题/);
      assert.doesNotMatch(input.userMessage, /historyIssues/);
    }
    const runnerToolContext = commandText(
      await invokeTool(context.sessions.inputs[1] as AgentSessionInput, 'get_run_context', {}),
    );
    assert.doesNotMatch(runnerToolContext, /历史登录问题|historyIssues|indexedReports/);
    const [planning, runner, reviewer, finalization] = context.sessions.inputs;
    assert.ok(planning?.customTools.some((tool) => tool.name === 'query_run_history'));
    assert.equal(
      planning?.customTools.some((tool) => tool.name === 'query_issue_candidates'),
      false,
    );
    for (const input of [runner, reviewer]) {
      assert.equal(
        input?.customTools.some((tool) => tool.name === 'query_run_history'),
        false,
      );
      assert.equal(
        input?.customTools.some((tool) => tool.name === 'query_issue_candidates'),
        false,
      );
    }
    assert.ok(finalization?.customTools.some((tool) => tool.name === 'query_issue_candidates'));
    assert.equal(
      finalization?.customTools.some((tool) => tool.name === 'query_run_history'),
      false,
    );
  });

  it('publishes a real two-scenario Runner progression from 0/2 to 2/2', async () => {
    const fixture = await createGitFixture(true);
    const gate = new ProgressGate();
    const scenarioIds = ['AUTH-LOGIN-001', 'AUTH-LOGOUT-001'];
    const context = await createRunContext(fixture, ['passed'], undefined, {
      scenarioIds,
      checkpoint: (name) => gate.checkpoint(name),
    });

    const started = await context.orchestrator.start({
      request: '顺序执行登录与退出场景',
      trigger: 'manual',
    });

    await assertProgress(gate, context.orchestrator, 'declared', null, 0, 2);
    await assertProgress(
      gate,
      context.orchestrator,
      'started:AUTH-LOGIN-001',
      'AUTH-LOGIN-001 · 登录状态恢复',
      0,
      2,
    );
    await assertProgress(gate, context.orchestrator, 'finished:AUTH-LOGIN-001', null, 1, 2);
    await assertProgress(
      gate,
      context.orchestrator,
      'started:AUTH-LOGOUT-001',
      'AUTH-LOGOUT-001 · 安全退出',
      1,
      2,
    );
    await assertProgress(gate, context.orchestrator, 'finished:AUTH-LOGOUT-001', null, 2, 2);

    const result = await context.orchestrator.wait(started.runId);
    assert.equal(result?.result, 'passed', JSON.stringify(result));
    assert.deepEqual(result?.scenarioProgress, { completed: 2, total: 2 });
    assert.equal(result?.currentScenario, null);
    assert.ok(result?.activities?.some((activity) => activity.message.includes('完成场景')));
  });

  it('preserves the active scenario when the Runner session fails', async () => {
    const fixture = await createGitFixture(true);
    const context = await createRunContext(fixture, ['passed'], undefined, {
      scenarioIds: ['AUTH-LOGIN-001'],
      checkpoint: async () => undefined,
      failAfterFirstStart: true,
    });

    const result = await context.orchestrator.run({
      request: '验证 Runner 异常时保留现场',
      trigger: 'manual',
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.currentScenario, 'AUTH-LOGIN-001 · 登录状态恢复');
    assert.deepEqual(result.scenarioProgress, { completed: 0, total: 1 });
    assert.ok(result.activities?.at(-1)?.message.includes('执行失败'));
  });

  it('preserves failed and blocked result precedence from the independent report', async () => {
    const fixture = await createGitFixture();
    const failedContext = await createRunContext(fixture, ['failed']);
    const failed = await failedContext.orchestrator.run({
      request: '验证确定的登录回归',
      trigger: 'api',
    });
    assert.equal(failed.status, 'completed', JSON.stringify(failed));
    assert.equal(failed.result, 'failed');
    assert.match(failed.artifacts['report.md'] ?? '', /confirmed_bugs/);

    const blockedContext = await createRunContext(fixture, ['blocked']);
    const blocked = await blockedContext.orchestrator.run({
      request: '验证当前测试命令',
      trigger: 'manual',
    });
    assert.equal(blocked.status, 'completed');
    assert.equal(blocked.result, 'blocked');
  });

  it('does not let a new remote commit change the fixed target during a run', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed'], async () => {
      await writeFile(join(fixture.sourceDir, 'new-product-file.txt'), 'arrived later\n');
      await commitAndPush(fixture.sourceDir, 'late product commit', 'scenario-testing');
    });

    const result = await context.orchestrator.run({
      request: '执行固定版本回归',
      trigger: 'manual',
    });
    assert.equal(result.targetCommit, fixture.initialHead);
    assert.equal(
      (await git(['rev-parse', 'scenario-testing'], fixture.sourceDir)).stdout.trim() ===
        fixture.initialHead,
      false,
    );
    assert.match(result.artifacts['execution.md'] ?? '', new RegExp(fixture.initialHead));
  });

  it('only exposes an explicit non-sensitive environment to fixture commands', async () => {
    const scriptDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase3-env-'));
    cleanup.push(async () => rm(scriptDirectory, { recursive: true, force: true }));
    await writeFile(
      join(scriptDirectory, 'print-env.js'),
      'console.log(JSON.stringify(process.env));\n',
    );
    const runner = createControlledCommandRunner({
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      GIT_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      OSS_ACCESS_KEY_SECRET: 'must-not-leak',
      LUOWANG_ADMIN_PASSWORD: 'must-not-leak',
      LUOWANG_MASTER_KEY: 'must-not-leak',
    });
    const result = await runner.run('node print-env.js', {
      cwd: scriptDirectory,
      runId: '01K00000000000000000000001',
      targetCommit: 'a'.repeat(40),
    });
    const childEnvironment = JSON.parse(result.stdout) as Record<string, string>;
    assert.equal(childEnvironment.GIT_TOKEN, undefined);
    assert.equal(childEnvironment.OPENAI_API_KEY, undefined);
    assert.equal(childEnvironment.OSS_ACCESS_KEY_SECRET, undefined);
    assert.equal(childEnvironment.LUOWANG_ADMIN_PASSWORD, undefined);
    assert.equal(childEnvironment.LUOWANG_MASTER_KEY, undefined);
    assert.equal(childEnvironment.LUOWANG_RUN_ID, '01K00000000000000000000001');
    assert.ok(result.environmentKeys.includes('LUOWANG_TARGET_COMMIT'));
  });

  it('rejects executable paths, inline interpreter code, and mutating Git forms', async () => {
    const runner = createControlledCommandRunner({ PATH: process.env.PATH });
    const options = {
      cwd: process.cwd(),
      runId: '01K00000000000000000000001',
      targetCommit: 'a'.repeat(40),
    };
    for (const command of [
      './node --version',
      'node -e "console.log(1)"',
      'git branch new-branch',
    ]) {
      await assert.rejects(
        () => runner.run(command, options),
        (error: unknown) => error instanceof Error && error.message.includes('Runner'),
      );
    }
  });

  it('does not allow a role writer to write another role artifact', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-workspace-'));
    cleanup.push(async () => rm(reportDir, { recursive: true, force: true }));
    const workspace = new RunWorkspace('01K00000000000000000000001', reportDir);
    await workspace.create();
    await assert.rejects(
      () => workspace.writer('main-a').writeReport('# not allowed'),
      (error: unknown) => error instanceof Error && error.message.includes('不能写入'),
    );
  });
});

interface Fixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
  cloneDir: string;
  initialHead: string;
}

interface TestContext {
  orchestrator: RunOrchestrator;
  reportDir: string;
  repository: ReturnType<typeof createRepositoryService>;
  sessions: RecordingSessionFactory;
}

interface ProgressFixture {
  scenarioIds: string[];
  checkpoint(name: string): Promise<void>;
  failAfterFirstStart?: boolean;
}

class ProgressGate {
  private readonly reached = new Set<string>();
  private readonly reachedWaiters = new Map<string, () => void>();
  private readonly releases = new Map<string, () => void>();

  async checkpoint(name: string): Promise<void> {
    this.reached.add(name);
    this.reachedWaiters.get(name)?.();
    await new Promise<void>((resolve) => this.releases.set(name, resolve));
  }

  async wait(name: string): Promise<void> {
    if (this.reached.has(name)) return;
    await new Promise<void>((resolve) => this.reachedWaiters.set(name, resolve));
  }

  release(name: string): void {
    const release = this.releases.get(name);
    assert.ok(release, `checkpoint not waiting: ${name}`);
    release();
  }
}

async function assertProgress(
  gate: ProgressGate,
  orchestrator: RunOrchestrator,
  checkpoint: string,
  currentScenario: string | null,
  completed: number,
  total: number,
): Promise<void> {
  await gate.wait(checkpoint);
  const current = await orchestrator.current();
  assert.equal(current?.currentScenario, currentScenario);
  assert.deepEqual(current?.scenarioProgress, { completed, total });
  gate.release(checkpoint);
}

async function createRunContext(
  fixture: Fixture,
  outcomes: Array<'passed' | 'failed' | 'blocked'>,
  beforeReport?: () => Promise<void>,
  progress?: ProgressFixture,
  reportPreamble = '',
  reportLineEnding: '\n' | '\r\n' = '\n',
): Promise<TestContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-data-'));
  const reportDir = join(dataDir, 'report');
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: fixture.cloneDir,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_ADMIN_PASSWORD: 'phase3-test-password!',
    LUOWANG_MASTER_KEY: 'phase3-test-master-key',
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
    scenarioMode: 'autonomous',
  });
  configuration.updateHarness({
    agents: {
      main: { model: 'fixture-main', thinking: 'off' },
      runner: { model: 'fixture-runner', thinking: 'off' },
      reviewer: { model: 'fixture-reviewer', thinking: 'off' },
    },
  });
  const secretStore = fakeSecretStore();
  const repository = createRepositoryService(database.sqlite, configuration, secretStore, {
    repoDir: config.repoDir,
    allowLocalRepository: true,
  });
  const sessions = new RecordingSessionFactory(
    outcomes,
    beforeReport,
    progress,
    reportPreamble,
    reportLineEnding,
  );
  const orchestrator = createRunOrchestrator({
    configuration,
    repository,
    reportDir,
    sessions,
    provider: {} as ProviderAdapter,
    logger: pino({ level: 'silent' }),
  });
  return { orchestrator, reportDir, repository, sessions };
}

class RecordingSessionFactory implements AgentSessionFactory {
  readonly created: string[] = [];
  readonly disposed: string[] = [];
  readonly inputs: AgentSessionInput[] = [];
  readonly messages: string[] = [];
  readonly sessionObjects: object[] = [];
  private outcomeIndex = 0;

  constructor(
    private readonly outcomes: Array<'passed' | 'failed' | 'blocked'>,
    private readonly beforeReport?: () => Promise<void>,
    private readonly progress?: ProgressFixture,
    private readonly reportPreamble = '',
    private readonly reportLineEnding: '\n' | '\r\n' = '\n',
  ) {}

  async create(input: AgentSessionInput) {
    this.created.push(input.role);
    this.inputs.push(input);
    const session = {
      prompt: async (message: string) => {
        this.messages.push(message);
        if (input.role === 'main-a' && hasTool(input, 'write_plan')) {
          await invokeTool(input, 'get_run_context', {});
          await invokeTool(input, 'write_plan', {
            content: this.progress
              ? `# Plan\n\n按顺序执行场景：\n${this.progress.scenarioIds.map((id) => `- ${id}`).join('\n')}\n`
              : '# Plan\n\n无需场景测试：本次请求只验证文档事实，不影响产品行为。\n',
          });
        } else if (input.role === 'main-a') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'execution.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'draft-report.md' });
          await invokeTool(input, 'write_scenario_patch', {
            content: initializationScenarioPatch(),
          });
        } else if (input.role === 'runner') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          const progressAvailable = hasTool(input, 'begin_scenario_execution');
          const scenarioIds =
            this.progress?.scenarioIds ??
            (progressAvailable && /候选场景顺序/.test(input.userMessage) ? ['INIT-HOME-001'] : []);
          if (progressAvailable) {
            await invokeTool(input, 'begin_scenario_execution', { scenarioIds });
          }
          await this.progress?.checkpoint('declared');
          for (const [index, scenarioId] of scenarioIds.entries()) {
            await invokeTool(input, 'start_scenario', { scenarioId });
            await this.progress?.checkpoint(`started:${scenarioId}`);
            if (index === 0 && this.progress?.failAfterFirstStart) {
              throw new Error('fixture Runner session failed');
            }
            await invokeTool(input, 'finish_scenario', { scenarioId });
            await this.progress?.checkpoint(`finished:${scenarioId}`);
          }
          if (this.beforeReport) await this.beforeReport();
          const outcome =
            this.outcomes[Math.min(this.outcomeIndex++, this.outcomes.length - 1)] ?? 'passed';
          const command = await invokeTool(input, 'run_fixture_command', {
            command: 'node --version',
          });
          await invokeTool(input, 'write_execution', {
            content: `# Execution\n\n固定 target ${extractTarget(input)}\n\n${commandText(command)}\n`,
          });
          await invokeTool(input, 'write_draft_report', {
            content: `# Draft\n\n结果：${outcome}\n`,
          });
        } else if (input.role === 'reviewer') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'execution.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'draft-report.md' });
          await invokeTool(input, 'write_review', {
            content: this.progress
              ? '# Review\n\n独立确认两个场景均按顺序执行并完成。\n'
              : '# Review\n\n独立确认无需场景测试：计划中的影响判断有依据。\n',
          });
        } else {
          const context = parsePromptContext(input.userMessage);
          for (const name of ['plan.md', 'execution.md', 'draft-report.md', 'review.md']) {
            await invokeTool(input, 'read_run_artifact', { name });
          }
          const outcome =
            this.outcomes[Math.min(this.outcomeIndex - 1, this.outcomes.length - 1)] ?? 'passed';
          if (outcome === 'failed') {
            await invokeTool(input, 'query_issue_candidates', { bug_key: 'BUG-LOGIN-001' });
          }
          if (outcome === 'passed') {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(
                this.progress
                  ? progressReportFor(context, this.progress.scenarioIds)
                  : reportFor(context, 'passed', false),
              ),
            });
          } else if (outcome === 'failed') {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(reportFor(context, 'failed', true)),
            });
          } else {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(reportFor(context, 'blocked', false)),
            });
          }
        }
      },
      dispose: () => {
        this.disposed.push(input.role);
      },
    };
    this.sessionObjects.push(session);
    return session;
  }

  private formatReport(content: string): string {
    return `${this.reportPreamble}${content}`.replaceAll('\n', this.reportLineEnding);
  }
}

function hasTool(input: AgentSessionInput, name: string): boolean {
  return input.customTools.some((tool) => tool.name === name);
}

async function invokeTool(
  input: AgentSessionInput,
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = input.customTools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(
    'test-tool-call',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

function initializationScenarioPatch(): string {
  const content = `---
id: INIT-HOME-001
name: 首页可访问
description: 验证项目首页可访问
status: approved
tags:
  - core
---

## 目的

验证首页基础可用性。

## 前置条件

非生产环境可访问。

## 步骤

1. 打开首页。

## 期望

首页成功显示。

## 需要记录

状态码和页面标题。
`;
  const additions = content
    .split('\n')
    .slice(0, -1)
    .map((line) => `+${line}`)
    .join('\n');
  const lines = content.trimEnd().split('\n').length;
  return `diff --git a/docs/scenario-testing/scenarios/INIT-HOME-001.md b/docs/scenario-testing/scenarios/INIT-HOME-001.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/docs/scenario-testing/scenarios/INIT-HOME-001.md
@@ -0,0 +1,${lines} @@
${additions}
`;
}

function commandText(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => ('text' in item ? item.text : '')).join('');
}

function parsePromptContext(prompt: string): {
  runId: string;
  trigger: 'manual' | 'api';
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  startedAt: string;
  finishedAt: string;
} {
  const match = prompt.match(/动态 Run 上下文：\s*([\s\S]+)$/);
  const json = match?.[1];
  assert.ok(json, 'missing prompt context');
  return JSON.parse(json) as ReturnType<typeof parsePromptContext>;
}

function extractTarget(input: AgentSessionInput): string {
  return parsePromptContext(input.userMessage).targetCommit;
}

function reportFor(
  context: ReturnType<typeof parsePromptContext>,
  result: 'passed' | 'failed' | 'blocked',
  failedBug: boolean,
): string {
  const scenarioResults =
    result === 'passed' ? '[]' : `\n  - id: AUTH-LOGIN-001\n    result: ${result}`;
  const bugs = failedBug
    ? `\n  - key: BUG-LOGIN-001\n    title: 登录状态丢失\n    scenario_ids:\n      - AUTH-LOGIN-001\n    issue_action: create`
    : '[]';
  const included = context.includedCommits.length
    ? `\n${context.includedCommits.map((sha) => `  - ${sha}`).join('\n')}`
    : ' []';
  return `---
run_id: ${context.runId}
trigger: ${context.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits:${included}
result: ${result}
started_at: ${context.startedAt}
finished_at: ${context.finishedAt}
scenario_results: ${scenarioResults}
confirmed_bugs: ${bugs}
---

# Report

${
  result === 'passed'
    ? '无需场景测试：Reviewer 已独立确认本批不影响产品行为。'
    : `证据记录见 execution.md 和 review.md。${failedBug ? '\n\n## Issue 查询覆盖缺口\n\n- BUG-LOGIN-001：unavailable' : ''}`
}
`;
}

function progressReportFor(
  context: ReturnType<typeof parsePromptContext>,
  scenarioIds: readonly string[],
): string {
  return `---
run_id: ${context.runId}
trigger: ${context.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits: []
result: passed
started_at: ${context.startedAt}
finished_at: ${context.finishedAt}
scenario_results:
${scenarioIds.map((id) => `  - id: ${id}\n    result: passed`).join('\n')}
confirmed_bugs: []
---

# Report

两个场景均已执行完成。
`;
}

function scenarioMarkdown(id: string, name: string): string {
  return `---
id: ${id}
name: ${name}
description: 验证 ${name} 的业务结果
status: approved
tags:
  - core
---

## 目的

验证 ${name}。
`;
}

async function createGitFixture(withScenarios = false): Promise<Fixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 3 Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase3@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'fixture product\n');
  if (withScenarios) {
    const scenarioDirectory = join(sourceDir, 'docs', 'scenario-testing', 'scenarios');
    await mkdir(scenarioDirectory, { recursive: true });
    await writeFile(
      join(scenarioDirectory, 'AUTH-LOGIN-001.md'),
      scenarioMarkdown('AUTH-LOGIN-001', '登录状态恢复'),
    );
    await writeFile(
      join(scenarioDirectory, 'AUTH-LOGOUT-001.md'),
      scenarioMarkdown('AUTH-LOGOUT-001', '安全退出'),
    );
  }
  await git(['add', '-A'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  await git(['checkout', '-b', 'scenario-testing', 'main'], sourceDir);
  await git(['push', '-u', 'origin', 'scenario-testing'], sourceDir);
  return {
    rootDir,
    remoteDir,
    sourceDir,
    cloneDir,
    initialHead: (await git(['rev-parse', 'scenario-testing'], sourceDir)).stdout.trim(),
  };
}

async function commitAndPush(directory: string, message: string, branch: string): Promise<void> {
  await git(['add', '-A'], directory);
  await git(['commit', '-m', message], directory);
  await git(['push', 'origin', branch], directory);
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
