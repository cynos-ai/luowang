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

  it('passes read-only historical Issue context to Main A', async () => {
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
    assert.match(context.sessions.inputs[0]?.systemPrompt ?? '', /历史登录问题/);
    assert.match(context.sessions.inputs[0]?.systemPrompt ?? '', /historyIssuesAvailable/);
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

async function createRunContext(
  fixture: Fixture,
  outcomes: Array<'passed' | 'failed' | 'blocked'>,
  beforeReport?: () => Promise<void>,
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
  const sessions = new RecordingSessionFactory(outcomes, beforeReport);
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
  readonly sessionObjects: object[] = [];
  private outcomeIndex = 0;

  constructor(
    private readonly outcomes: Array<'passed' | 'failed' | 'blocked'>,
    private readonly beforeReport?: () => Promise<void>,
  ) {}

  async create(input: AgentSessionInput) {
    this.created.push(input.role);
    this.inputs.push(input);
    const session = {
      prompt: async () => {
        if (input.role === 'main-a') {
          await invokeTool(input, 'get_run_context', {});
          await invokeTool(input, 'write_plan', {
            content: '# Plan\n\n无需场景测试：本次请求只验证文档事实，不影响产品行为。\n',
          });
        } else if (input.role === 'runner') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
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
            content: '# Review\n\n独立确认无需场景测试：计划中的影响判断有依据。\n',
          });
        } else {
          const context = parsePromptContext(input.systemPrompt);
          for (const name of ['plan.md', 'execution.md', 'draft-report.md', 'review.md']) {
            await invokeTool(input, 'read_run_artifact', { name });
          }
          const outcome =
            this.outcomes[Math.min(this.outcomeIndex - 1, this.outcomes.length - 1)] ?? 'passed';
          if (outcome === 'passed') {
            await invokeTool(input, 'write_report', {
              content: reportFor(context, 'passed', false),
            });
          } else if (outcome === 'failed') {
            await invokeTool(input, 'write_report', {
              content: reportFor(context, 'failed', true),
            });
          } else {
            await invokeTool(input, 'write_report', {
              content: reportFor(context, 'blocked', false),
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

function commandText(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => ('text' in item ? item.text : '')).join('');
}

function parsePromptContext(prompt: string): {
  runId: string;
  trigger: 'manual' | 'api';
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
} {
  const match = prompt.match(
    /固定 Run 上下文：\s*([\s\S]*?)\s*\n\s*必须|固定 Run 上下文：\s*([\s\S]*?)\s*\n\s*请|固定 Run 上下文：\s*([\s\S]*?)\s*\n\s*先/,
  );
  const json = match?.[1] ?? match?.[2] ?? match?.[3];
  assert.ok(json, 'missing prompt context');
  return JSON.parse(json) as ReturnType<typeof parsePromptContext>;
}

function extractTarget(input: AgentSessionInput): string {
  return parsePromptContext(input.systemPrompt).targetCommit;
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
started_at: 2026-08-30T00:00:00Z
finished_at: 2026-08-30T00:01:00Z
scenario_results: ${scenarioResults}
confirmed_bugs: ${bugs}
---

# Report

${result === 'passed' ? '无需场景测试：Reviewer 已独立确认本批不影响产品行为。' : '证据记录见 execution.md 和 review.md。'}
`;
}

async function createGitFixture(): Promise<Fixture> {
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
  await git(['add', 'README.md'], sourceDir);
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
