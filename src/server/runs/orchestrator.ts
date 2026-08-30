import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';

import type {
  AgentConfig,
  RepositoryIssue,
  RunDetail,
  RunResult,
  RunSummary,
} from '../../shared/types.js';
import { parseReportMarkdown, type ParsedReport } from '../repository/markdown.js';
import type { GitRepository } from '../repository/git-repository.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { RepositoryService } from '../repository/service.js';
import type { ConfigurationStore } from '../configuration.js';
import type { SecretStore } from '../security/secret-store.js';
import {
  buildSessionInput,
  createArtifactWriterTool,
  createPiAgentSessionFactory,
  createReadArtifactTool,
  createRunnerCommandTool,
  createTargetContextTools,
} from './agent-session.js';
import { createControlledCommandRunner, type ControlledCommandRunner } from './command-runner.js';
import { createProviderAdapter, type ProviderAdapter } from './provider.js';
import { createRunId, RunWorkspace, RunWorkspaceError, RunWorkspaceStore } from './workspace.js';
import type {
  AgentRole,
  AgentSession,
  AgentSessionFactory,
  RunArtifactName,
  RunContext,
  RunInput,
  RunSnapshot,
  RunState,
} from './types.js';

const TEST_ASSET_PREFIXES = [
  'docs/scenario-testing/scenarios/',
  'docs/scenario-testing/reports/',
] as const;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SENSITIVE_PATH =
  /(^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|password|token|private[-_]?key|key\.txt).*)/i;

export interface RunOrchestratorOptions {
  configuration: ConfigurationStore;
  repository: RepositoryService;
  indexer?: RepositoryIndexer;
  reportDir: string;
  secretStore?: SecretStore;
  provider?: ProviderAdapter;
  sessions?: AgentSessionFactory;
  commandRunner?: ControlledCommandRunner;
  now?: () => Date;
  id?: () => string;
  logger?: Logger;
}

export interface RunOrchestrator {
  start(input: RunInput): Promise<RunSummary>;
  run(input: RunInput): Promise<RunDetail>;
  wait(runId: string): Promise<RunDetail | null>;
  current(): Promise<RunSummary | null>;
  list(): Promise<RunSummary[]>;
  get(runId: string): Promise<RunDetail | null>;
  recover(): Promise<void>;
}

export class RunOrchestratorError extends Error {
  readonly code:
    | 'RUN_ALREADY_ACTIVE'
    | 'RUN_REQUEST_INVALID'
    | 'RUN_TARGET_INVALID'
    | 'RUN_ARTIFACT_INVALID'
    | 'RUN_NOT_FOUND';

  constructor(code: RunOrchestratorError['code'], message: string) {
    super(message);
    this.name = 'RunOrchestratorError';
    this.code = code;
  }
}

export function createRunOrchestrator(options: RunOrchestratorOptions): RunOrchestrator {
  const provider =
    options.provider ??
    createProviderAdapter(options.configuration, requireSecretStore(options.secretStore));
  const sessions = options.sessions ?? createPiAgentSessionFactory({ provider });
  const commandRunner = options.commandRunner ?? createControlledCommandRunner();
  return new DefaultRunOrchestrator(options, sessions, commandRunner);
}

function requireSecretStore(secretStore: SecretStore | undefined): SecretStore {
  if (!secretStore) throw new Error('Run Orchestrator 缺少 Secret Store');
  return secretStore;
}

class DefaultRunOrchestrator implements RunOrchestrator {
  private readonly workspaceStore: RunWorkspaceStore;
  private readonly runs = new Map<string, RunState>();
  private activeRun: RunState | undefined;
  private startInProgress = false;
  private progressedTarget: string | null = null;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly options: RunOrchestratorOptions,
    private readonly sessions: AgentSessionFactory,
    private readonly commandRunner: ControlledCommandRunner,
  ) {
    this.workspaceStore = new RunWorkspaceStore(options.reportDir);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => createRunId(this.now().getTime(), randomBytes(10)));
  }

  async start(input: RunInput): Promise<RunSummary> {
    assertRunInput(input);
    if (this.activeRun || this.startInProgress) {
      throw new RunOrchestratorError('RUN_ALREADY_ACTIVE', '已有一个 Run 正在执行');
    }

    this.startInProgress = true;
    try {
      const runId = this.id();
      const startedAt = this.now().toISOString();
      const workspace = await this.workspaceStore.create(runId);
      const state: RunState = {
        runId,
        status: 'queued',
        phase: 'preparing',
        result: null,
        trigger: input.trigger,
        request: input.request.trim(),
        baseCommit: null,
        targetCommit: null,
        includedCommits: [],
        startedAt,
        finishedAt: null,
        errorMessage: null,
        artifactNames: [],
        completedDirectory: null,
        runningDirectory: workspace.runningDirectory,
      };
      this.runs.set(runId, state);
      this.activeRun = state;
      this.startInProgress = false;
      state.completion = this.execute(state, workspace, input).catch((error: unknown) => {
        this.markExecutionFailure(state, error);
      });
      return toSummary(state);
    } catch (error) {
      this.startInProgress = false;
      throw error;
    }
  }

  async run(input: RunInput): Promise<RunDetail> {
    const summary = await this.start(input);
    const detail = await this.wait(summary.runId);
    if (!detail) throw new RunOrchestratorError('RUN_NOT_FOUND', 'Run 执行结果不存在');
    return detail;
  }

  async wait(runId: string): Promise<RunDetail | null> {
    const state = this.runs.get(runId);
    if (state?.completion) await state.completion;
    return this.get(runId);
  }

  async current(): Promise<RunSummary | null> {
    return this.activeRun ? toSummary(this.activeRun) : null;
  }

  async list(): Promise<RunSummary[]> {
    const seen = new Set<string>();
    const result: RunSummary[] = [];
    for (const state of this.runs.values()) {
      seen.add(state.runId);
      result.push(toSummary(state));
    }
    for (const runId of await this.workspaceStore.list('completed')) {
      if (seen.has(runId)) continue;
      const state = await this.readFilesystemRun(runId, 'completed');
      if (state) result.push(toSummary(state));
    }
    for (const runId of await this.workspaceStore.list('running')) {
      if (seen.has(runId)) continue;
      const state = await this.readFilesystemRun(runId, 'running');
      if (state) result.push(toSummary(state));
    }
    return result.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async get(runId: string): Promise<RunDetail | null> {
    const state = this.runs.get(runId);
    if (state) return this.readStateDetail(state);
    if ((await this.workspaceStore.list('completed')).includes(runId)) {
      const recovered = await this.readFilesystemRun(runId, 'completed');
      return recovered ? this.readStateDetail(recovered) : null;
    }
    if ((await this.workspaceStore.list('running')).includes(runId)) {
      const recovered = await this.readFilesystemRun(runId, 'running');
      return recovered ? this.readStateDetail(recovered) : null;
    }
    return null;
  }

  async recover(): Promise<void> {
    for (const runId of await this.workspaceStore.list('running')) {
      if (this.runs.has(runId)) continue;
      const workspace = this.workspaceStore.open(runId, 'running');
      const artifacts = await workspace.list();
      const timestamp = this.now().toISOString();
      this.runs.set(runId, {
        runId,
        status: 'interrupted',
        phase: 'interrupted',
        result: null,
        trigger: 'manual',
        request: '',
        baseCommit: null,
        targetCommit: null,
        includedCommits: [],
        startedAt: timestamp,
        finishedAt: timestamp,
        errorMessage: '进程重启时 Run 尚在 running 目录，未恢复 Agent 会话',
        artifactNames: Object.keys(artifacts),
        completedDirectory: null,
        runningDirectory: workspace.runningDirectory,
      });
    }
  }

  private async execute(state: RunState, workspace: RunWorkspace, input: RunInput): Promise<void> {
    try {
      state.status = 'running';
      state.phase = 'preparing';
      const prepared = await this.prepareRun(state, input);
      const history = await this.readHistoryIssues(state.runId);
      const context: RunContext = {
        runId: state.runId,
        request: state.request,
        trigger: state.trigger,
        baseCommit: state.baseCommit,
        targetCommit: prepared.targetCommit,
        includedCommits: state.includedCommits,
        repositoryDirectory: prepared.repository.directory,
        runDirectory: workspace.runningDirectory,
        historyIssues: history.issues,
        historyIssuesAvailable: history.available,
      };

      await this.runMainA(state, workspace, prepared.repository, context);
      await this.runRunner(state, workspace, prepared.repository, context);
      await this.runReviewer(state, workspace, context);
      await this.runMainB(state, workspace, context);

      state.phase = 'finalizing';
      const report = await this.validateFinalReport(state, workspace);
      await workspace.finalize();
      state.result = report.result;
      state.status = 'completed';
      state.phase = 'completed';
      state.finishedAt = this.now().toISOString();
      state.completedDirectory = workspace.completedDirectory;
      state.runningDirectory = null;
      state.artifactNames = Object.keys(
        await this.workspaceStore.open(state.runId, 'completed').list(),
      );
      if (report.result === 'passed') this.progressedTarget = report.targetCommit;
    } catch (error) {
      this.markExecutionFailure(state, error);
    } finally {
      await this.options.repository.cleanWorkspace().catch(() => undefined);
      if (this.activeRun === state) this.activeRun = undefined;
    }
  }

  private async prepareRun(
    state: RunState,
    input: RunInput,
  ): Promise<{ repository: GitRepository; targetCommit: string }> {
    const repository = await this.options.repository.getRepository();
    await repository.fetch();
    const targetCommit = input.targetCommit
      ? await repository.resolveCommit(input.targetCommit.trim())
      : await repository.remoteBranchHead(this.options.repository.getScenarioBranch());
    if (!targetCommit) {
      throw new RunOrchestratorError(
        'RUN_TARGET_INVALID',
        '无法固定目标 SHA：场景测试分支不存在或目标 ref 无效',
      );
    }
    const baseCommit = this.progressedTarget;
    if (baseCommit) await this.options.repository.assertScenarioHistory(baseCommit, targetCommit);
    state.baseCommit = baseCommit;
    state.targetCommit = targetCommit;
    state.includedCommits = baseCommit
      ? await this.includedCommits(repository, baseCommit, targetCommit)
      : [];
    const checkedOut = await this.options.repository.checkoutTarget(targetCommit);
    if (checkedOut !== targetCommit) {
      throw new RunOrchestratorError(
        'RUN_TARGET_INVALID',
        '工作树 checkout 的 SHA 与目标 SHA 不一致',
      );
    }
    return { repository, targetCommit };
  }

  private async includedCommits(
    repository: GitRepository,
    baseCommit: string,
    targetCommit: string,
  ): Promise<string[]> {
    const commits = await repository.commitsBetween(baseCommit, targetCommit);
    return commits
      .filter(({ paths }) => paths.length === 0 || paths.some((path) => !isTestAssetPath(path)))
      .map(({ sha }) => sha);
  }

  private async readHistoryIssues(
    runId: string,
  ): Promise<{ issues: RepositoryIssue[]; available: boolean }> {
    try {
      return { issues: await this.options.repository.listIssues(), available: true };
    } catch (error) {
      this.options.logger?.warn(
        { runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'run history issues unavailable',
      );
      return { issues: [], available: false };
    }
  }

  private async runMainA(
    state: RunState,
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
  ): Promise<void> {
    state.phase = 'main-a';
    const tools = [
      ...createTargetContextTools(this.targetToolOptions(repository, context)),
      createArtifactWriterTool(
        'write_plan',
        '写入测试计划',
        '写入本次 Run 唯一的 plan.md。必须写完整 Markdown，不得写其他文件。',
        (content) => workspace.writer('main-a').writePlan(content),
      ),
    ];
    await this.invoke(
      'main-a',
      this.options.configuration.getHarness().agents.main,
      context.repositoryDirectory,
      tools,
      mainAPrompt(context),
    );
    await assertArtifact(workspace, 'plan.md');
  }

  private async runRunner(
    state: RunState,
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
  ): Promise<void> {
    state.phase = 'runner';
    const tools = [
      ...createTargetContextTools(this.targetToolOptions(repository, context)),
      createReadArtifactTool((name) => readAllowedArtifact(workspace, name, ['plan.md'])),
      createRunnerCommandTool((command, signal) =>
        this.commandRunner.run(command, {
          cwd: context.repositoryDirectory,
          runId: context.runId,
          targetCommit: context.targetCommit,
          signal,
        }),
      ),
      createArtifactWriterTool(
        'write_execution',
        '写入执行记录',
        '写入本次 Run 的完整 execution.md，记录命令、观察、失败和清理情况。',
        (content) => workspace.writer('runner').writeExecution(content),
      ),
      createArtifactWriterTool(
        'write_draft_report',
        '写入草稿报告',
        '写入 Runner 的完整 draft-report.md；不要把未经证据支持的结论写成通过。',
        (content) => workspace.writer('runner').writeDraftReport(content),
      ),
    ];
    await this.invoke(
      'runner',
      this.options.configuration.getHarness().agents.runner,
      context.repositoryDirectory,
      tools,
      runnerPrompt(context),
    );
    await assertArtifact(workspace, 'execution.md');
    await assertArtifact(workspace, 'draft-report.md');
  }

  private async runReviewer(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<void> {
    state.phase = 'reviewer';
    const tools = [
      createReadArtifactTool((name) =>
        readAllowedArtifact(workspace, name, ['plan.md', 'execution.md', 'draft-report.md']),
      ),
      createArtifactWriterTool(
        'write_review',
        '写入独立审核',
        '写入本次 Run 的完整 review.md。必须独立核对执行证据和零场景判断。',
        (content) => workspace.writer('reviewer').writeReview(content),
      ),
    ];
    await this.invoke(
      'reviewer',
      this.options.configuration.getHarness().agents.reviewer,
      context.runDirectory,
      tools,
      reviewerPrompt(context),
    );
    await assertArtifact(workspace, 'review.md');
  }

  private async runMainB(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<void> {
    state.phase = 'main-b';
    const tools = [
      createReadArtifactTool((name) =>
        readAllowedArtifact(workspace, name, [
          'plan.md',
          'execution.md',
          'draft-report.md',
          'review.md',
        ]),
      ),
      createArtifactWriterTool(
        'write_report',
        '写入最终报告',
        '写入本次 Run 唯一的 report.md。必须使用指定最小 frontmatter，不得写其他文件。',
        (content) => workspace.writer('main-b').writeReport(content),
      ),
    ];
    await this.invoke(
      'main-b',
      this.options.configuration.getHarness().agents.main,
      context.runDirectory,
      tools,
      mainBPrompt(context),
    );
    await assertArtifact(workspace, 'report.md');
  }

  private async invoke(
    role: AgentRole,
    config: AgentConfig,
    cwd: string,
    tools: ReturnType<typeof createTargetContextTools>,
    prompt: string,
  ): Promise<void> {
    let session: AgentSession | undefined;
    try {
      session = await this.sessions.create(buildSessionInput(role, config, cwd, tools, prompt));
      await session.prompt(prompt);
    } finally {
      if (session) await session.dispose();
    }
  }

  private targetToolOptions(repository: GitRepository, context: RunContext) {
    return {
      readFile: async (path: string) => {
        assertReadableTargetPath(path);
        return repository.readFile(context.targetCommit, path);
      },
      listFiles: async () =>
        (await repository.listTree(context.targetCommit))
          .filter((entry) => entry.type === 'blob' && !SENSITIVE_PATH.test(entry.path))
          .map((entry) => entry.path),
      search: async (query: string) => this.searchTarget(repository, context.targetCommit, query),
      context: () =>
        JSON.stringify({
          runId: context.runId,
          request: context.request,
          trigger: context.trigger,
          baseCommit: context.baseCommit,
          targetCommit: context.targetCommit,
          includedCommits: context.includedCommits,
          repositoryDirectory: context.repositoryDirectory,
          runDirectory: context.runDirectory,
          historyIssuesAvailable: context.historyIssuesAvailable,
          historyIssues: context.historyIssues,
          indexedScenarios:
            this.options.indexer?.listScenarios().map((scenario) => ({
              id: scenario.id,
              name: scenario.name,
              status: scenario.status,
              tags: scenario.tags,
            })) ?? [],
          indexedReports:
            this.options.indexer?.listReports().map((report) => ({
              runId: report.runId,
              result: report.result,
              targetCommit: report.targetCommit,
              scenarioResults: report.scenarioResults,
            })) ?? [],
        }),
    };
  }

  private async searchTarget(
    repository: GitRepository,
    targetCommit: string,
    query: string,
  ): Promise<string> {
    if (query.trim() === '') return '搜索关键词不能为空';
    const normalizedQuery = query.toLocaleLowerCase();
    const matches: string[] = [];
    for (const entry of await repository.listTree(targetCommit)) {
      if (entry.type !== 'blob' || SENSITIVE_PATH.test(entry.path)) continue;
      if (matches.length >= 100) break;
      try {
        const content = await repository.readFile(targetCommit, entry.path);
        if (Buffer.byteLength(content, 'utf8') > MAX_SEARCH_FILE_BYTES) continue;
        if (content.toLocaleLowerCase().includes(normalizedQuery)) matches.push(entry.path);
      } catch {
        // Binary and unreadable files are intentionally skipped by the read-only search tool.
      }
    }
    return matches.join('\n');
  }

  private async validateFinalReport(
    state: RunState,
    workspace: RunWorkspace,
  ): Promise<ParsedReport> {
    let parsed: ParsedReport;
    try {
      parsed = parseReportMarkdown(
        await workspace.read('report.md'),
        `${workspace.runningDirectory}/report.md`,
        state.runId,
      );
    } catch (error) {
      throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', safeMessage(error));
    }
    if (
      parsed.trigger !== state.trigger ||
      parsed.baseCommit !== state.baseCommit ||
      parsed.targetCommit !== state.targetCommit ||
      !sameStringArray(parsed.includedCommits, state.includedCommits)
    ) {
      throw new RunOrchestratorError(
        'RUN_ARTIFACT_INVALID',
        '最终报告中的 Run 范围与固定执行范围不一致',
      );
    }

    const expected = aggregateResult(
      parsed.scenarioResults.map((item) => item.result),
      parsed.confirmedBugs.length > 0,
    );
    if (parsed.result !== expected && !(parsed.result === 'blocked' && expected !== 'passed')) {
      throw new RunOrchestratorError(
        'RUN_ARTIFACT_INVALID',
        '最终报告结果与场景结果聚合优先级不一致',
      );
    }
    if (parsed.result === 'failed' && parsed.confirmedBugs.length === 0) {
      throw new RunOrchestratorError(
        'RUN_ARTIFACT_INVALID',
        'failed 报告必须至少包含一个 confirmed bug',
      );
    }
    if (parsed.scenarioResults.length === 0 && parsed.result === 'passed') {
      const plan = await workspace.read('plan.md');
      const review = await workspace.read('review.md');
      const report = await workspace.read('report.md');
      if (
        !hasZeroScenarioEvidence(plan) ||
        !hasZeroScenarioEvidence(review) ||
        !hasZeroScenarioEvidence(report)
      ) {
        throw new RunOrchestratorError(
          'RUN_ARTIFACT_INVALID',
          '零场景 passed 必须在 plan、review 和最终报告中说明无需场景测试的依据',
        );
      }
    }
    return parsed;
  }

  private markExecutionFailure(state: RunState, error: unknown): void {
    if (state.status === 'completed' || state.status === 'interrupted') return;
    state.status = 'failed';
    state.phase = 'failed';
    state.finishedAt = this.now().toISOString();
    state.errorMessage = safeMessage(error);
    this.options.logger?.error(
      {
        runId: state.runId,
        phase: state.phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'run failed',
    );
  }

  private async readStateDetail(state: RunState): Promise<RunDetail> {
    const placement = state.status === 'completed' ? 'completed' : 'running';
    let artifacts: Record<string, string> = {};
    try {
      artifacts = await this.workspaceStore.open(state.runId, placement).list();
    } catch {
      // The summary remains useful if a just-failed process is cleaning its workspace.
    }
    state.artifactNames = Object.keys(artifacts);
    return { ...toSummary(state), artifacts };
  }

  private async readFilesystemRun(
    runId: string,
    placement: 'running' | 'completed',
  ): Promise<RunState | undefined> {
    const workspace = this.workspaceStore.open(runId, placement);
    const artifacts = await workspace.list();
    const report = artifacts['report.md'];
    if (!report) {
      return {
        runId,
        status: placement === 'completed' ? 'failed' : 'interrupted',
        phase: placement === 'completed' ? 'failed' : 'interrupted',
        result: null,
        trigger: 'manual',
        request: '',
        baseCommit: null,
        targetCommit: null,
        includedCommits: [],
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        errorMessage:
          placement === 'completed' ? 'completed 目录缺少 report.md' : '遗留 running Run 未恢复',
        artifactNames: Object.keys(artifacts),
        completedDirectory: placement === 'completed' ? workspace.completedDirectory : null,
        runningDirectory: placement === 'running' ? workspace.runningDirectory : null,
      };
    }
    try {
      const parsed = parseReportMarkdown(report, `${placement}/${runId}/report.md`, runId);
      return {
        runId,
        status: 'completed',
        phase: 'completed',
        result: parsed.result,
        trigger: parsed.trigger,
        request: '',
        baseCommit: parsed.baseCommit,
        targetCommit: parsed.targetCommit,
        includedCommits: parsed.includedCommits,
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        errorMessage: null,
        artifactNames: Object.keys(artifacts),
        completedDirectory: workspace.completedDirectory,
        runningDirectory: null,
      };
    } catch {
      return {
        runId,
        status: placement === 'completed' ? 'failed' : 'interrupted',
        phase: placement === 'completed' ? 'failed' : 'interrupted',
        result: null,
        trigger: 'manual',
        request: '',
        baseCommit: null,
        targetCommit: null,
        includedCommits: [],
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        errorMessage: 'Run report frontmatter 无法解析',
        artifactNames: Object.keys(artifacts),
        completedDirectory: placement === 'completed' ? workspace.completedDirectory : null,
        runningDirectory: placement === 'running' ? workspace.runningDirectory : null,
      };
    }
  }
}

function assertRunInput(input: RunInput): void {
  if (!input || typeof input.request !== 'string' || input.request.trim() === '') {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'Run 请求内容不能为空');
  }
  if (!['manual', 'api'].includes(input.trigger)) {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'Phase 3 只支持 manual 或 api 触发');
  }
  if (input.targetCommit !== undefined && input.targetCommit.trim() === '') {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'targetCommit 不能为空');
  }
}

function isTestAssetPath(path: string): boolean {
  return TEST_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function assertReadableTargetPath(path: string): void {
  if (
    path.trim() === '' ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    SENSITIVE_PATH.test(path)
  ) {
    throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', '目标文件路径无效或包含敏感内容');
  }
}

async function assertArtifact(
  workspace: RunWorkspace,
  name: 'plan.md' | 'execution.md' | 'draft-report.md' | 'review.md' | 'report.md',
): Promise<void> {
  if (!(await workspace.exists(name))) {
    throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', `角色没有写入必需工件：${name}`);
  }
}

async function readAllowedArtifact(
  workspace: RunWorkspace,
  name: string,
  allowed: readonly RunArtifactName[],
): Promise<string> {
  if (!allowed.includes(name as RunArtifactName)) {
    throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', `当前角色不能读取工件：${name}`);
  }
  return workspace.read(name as RunArtifactName);
}

function aggregateResult(results: RunResult[], hasConfirmedBug: boolean): RunResult {
  if (results.includes('blocked')) return 'blocked';
  if (results.includes('failed') || hasConfirmedBug) return 'failed';
  return 'passed';
}

function hasZeroScenarioEvidence(content: string): boolean {
  return /无需\s*场景|零场景|no\s+scenarios?|no\s+scenario\s+testing|does\s+not\s+require\s+(?:a\s+)?scenario/i.test(
    content,
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toSummary(state: RunSnapshot): RunSummary {
  return {
    runId: state.runId,
    status: state.status,
    phase: state.phase,
    result: state.result,
    trigger: state.trigger,
    request: state.request,
    baseCommit: state.baseCommit,
    targetCommit: state.targetCommit,
    includedCommits: [...state.includedCommits],
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    errorMessage: state.errorMessage,
    artifactNames: [...state.artifactNames],
  };
}

function safeMessage(error: unknown): string {
  if (error instanceof RunOrchestratorError || error instanceof RunWorkspaceError)
    return error.message;
  return 'Run 执行失败，未生成可信最终结论';
}

function mainAPrompt(context: RunContext): string {
  return `你是 LuoWang Phase 3 的 Main A。你负责理解本次变化、选择已有场景并形成计划，不能执行测试，也不能修改目标仓库。

固定 Run 上下文：
${JSON.stringify(context, null, 2)}

必须先调用 get_run_context、list_target_files，并按需调用 read_target_file/search_target_files 读取固定 target。上下文中的 historyIssuesAvailable 为 false 时，不能把 Issue 历史当作空列表，需在覆盖缺口中说明。只能通过 write_plan 写入完整 plan.md，并且必须在结束前调用它。plan.md 要说明请求、base/target/included commits、影响判断、选择的场景及顺序、预期证据和覆盖缺口。
如果本批产品行为不需要场景测试，必须明确写出“无需场景测试”的理由；如果场景缺失、影响不明或证据不足，必须把覆盖缺口写清楚，不能把零场景当作 passed。Phase 3 不允许生成 scenario-changes.patch。`;
}

function runnerPrompt(context: RunContext): string {
  return `你是 LuoWang Phase 3 的 Runner。你只能在固定 target 工作树中顺序执行计划要求的本地 fixture/API/CLI 测试。

固定 Run 上下文：
${JSON.stringify(context, null, 2)}

先读取 plan.md，再按计划使用 read_target_file、search_target_files 和 run_fixture_command。run_fixture_command 只允许受控本地命令，不能读取或猜测 Harness Secret，不能写产品源码，不能使用 shell 管道/重定向。每个场景记录实际观察、命令退出码、证据和清理结果。最后必须分别通过 write_execution 写完整 execution.md、通过 write_draft_report 写完整 draft-report.md。环境/命令/凭据不可用时记录为 blocked，不伪造通过。`;
}

function reviewerPrompt(context: RunContext): string {
  return `你是独立的 LuoWang Phase 3 Reviewer。你没有 Runner 对话，只能读取本次 Run 的 plan.md、execution.md、draft-report.md。

固定 Run 上下文：
${JSON.stringify(context, null, 2)}

请独立核对计划、执行证据、场景结果、confirmed bugs、清理和阻塞原因。不能使用命令，不能读取测试账号或其他 Secret。若零场景，只有在 Main A 的计划确实证明本批无需场景测试时才确认；场景缺失或影响不明必须维持 blocked。结束前必须通过 write_review 写完整 review.md，并明确是否同意最终结果。`;
}

function mainBPrompt(context: RunContext): string {
  return `你是 LuoWang Phase 3 的 Main B。你只能读取本次 Run 的四个前置 Markdown 工件，并根据 Reviewer 审核形成最终 report.md。

固定 Run 上下文：
${JSON.stringify(context, null, 2)}

必须先读取 plan.md、execution.md、draft-report.md、review.md。最终 report.md 只能包含以下 frontmatter 字段：run_id、trigger、base_commit、target_commit、included_commits、result、started_at、finished_at、scenario_results、confirmed_bugs。字段值必须与固定 Run 一致；result 聚合优先级为 blocked > failed > passed。failed 必须至少有一个 confirmed_bugs；confirmed bug 的 issue_action 只能是 create 或 link，link 必须有 issue_url。零场景 passed 必须在 plan、review 和本报告中都保留“无需场景测试”的依据。不要写隐藏推理、Secret、绝对证据路径或额外状态文件。结束前必须通过 write_report 写完整 report.md。`;
}
