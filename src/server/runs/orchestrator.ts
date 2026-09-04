import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { Type } from 'typebox';
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type {
  AgentConfig,
  RepositoryIssue,
  RepositoryConfig,
  RunDetail,
  RunPhase,
  RunResult,
  RunSummary,
} from '../../shared/types.js';
import {
  parseReportMarkdown,
  parseScenarioMarkdown,
  type ParsedReport,
} from '../repository/markdown.js';
import type { GitRepository } from '../repository/git-repository.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { RepositoryService } from '../repository/service.js';
import type { ConfigurationStore } from '../configuration.js';
import type { SecretStore } from '../security/secret-store.js';
import {
  browserNeedsVision,
  browserScenarioRequested,
  createPlaywrightMcpAdapter,
  supportsVision,
  type BrowserMcpAdapter,
} from '../browser/playwright-mcp.js';
import { createOssAdapter, type OssAdapter } from '../storage/oss.js';
import {
  buildSessionInput,
  createArtifactWriterTool,
  createPiAgentSessionFactory,
  createReadArtifactTool,
  createRunnerCommandTool,
  createTargetContextTools,
  createTextResult,
  createWorkingScenarioTools,
} from './agent-session.js';
import { createControlledCommandRunner, type ControlledCommandRunner } from './command-runner.js';
import {
  createReviewerEvidenceTools,
  createRunEvidenceStore,
  createRunnerEvidenceTools,
  type RunEvidenceStore,
} from './evidence.js';
import { createProviderAdapter, type ProviderAdapter } from './provider.js';
import { createIssueCandidateController, createRunHistoryTool } from './run-history.js';
import { createScenarioProgressController, type ProgressScenario } from './scenario-progress.js';
import {
  createReviewerTestDataTools,
  createTestDataManager,
  createTestDataTools,
  type TestDataManager,
} from './test-data.js';
import {
  createRoleInstructionLoader,
  RoleInstructionError,
  type RoleInstructionLoader,
} from './role-instructions.js';
import type { RunStore } from './store.js';
import type { RunRecoveryStore } from '../automation/recovery.js';
import { createRunId, RunWorkspace, RunWorkspaceError, RunWorkspaceStore } from './workspace.js';
import {
  ScenarioPatchError,
  validateScenarioPatchText,
  type ScenarioPatchValidation,
} from '../repository/scenario-patch.js';
import type {
  AgentRole,
  AgentSession,
  AgentSessionFactory,
  AgentSessionKind,
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
  browser?: BrowserMcpAdapter;
  oss?: OssAdapter;
  testData?: TestDataManager;
  runStore?: RunStore;
  recoveryStore?: RunRecoveryStore;
  now?: () => Date;
  id?: () => string;
  logger?: Logger;
  roleInstructions?: RoleInstructionLoader;
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
  const secretStore = options.secretStore;
  const provider =
    options.provider ??
    createProviderAdapter(options.configuration, requireSecretStore(options.secretStore));
  const sessions = options.sessions ?? createPiAgentSessionFactory({ provider });
  const commandRunner = options.commandRunner ?? createControlledCommandRunner();
  const browser = options.browser ?? createPlaywrightMcpAdapter(options.configuration);
  const oss =
    options.oss ?? (secretStore ? createOssAdapter(options.configuration, secretStore) : undefined);
  const testData = options.testData ?? createTestDataManager();
  return new DefaultRunOrchestrator(
    { ...options, provider, browser, oss, testData },
    sessions,
    commandRunner,
    options.roleInstructions ?? createRoleInstructionLoader(),
  );
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
    private readonly roleInstructions: RoleInstructionLoader,
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
      const runId = input.runId ?? this.id();
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
        evidence: [],
        scenarioMode: this.options.configuration.getRepository().scenarioMode,
        initialization: input.initialization === true,
        currentScenario: null,
        scenarioProgress: { completed: 0, total: 0 },
        activities: [{ at: startedAt, message: 'Run 已创建，等待准备', kind: 'phase' }],
        blockingReasons: [],
        updatedAt: startedAt,
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
    for (const recovered of this.options.recoveryStore?.list() ?? []) {
      if (!seen.has(recovered.runId)) result.push(recovered);
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
    const interrupted = this.options.recoveryStore?.get(runId);
    return interrupted ? { ...interrupted, artifacts: {} } : null;
  }

  async recover(): Promise<void> {
    for (const runId of await this.workspaceStore.list('running')) {
      if (this.runs.has(runId)) continue;
      const workspace = this.workspaceStore.open(runId, 'running');
      const artifacts = await workspace.list();
      const timestamp = this.now().toISOString();
      const state: RunState = {
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
        evidence: [],
      };
      this.runs.set(runId, state);
      this.options.recoveryStore?.record(toSummary(state), {
        interruptedAt: timestamp,
        runningDirectory: workspace.runningDirectory,
      });
    }
  }

  private async execute(state: RunState, workspace: RunWorkspace, input: RunInput): Promise<void> {
    try {
      state.status = 'running';
      this.setPhase(state, 'preparing', '正在固定 base、target 和提交范围');
      const prepared = await this.prepareRun(state, input);
      const history = await this.readHistoryIssues(state.runId);
      const context: RunContext = {
        runId: state.runId,
        request: state.request,
        trigger: state.trigger,
        baseCommit: state.baseCommit,
        targetCommit: prepared.targetCommit,
        includedCommits: state.includedCommits,
        startedAt: state.startedAt,
        reportFinishedAt: null,
        repositoryDirectory: prepared.repository.directory,
        runDirectory: workspace.runningDirectory,
        historyIssues: history.issues,
        historyIssuesAvailable: history.available,
        evidence: [],
        blockingReasons: [],
        browserRequired: false,
        scenarioMode: this.options.configuration.getRepository().scenarioMode,
        initialization: input.initialization === true,
      };
      const evidenceStore = this.options.oss
        ? createRunEvidenceStore(workspace, this.options.oss)
        : undefined;

      if (context.initialization)
        await this.assessInitializationPreflight(context, prepared.repository);
      await this.runMainA(state, workspace, prepared.repository, context);
      await this.assessBrowserRequirements(workspace, context);
      let scenarioDecision: ScenarioPatchDecision = 'none';
      if (context.initialization) {
        await this.runRunner(
          state,
          workspace,
          prepared.repository,
          context,
          evidenceStore,
          'initialization-reconnaissance',
        );
        await this.runInitializationCandidateMain(state, workspace, prepared.repository, context);
      }
      scenarioDecision = await this.prepareScenarioPatch(workspace, prepared.repository, context);
      if (scenarioDecision === 'review') {
        const closure = await this.finishScenarioReviewRunner(
          state,
          workspace,
          context,
          evidenceStore,
        );
        await this.finishScenarioReviewRun(state, workspace, context, closure);
        return;
      }
      let runnerCleanup: { uploaded: boolean; uploadFailed: boolean } = {
        uploaded: false,
        uploadFailed: false,
      };
      try {
        if (context.initialization && scenarioDecision === 'applied') {
          await this.runRunner(
            state,
            workspace,
            prepared.repository,
            context,
            evidenceStore,
            'initialization-validation',
          );
        } else if (!context.initialization) {
          await this.runRunner(
            state,
            workspace,
            prepared.repository,
            context,
            evidenceStore,
            'standard',
          );
        }
      } finally {
        try {
          runnerCleanup = await this.finishRunner(state, workspace, context, evidenceStore);
        } catch (error) {
          this.addBlockingReason(context, `Runner 收尾失败：${safeMessage(error)}`);
          await this.appendExecutionNotes(workspace, [
            `Runner 收尾失败，Run 已阻塞：${safeMessage(error)}`,
          ]).catch(() => undefined);
        }
      }
      await this.validateScenarioPatchForReview(workspace, prepared.repository, context);
      await this.runReviewer(state, workspace, context, evidenceStore);
      if ((evidenceStore?.readFailureCount?.() ?? 0) > 0) {
        this.addBlockingReason(context, 'Reviewer 无法读取一项或多项 evidence');
        await this.appendExecutionNotes(workspace, ['Reviewer 无法读取一项或多项 evidence。']);
      }
      if (
        context.browserRequired &&
        context.evidence.some((reference) => reference.contentType.startsWith('image/')) &&
        evidenceStore?.reviewReadCount &&
        evidenceStore.reviewReadCount() === 0
      ) {
        this.addBlockingReason(context, 'Reviewer 未读取截图 evidence，无法完成独立视觉审核');
        await this.appendExecutionNotes(workspace, [
          'Reviewer 未读取截图 evidence，无法完成独立视觉审核。',
        ]);
      }
      await this.finalizeTestData(workspace, context);
      if (runnerCleanup.uploaded && !runnerCleanup.uploadFailed) {
        await this.cleanupRetainedEvidence(workspace, context, evidenceStore);
      }
      const patchBeforeFinalMain = await readOptionalScenarioPatch(workspace);
      await this.runMainB(state, workspace, context);
      await this.validateInitializationFinalPatch(
        workspace,
        prepared.repository,
        context,
        patchBeforeFinalMain,
      );
      state.blockingReasons = [...context.blockingReasons];
      state.updatedAt = this.now().toISOString();
      await this.forceInfrastructureBlockedReport(workspace, context);

      this.setPhase(state, 'finalizing', '正在校验最终报告并准备归档');
      const report = await this.validateFinalReport(state, workspace, context);
      await workspace.finalize();
      state.result = report.result;
      state.status = 'completed';
      this.setPhase(state, 'completed', `Run 已完成：${report.result}`);
      state.finishedAt = this.now().toISOString();
      state.completedDirectory = workspace.completedDirectory;
      state.runningDirectory = null;
      state.artifactNames = Object.keys(
        await this.workspaceStore.open(state.runId, 'completed').list(),
      );
      await this.persistCompletedRun(state, report, {
        specialRun: false,
        scenarioMode: context.scenarioMode,
        initialization: context.initialization,
      });
      this.options.recoveryStore?.remove(state.runId);
      if (report.result === 'passed' && !this.options.runStore) {
        // Phase 5 moves progression to the SQLite-backed Archiver. Keep the
        // in-memory fallback for callers that intentionally use the Phase 3
        // orchestrator without an Archiver.
        this.progressedTarget = report.targetCommit;
      }
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
    const baseCommit = this.options.runStore?.getLastCompletedTarget() ?? this.progressedTarget;
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
    this.setPhase(state, 'main-a', 'Main · 规划正在分析变更并选择场景');
    const tools = [
      ...createTargetContextTools(this.targetToolOptions(repository, context, 'main-planning')),
      createRunHistoryTool({
        runStore: this.options.runStore,
        recoveryStore: this.options.recoveryStore,
      }),
      createArtifactWriterTool(
        'write_plan',
        '写入测试计划',
        '写入本次 Run 唯一的 plan.md。必须写完整 Markdown，不得写其他文件。',
        (content) => workspace.writer('main-a').writePlan(content),
      ),
      ...(context.initialization
        ? []
        : [
            createArtifactWriterTool(
              'write_scenario_patch',
              '写入场景变更 patch',
              '只写入 docs/scenario-testing/scenarios/** 范围内的标准 git unified patch；不能直接修改目标仓库或其他目录。',
              (content) => workspace.writer('main-a').writeScenarioPatch(content),
            ),
          ]),
    ];
    await this.invoke(
      'main-planning',
      'main-a',
      this.options.configuration.getHarness().agents.main,
      context.repositoryDirectory,
      tools,
      mainAUserMessage(context),
      mainAOutputContract(context),
      context.initialization,
    );
    await assertArtifact(workspace, 'plan.md');
  }

  private async assessInitializationPreflight(
    context: RunContext,
    repository: GitRepository,
  ): Promise<void> {
    const config = this.options.configuration.getRepository();
    if (!isValidTestEnvironmentUrl(config.baseUrl.trim())) {
      this.addBlockingReason(context, '初始化所需的非生产测试环境基础 URL 未配置或无效');
    }
    try {
      if (
        !this.options.secretStore?.has('testUsername') ||
        !this.options.secretStore.has('testPassword')
      ) {
        this.addBlockingReason(context, '初始化所需的测试账号未配置');
      }
    } catch {
      this.addBlockingReason(context, '初始化所需的测试账号不可读取');
    }
    try {
      await repository.listTree(context.targetCommit);
    } catch {
      this.addBlockingReason(context, '初始化无法读取固定 target 的仓库树');
    }
  }

  private async runInitializationCandidateMain(
    state: RunState,
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
  ): Promise<void> {
    this.setPhase(state, 'main-a', 'Main · 规划正在整理初始化候选场景');
    const tools = [
      ...createTargetContextTools(this.targetToolOptions(repository, context, 'main-planning')),
      createRunHistoryTool({
        runStore: this.options.runStore,
        recoveryStore: this.options.recoveryStore,
      }),
      createReadArtifactTool((name) =>
        readAllowedArtifact(workspace, name, ['plan.md', 'execution.md', 'draft-report.md']),
      ),
      createArtifactWriterTool(
        'write_scenario_patch',
        '写入候选场景 patch',
        '只写入 docs/scenario-testing/scenarios/** 范围内的标准 git unified patch；不能直接修改目标仓库或创建 suite、catalog、journey 或能力图文件。',
        async (content) => {
          try {
            await repository.validateScenarioPatch(context.targetCommit, content);
          } catch (error) {
            throw new RunOrchestratorError(
              'RUN_ARTIFACT_INVALID',
              `候选场景 patch 无效，请修正后重新调用 write_scenario_patch：${safeMessage(error)}`,
            );
          }
          await workspace.writer('main-a').writeScenarioPatch(content);
        },
      ),
    ];
    await this.invoke(
      'main-planning',
      'main-a',
      this.options.configuration.getHarness().agents.main,
      context.repositoryDirectory,
      tools,
      initializationCandidateUserMessage(context),
      initializationCandidateOutputContract(),
      true,
    );
  }

  private async prepareScenarioPatch(
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
  ): Promise<ScenarioPatchDecision> {
    const patch = await readOptionalScenarioPatch(workspace);
    if (patch === undefined) {
      if (context.initialization) {
        const targetScenes = (await repository.listTree(context.targetCommit)).filter(
          (entry) =>
            entry.type === 'blob' &&
            entry.path.startsWith('docs/scenario-testing/scenarios/') &&
            entry.path.endsWith('.md'),
        );
        if (targetScenes.length === 0) {
          this.addBlockingReason(context, '初始化未生成候选场景 patch，无法建立可信场景基线');
        }
      }
      return 'none';
    }

    let metadata: ScenarioPatchValidation;
    try {
      metadata = validateScenarioPatchText(patch);
    } catch (error) {
      this.addBlockingReason(context, `场景 patch 校验失败：${safeMessage(error)}`);
      return 'review';
    }
    context.scenarioChanges = metadata;

    const requiresReview =
      context.scenarioMode === 'review-all' ||
      (context.scenarioMode === 'add-only' && !metadata.onlyAdds);
    try {
      if (requiresReview) {
        context.scenarioChanges = await repository.validateScenarioPatch(
          context.targetCommit,
          patch,
        );
      } else {
        context.scenarioChanges = await repository.applyScenarioPatch(context.targetCommit, patch);
      }
    } catch (error) {
      this.addBlockingReason(context, `场景 patch 校验失败：${safeMessage(error)}`);
      return 'review';
    }

    if (requiresReview) {
      this.addBlockingReason(
        context,
        context.scenarioMode === 'review-all'
          ? '当前场景模式 review-all 要求人工审核场景变更'
          : 'add-only 只允许直接发布纯新增 patch，本次 patch 含修改或 rename，需要人工审核',
      );
      return 'review';
    }
    return 'applied';
  }

  private async finishScenarioReviewRunner(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
    evidenceStore: RunEvidenceStore | undefined,
  ): Promise<ScenarioReviewClosure> {
    try {
      await this.finishRunner(state, workspace, context, evidenceStore);
    } catch (error) {
      this.addBlockingReason(context, `Runner 收尾失败：${safeMessage(error)}`);
      await this.appendExecutionNotes(workspace, [
        `Runner 收尾失败，特殊场景审核 Run 已阻塞：${safeMessage(error)}`,
      ]).catch(() => undefined);
    }
    const testData = await this.finalizeTestData(workspace, context);
    if (!evidenceStore) {
      return { testDataMessage: testData.message, evidenceDeleted: 0, evidenceDeleteFailures: 0 };
    }

    const cleanup = await evidenceStore.cleanupUploaded();
    if (cleanup.deleted.length > 0) {
      await this.appendExecutionNotes(workspace, [
        `特殊场景审核不保留执行 evidence；已删除 ${cleanup.deleted.length} 个已上传 OSS 对象。`,
      ]);
    }
    for (const failure of cleanup.failures) {
      this.addBlockingReason(context, `特殊场景审核 evidence 删除失败：${failure.filename}`);
    }
    if (cleanup.failures.length > 0) {
      await this.appendExecutionNotes(
        workspace,
        cleanup.failures.map(
          (failure) => `特殊场景审核 evidence 删除失败：${failure.filename}（${failure.message}）`,
        ),
      );
    }
    context.evidence = [];
    state.evidence = [];
    return {
      testDataMessage: testData.message,
      evidenceDeleted: cleanup.deleted.length,
      evidenceDeleteFailures: cleanup.failures.length,
    };
  }

  private async finishScenarioReviewRun(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
    closure: ScenarioReviewClosure,
  ): Promise<void> {
    this.addBlockingReason(context, 'Run 等待场景变更人工审核，不等待 PR 合并');
    const finishedAt = this.now().toISOString();
    const reportContent = buildScenarioReviewReport(state, context, finishedAt, closure);
    await workspace.writer('main-b').writeReport(reportContent);
    const report = parseReportMarkdown(
      reportContent,
      `${workspace.runningDirectory}/report.md`,
      state.runId,
    );
    state.blockingReasons = [...context.blockingReasons];
    state.updatedAt = this.now().toISOString();
    await workspace.finalize({ specialScenarioReview: true });
    state.result = report.result;
    state.status = 'completed';
    this.setPhase(state, 'completed', `场景审核 Run 已完成：${report.result}`);
    state.finishedAt = finishedAt;
    state.completedDirectory = workspace.completedDirectory;
    state.runningDirectory = null;
    state.artifactNames = Object.keys(
      await this.workspaceStore.open(state.runId, 'completed').list(),
    );
    await this.persistCompletedRun(state, report, {
      specialRun: true,
      scenarioMode: context.scenarioMode,
      initialization: context.initialization,
    });
    this.options.recoveryStore?.remove(state.runId);
  }

  private async validateInitializationFinalPatch(
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
    before: string | undefined,
  ): Promise<void> {
    if (!context.initialization) return;
    const after = await readOptionalScenarioPatch(workspace);
    if (after === before) return;
    if (after === undefined) {
      this.addBlockingReason(context, '初始化最终修订移除了候选场景 patch，未形成可发布基线');
      return;
    }
    try {
      context.scenarioChanges = await repository.validateScenarioPatch(context.targetCommit, after);
      this.addBlockingReason(context, '初始化最终 Main 修改了场景 patch，修订内容未重新执行');
    } catch (error) {
      this.addBlockingReason(context, `初始化最终场景 patch 校验失败：${safeMessage(error)}`);
    }
  }

  private async runRunner(
    state: RunState,
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
    evidenceStore: RunEvidenceStore | undefined,
    purpose: 'standard' | 'initialization-reconnaissance' | 'initialization-validation',
  ): Promise<void> {
    this.setPhase(
      state,
      'runner',
      purpose === 'initialization-reconnaissance'
        ? 'Runner 正在执行初始化运行时侦察'
        : 'Runner 正在执行场景并收集证据',
    );
    const progress =
      purpose === 'initialization-reconnaissance'
        ? undefined
        : createScenarioProgressController({
            state,
            allowedScenarios: await this.progressScenarios(workspace, repository, purpose),
            now: this.now,
          });
    const tools = [
      ...createTargetContextTools(this.targetToolOptions(repository, context, 'runner')),
      ...createWorkingScenarioTools({
        list: () => repository.listWorkingScenarioFiles(),
        read: (path) => repository.readWorkingScenarioFile(path),
      }),
      createReadArtifactTool((name) => readAllowedArtifact(workspace, name, ['plan.md'])),
      createRunnerCommandTool((command, signal) =>
        this.commandRunner.run(command, {
          cwd: context.repositoryDirectory,
          runId: context.runId,
          targetCommit: context.targetCommit,
          signal,
        }),
      ),
      createRunnerEnvironmentTool(
        this.options.configuration.getRepository(),
        this.options.secretStore,
      ),
      ...createTestDataTools(
        this.options.testData ?? createTestDataManager(),
        context.runId,
        evidenceStore,
      ),
      ...(progress?.tools ?? []),
      ...(evidenceStore ? createRunnerEvidenceTools(evidenceStore) : []),
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
      'runner-execution',
      'runner',
      this.options.configuration.getHarness().agents.runner,
      context.repositoryDirectory,
      tools,
      runnerUserMessage(context, purpose),
      runnerOutputContract(),
      false,
      context.browserRequired && this.options.browser?.isEnabled()
        ? [this.options.browser.extension(workspace.evidenceDirectory)]
        : [],
    );
    const progressError = progress?.completionError();
    if (progressError) {
      throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', progressError);
    }
    await assertArtifact(workspace, 'execution.md');
    await assertArtifact(workspace, 'draft-report.md');
  }

  private async progressScenarios(
    workspace: RunWorkspace,
    repository: GitRepository,
    purpose: 'standard' | 'initialization-validation',
  ): Promise<ProgressScenario[]> {
    const plan = await workspace.read('plan.md');
    const scenarios: ProgressScenario[] = [];
    for (const path of await repository.listWorkingScenarioFiles()) {
      const parsed = parseScenarioMarkdown(await repository.readWorkingScenarioFile(path), path);
      if (parsed.status === 'deprecated') continue;
      if (purpose === 'standard' && !containsScenarioId(plan, parsed.id)) continue;
      scenarios.push({ id: parsed.id, name: parsed.name });
    }
    return scenarios.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async assessBrowserRequirements(
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<void> {
    const plan = await workspace.read('plan.md');
    context.browserRequired = browserScenarioRequested(plan);
    if (!context.browserRequired) return;

    const browser = this.options.browser;
    if (!browser?.isEnabled()) {
      this.addBlockingReason(context, '计划包含 UI 场景，但 Playwright MCP 未启用');
    }
    const baseUrl = this.options.configuration.getRepository().baseUrl.trim();
    if (baseUrl === '') {
      this.addBlockingReason(context, '计划包含 UI 场景，但测试环境基础 URL 未配置');
    } else if (!isValidTestEnvironmentUrl(baseUrl)) {
      this.addBlockingReason(context, '计划包含 UI 场景，但测试环境基础 URL 无效');
    }
    if (browser?.isEnabled()) {
      try {
        const connectivity = await browser.checkConnectivity();
        if (connectivity.status !== 'ok') {
          this.addBlockingReason(
            context,
            `Playwright MCP 连通性检查未通过：${connectivity.status}`,
          );
        }
      } catch {
        this.addBlockingReason(context, 'Playwright MCP 连通性检查失败');
      }
    }
    if (browserNeedsVision(plan)) {
      let visionAvailable = false;
      try {
        // Runner only captures and describes evidence. Visual assertions are
        // owned by the independent Reviewer, so check the Reviewer model
        // rather than requiring image input from the text-only Runner.
        const model = await this.options.provider?.resolveModel('reviewer');
        visionAvailable = model ? supportsVision(model) : false;
      } catch {
        visionAvailable = false;
      }
      if (!visionAvailable) {
        this.addBlockingReason(context, '计划需要视觉判断，但 Reviewer 模型不支持图像输入');
      }
    }
  }

  private async finishRunner(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
    evidenceStore: RunEvidenceStore | undefined,
  ): Promise<{ uploaded: boolean; uploadFailed: boolean }> {
    const notes: string[] = [];
    let files;
    let uploaded = false;
    let uploadFailed = false;
    try {
      files = await workspace.listEvidence();
    } catch (error) {
      uploadFailed = true;
      this.addBlockingReason(context, `读取 evidence 失败：${safeMessage(error)}`);
      notes.push(`读取 evidence 失败，未能上传证据：${safeMessage(error)}`);
      files = [];
    }

    if (files.length > 0) {
      if (!evidenceStore) {
        uploadFailed = true;
        this.addBlockingReason(context, 'Run 产生了证据文件，但 OSS Adapter 不可用');
        notes.push('Run 产生了证据文件，但 OSS Adapter 不可用，已保留本地 evidence。');
      } else {
        try {
          const result = await evidenceStore.uploadAll();
          const references = result.references;
          context.evidence = references;
          state.evidence = references;
          uploaded = references.length > 0;
          if (result.failures.length > 0) {
            uploadFailed = true;
            for (const failure of result.failures) {
              this.addBlockingReason(context, `证据上传失败：${failure.filename}`);
              notes.push(`证据上传失败：${failure.filename}（${failure.message}）`);
            }
          } else {
            notes.push(`已上传 ${references.length} 个 evidence 文件。`);
            notes.push(
              ...references.map((reference) => `evidence ${reference.filename}: ${reference.url}`),
            );
          }
          if (
            context.browserRequired &&
            !references.some((reference) => reference.contentType.startsWith('image/'))
          ) {
            this.addBlockingReason(context, 'UI 场景没有可供 Reviewer 查看 的截图 evidence');
            notes.push('UI 场景没有可供 Reviewer 查看 的截图 evidence。');
          }
        } catch (error) {
          uploadFailed = true;
          this.addBlockingReason(context, `证据上传失败：${safeMessage(error)}`);
          notes.push(`证据上传失败，已保留本地 evidence：${safeMessage(error)}`);
        }
      }
    }
    if (context.browserRequired && files.length > 0 && !evidenceStore) {
      this.addBlockingReason(context, 'UI 场景没有可供 Reviewer 查看 的截图 evidence');
    }
    if (context.browserRequired && files.length === 0) {
      this.addBlockingReason(context, 'UI 场景没有产生可审核的 evidence');
      notes.push('UI 场景没有产生可审核的 evidence。');
    }

    let cleanup: Awaited<ReturnType<TestDataManager['cleanup']>>;
    try {
      cleanup = await this.options.testData!.cleanup(context.runId);
    } catch {
      cleanup = {
        ok: false,
        attempted: 0,
        failed: [],
        message: '测试数据清理适配器执行失败',
        receipts: [],
      };
    }
    notes.push(`测试数据清理适配器：${cleanup.message}`);
    notes.push(
      ...cleanup.receipts.map(
        (receipt) =>
          `清理核验 receipt：${receipt.dataId} · ${receipt.sourceId} · ${receipt.queriedAt} · ${receipt.statusCode === undefined ? `exit ${receipt.exitCode ?? 'n/a'}` : `HTTP ${receipt.statusCode}`} · summary ${receipt.summary} · sha256 ${receipt.sha256}`,
      ),
    );
    if (cleanup.failed.length > 0) {
      notes.push(`测试数据清理失败项数量：${cleanup.failed.length}`);
    }
    if (context.blockingReasons.length > 0) {
      notes.push(...context.blockingReasons.map((reason) => `Harness 阻塞：${reason}`));
    }
    await this.appendExecutionNotes(workspace, notes);
    return { uploaded, uploadFailed };
  }

  private async finalizeTestData(
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<ReturnType<TestDataManager['finalize']>> {
    const result = (this.options.testData ?? createTestDataManager()).finalize(context.runId);
    const notes = [`测试数据最终核验：${result.message}`];
    if (!result.ok) {
      this.addBlockingReason(context, `测试数据清理失败：${result.message}`);
      notes.push(
        ...result.pending.map(
          (entry) =>
            `测试数据残留：${entry.id}（${entry.status}${entry.rejectionReason ? `：${entry.rejectionReason}` : ''}）`,
        ),
      );
    }
    if (context.blockingReasons.length > 0) {
      notes.push(...context.blockingReasons.map((reason) => `Harness 阻塞：${reason}`));
    }
    await this.appendExecutionNotes(workspace, notes);
    return result;
  }

  private async cleanupRetainedEvidence(
    workspace: RunWorkspace,
    context: RunContext,
    evidenceStore: RunEvidenceStore | undefined,
  ): Promise<void> {
    if (!evidenceStore || this.options.configuration.getHarness().local.retentionDays !== 0) {
      return;
    }
    try {
      await evidenceStore.cleanupLocal();
      await this.appendExecutionNotes(workspace, ['已按 retentionDays=0 清理本地 evidence。']);
    } catch (error) {
      this.addBlockingReason(context, `本地 evidence 清理失败：${safeMessage(error)}`);
      await this.appendExecutionNotes(workspace, [
        `本地 evidence 清理失败，保留本地文件：${safeMessage(error)}`,
      ]);
    }
  }

  private async appendExecutionNotes(
    workspace: RunWorkspace,
    notes: readonly string[],
  ): Promise<void> {
    if (notes.length === 0) return;
    if (!(await workspace.exists('execution.md'))) return;
    const current = await workspace.read('execution.md');
    const uniqueNotes = [...new Set(notes.filter((note) => note.trim() !== ''))];
    if (uniqueNotes.length === 0) return;
    const appendix = `\n\n## Harness 收尾记录\n\n${uniqueNotes
      .map((note) => `- ${note}`)
      .join('\n')}\n`;
    await workspace.writer('runner').writeExecution(`${current.trimEnd()}${appendix}`);
  }

  private addBlockingReason(context: RunContext, reason: string): void {
    const normalized = reason.trim();
    if (normalized !== '' && !context.blockingReasons.includes(normalized)) {
      context.blockingReasons.push(normalized);
    }
  }

  private async runReviewer(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
    evidenceStore: RunEvidenceStore | undefined,
  ): Promise<void> {
    this.setPhase(state, 'reviewer', 'Reviewer 正在独立审核执行结果');
    const tools = [
      createReadArtifactTool((name) =>
        readAllowedArtifact(workspace, name, [
          'plan.md',
          'execution.md',
          'draft-report.md',
          'scenario-changes.patch',
        ]),
      ),
      ...(evidenceStore ? createReviewerEvidenceTools(evidenceStore) : []),
      ...createReviewerTestDataTools(
        this.options.testData ?? createTestDataManager(),
        context.runId,
        evidenceStore,
      ),
      createArtifactWriterTool(
        'write_review',
        '写入独立审核',
        '写入本次 Run 的完整 review.md。必须独立核对执行证据和零场景判断。',
        (content) => workspace.writer('reviewer').writeReview(content),
      ),
    ];
    await this.invoke(
      'reviewer-audit',
      'reviewer',
      this.options.configuration.getHarness().agents.reviewer,
      context.runDirectory,
      tools,
      reviewerUserMessage(context),
      reviewerOutputContract(),
      false,
    );
    await assertArtifact(workspace, 'review.md');
  }

  private async validateScenarioPatchForReview(
    workspace: RunWorkspace,
    repository: GitRepository,
    context: RunContext,
  ): Promise<void> {
    const patch = await readOptionalScenarioPatch(workspace);
    if (patch === undefined) return;
    try {
      context.scenarioChanges = await repository.validateScenarioPatch(context.targetCommit, patch);
    } catch (error) {
      this.addBlockingReason(context, `Reviewer 前场景 patch 校验失败：${safeMessage(error)}`);
      await this.appendExecutionNotes(workspace, [
        `Reviewer 前场景 patch 校验失败：${safeMessage(error)}`,
      ]).catch(() => undefined);
    }
  }

  private async runMainB(
    state: RunState,
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<void> {
    this.setPhase(state, 'main-b', 'Main · 最终汇总正在汇总最终报告');
    context.reportFinishedAt = this.now().toISOString();
    const artifactsRead = new Set<string>();
    const issueCandidates = createIssueCandidateController(
      { runStore: this.options.runStore, repository: this.options.repository },
      () => artifactsRead.has('draft-report.md') && artifactsRead.has('review.md'),
    );
    const tools = [
      createReadArtifactTool(async (name) => {
        const content = await readAllowedArtifact(workspace, name, [
          'plan.md',
          'execution.md',
          'draft-report.md',
          'review.md',
          ...(context.initialization ? ['scenario-changes.patch' as const] : []),
        ]);
        artifactsRead.add(name);
        return content;
      }),
      issueCandidates.tool,
      createArtifactWriterTool(
        'write_report',
        '写入最终报告',
        '写入本次 Run 唯一的 report.md。必须使用指定最小 frontmatter，不得写其他文件。',
        async (content) => {
          const normalized = normalizeFinalReportFrontmatter(content);
          try {
            parseReportMarkdown(normalized, 'report.md', state.runId);
          } catch (error) {
            throw new RunOrchestratorError(
              'RUN_ARTIFACT_INVALID',
              `最终报告格式无效，请修正后重新调用 write_report：${safeMessage(error)}`,
            );
          }
          await workspace.writer('main-b').writeReport(normalized);
        },
      ),
      ...(context.initialization
        ? [
            createArtifactWriterTool(
              'write_scenario_patch',
              '修订候选场景 patch',
              '初始化最终修订只能继续写入 docs/scenario-testing/scenarios/** 范围内的标准 git unified patch；不能修改其他目录。',
              (content) => workspace.writer('main-b').writeScenarioPatch(content),
            ),
          ]
        : []),
    ];
    await this.invoke(
      'main-finalization',
      'main-b',
      this.options.configuration.getHarness().agents.main,
      context.runDirectory,
      tools,
      mainBUserMessage(context),
      mainBOutputContract(),
      context.initialization,
    );
    await assertArtifact(workspace, 'report.md');
    const reportContent = await workspace.read('report.md');
    const report = parseReportMarkdown(
      reportContent,
      `${workspace.runningDirectory}/report.md`,
      state.runId,
    );
    for (const bug of report.confirmedBugs) {
      const coverage = issueCandidates.coverageForBug(bug.key, bug.title);
      if (coverage === 'none') {
        throw new RunOrchestratorError(
          'RUN_ARTIFACT_INVALID',
          'Main · 最终汇总必须为每个 confirmed Bug 先查询对应的相似 Issue 候选',
        );
      }
      if (coverage === 'gap' && !hasIssueCoverageGap(reportContent, bug.key)) {
        throw new RunOrchestratorError(
          'RUN_ARTIFACT_INVALID',
          'Issue 候选查询 unavailable 或预算耗尽时必须在报告记录覆盖缺口',
        );
      }
    }
  }

  private async invoke(
    sessionKind: AgentSessionKind,
    role: AgentRole,
    config: AgentConfig,
    cwd: string,
    tools: ReturnType<typeof createTargetContextTools>,
    userMessage: string,
    outputContract: string,
    initialization: boolean,
    extensionFactories: InlineExtension[] = [],
  ): Promise<void> {
    let session: AgentSession | undefined;
    try {
      const instructions = await this.roleInstructions.load(sessionKind, initialization);
      const systemPrompt = buildSystemPrompt(sessionKind, instructions.content, outputContract);
      const input = buildSessionInput(
        role,
        sessionKind,
        config,
        cwd,
        tools,
        systemPrompt,
        userMessage,
        instructions.versions,
        extensionFactories,
      );
      session = await this.sessions.create(input);
      await session.prompt(input.userMessage);
    } finally {
      if (session) await session.dispose();
    }
  }

  private targetToolOptions(
    repository: GitRepository,
    context: RunContext,
    audience: 'main-planning' | 'runner',
  ) {
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
        JSON.stringify(
          audience === 'runner'
            ? runnerContext(context)
            : {
                ...mainPlanningContext(context),
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
              },
        ),
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
    context: RunContext,
  ): Promise<ParsedReport> {
    const reportContent = await workspace.read('report.md');
    assertSafeReportContent(reportContent, workspace, this.options.secretStore);
    let parsed: ParsedReport;
    try {
      parsed = parseReportMarkdown(
        reportContent,
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
    if (
      parsed.result !== expected &&
      !(
        parsed.result === 'blocked' &&
        (expected !== 'passed' || context.blockingReasons.length > 0)
      )
    ) {
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

  private async persistCompletedRun(
    state: RunState,
    report: ParsedReport,
    options: {
      specialRun: boolean;
      scenarioMode: RunContext['scenarioMode'];
      initialization: boolean;
    },
  ): Promise<void> {
    if (!this.options.runStore || !state.completedDirectory) return;
    try {
      const artifacts = await this.workspaceStore.open(state.runId, 'completed').list();
      this.options.runStore.importCompleted({
        runId: state.runId,
        trigger: report.trigger,
        request: state.request,
        baseCommit: report.baseCommit,
        targetCommit: report.targetCommit,
        includedCommits: report.includedCommits,
        result: report.result,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        completedDirectory: state.completedDirectory,
        artifacts,
        scenarioResults: report.scenarioResults,
        confirmedBugs: report.confirmedBugs,
        evidence: state.evidence,
        blockingReasons: state.blockingReasons,
        scenarioProgress: state.scenarioProgress,
        activities: state.activities,
        specialRun: options.specialRun,
        scenarioMode: options.scenarioMode,
        initialization: options.initialization,
      });
    } catch (error) {
      this.options.logger?.warn(
        { runId: state.runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'completed Run metadata was not preloaded into Run Store',
      );
    }
  }

  private async forceInfrastructureBlockedReport(
    workspace: RunWorkspace,
    context: RunContext,
  ): Promise<void> {
    if (context.blockingReasons.length === 0) return;
    const report = await workspace.read('report.md');
    const resultLine =
      /^result:\s*(?:passed|failed|blocked|['"](?:passed|failed|blocked)['"])\s*$/m;
    if (!resultLine.test(report)) {
      throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', '最终报告缺少可更新的 result 字段');
    }
    const blocked = report.replace(resultLine, 'result: blocked');
    const appendix = `\n\n## Harness 自动阻塞原因\n\n${context.blockingReasons
      .map((reason) => `- ${reason}`)
      .join('\n')}\n`;
    await workspace
      .writer('main-b')
      .writeReport(
        blocked.includes('## Harness 自动阻塞原因') ? blocked : `${blocked.trimEnd()}${appendix}`,
      );
  }

  private markExecutionFailure(state: RunState, error: unknown): void {
    if (state.status === 'completed' || state.status === 'interrupted') return;
    state.status = 'failed';
    this.setPhase(state, 'failed', 'Run 执行失败，未形成可信最终结论', 'warning');
    state.finishedAt = this.now().toISOString();
    state.errorMessage = safeMessage(error);
    state.blockingReasons = [state.errorMessage];
    this.options.logger?.error(
      {
        runId: state.runId,
        phase: state.phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'run failed',
    );
  }

  private setPhase(
    state: RunState,
    phase: RunPhase,
    message: string,
    kind: 'phase' | 'info' | 'warning' = 'phase',
  ): void {
    state.phase = phase;
    const at = this.now().toISOString();
    state.updatedAt = at;
    state.activities = [...(state.activities ?? []), { at, message, kind }].slice(-20);
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
        evidence: [],
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
        evidence: [],
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
        evidence: [],
      };
    }
  }
}

type ScenarioPatchDecision = 'none' | 'applied' | 'review';

async function readOptionalScenarioPatch(workspace: RunWorkspace): Promise<string | undefined> {
  if (!(await workspace.exists('scenario-changes.patch'))) return undefined;
  return workspace.read('scenario-changes.patch');
}

interface ScenarioReviewClosure {
  testDataMessage: string;
  evidenceDeleted: number;
  evidenceDeleteFailures: number;
}

function buildScenarioReviewReport(
  state: RunState,
  context: RunContext,
  finishedAt: string,
  closure: ScenarioReviewClosure,
): string {
  const changes = context.scenarioChanges
    ? `变更文件：${context.scenarioChanges.changedPaths.join(', ')}`
    : '变更文件无法安全解析';
  const reasons = context.blockingReasons.map((reason) => `- ${reason}`).join('\n');
  return `---
run_id: ${state.runId}
trigger: ${state.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits:
${context.includedCommits.length > 0 ? context.includedCommits.map((commit) => `  - ${commit}`).join('\n') : ' []'}
result: blocked
started_at: ${state.startedAt}
finished_at: ${finishedAt}
scenario_results: []
confirmed_bugs: []
---

# 场景变更待审核

本次 Run 只产生了待人工审核的场景资产变更，没有等待 PR 合并，也没有把说明写入正式报告目录。

${changes}

## Harness 收尾

- 测试数据：${closure.testDataMessage}
- 执行 evidence：已删除 ${closure.evidenceDeleted} 个已上传 OSS 对象；删除失败 ${closure.evidenceDeleteFailures} 个。
- 特殊归档仅保留 scenario-changes.patch 和 report.md。

## 阻塞原因

${reasons || '- 场景变更需要人工审核'}
`;
}

function assertRunInput(input: RunInput): void {
  if (!input || typeof input.request !== 'string' || input.request.trim() === '') {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'Run 请求内容不能为空');
  }
  if (!['git', 'schedule', 'manual', 'api'].includes(input.trigger)) {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', '测试请求来源无效');
  }
  if (input.runId !== undefined && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.runId)) {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', '内部 Run ID 格式无效');
  }
  if (input.targetCommit !== undefined && input.targetCommit.trim() === '') {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'targetCommit 不能为空');
  }
  if (input.initialization !== undefined && typeof input.initialization !== 'boolean') {
    throw new RunOrchestratorError('RUN_REQUEST_INVALID', 'initialization 必须是布尔值');
  }
}

function createRunnerEnvironmentTool(
  repository: RepositoryConfig,
  secretStore: SecretStore | undefined,
): ToolDefinition {
  return {
    name: 'get_test_environment',
    label: '读取测试环境',
    description:
      '读取当前配置的非生产测试环境地址、说明和本次测试账号。只允许 Runner 使用；不要把密码写入日志、Markdown 或命令输出。',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const username = secretStore?.get('testUsername');
        const password = secretStore?.get('testPassword');
        return createTextResult(
          JSON.stringify({
            baseUrl: repository.baseUrl,
            environmentDescription: repository.environmentDescription,
            username: username ?? null,
            password: password ?? null,
          }),
        );
      } catch {
        return createTextResult('测试环境 Secret 当前不可读取', { error: true });
      }
    },
  };
}

function assertSafeReportContent(
  content: string,
  workspace: RunWorkspace,
  secretStore: SecretStore | undefined,
): void {
  const localPaths = [
    workspace.runningDirectory,
    workspace.completedDirectory,
    workspace.evidenceDirectory,
  ].flatMap((path) => [path, path.replaceAll('\\', '/')]);
  if (
    localPaths.some((path) => content.includes(path)) ||
    /file:\/\/[^\s)]+/i.test(content) ||
    /https?:\/\/[^\s)]+[?&](?:x-amz-|signature|expires|token|access_token)=/i.test(content)
  ) {
    throw new RunOrchestratorError(
      'RUN_ARTIFACT_INVALID',
      '最终报告包含本地证据路径或短期签名地址',
    );
  }

  const secretKeys = [
    'providerApiKey',
    'gitToken',
    'testUsername',
    'testPassword',
    'ossAccessKeyId',
    'ossAccessKeySecret',
  ] as const;
  for (const key of secretKeys) {
    let value: string | undefined;
    try {
      value = secretStore?.get(key);
    } catch {
      value = undefined;
    }
    if (value && content.includes(value)) {
      throw new RunOrchestratorError('RUN_ARTIFACT_INVALID', '最终报告包含受保护的 Secret');
    }
  }
}

function isValidTestEnvironmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isTestAssetPath(path: string): boolean {
  return TEST_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function containsScenarioId(content: string, scenarioId: string): boolean {
  const escaped = scenarioId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9-])${escaped}(?=$|[^A-Z0-9-])`, 'm').test(content);
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

function hasIssueCoverageGap(content: string, bugKey: string): boolean {
  const body = content
    .split(/^---\s*$/m)
    .slice(2)
    .join('\n---\n');
  return body.includes('## Issue 查询覆盖缺口') && body.includes(bugKey);
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
  const summary: RunSummary = {
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
  if (state.evidence && state.evidence.length > 0) {
    summary.evidence = state.evidence.map((reference) => ({ ...reference }));
  }
  if (state.scenarioMode !== undefined) summary.scenarioMode = state.scenarioMode;
  if (state.initialization !== undefined) summary.initialization = state.initialization;
  if (state.scenarioPrUrl !== undefined) summary.scenarioPrUrl = state.scenarioPrUrl;
  if (state.currentScenario !== undefined) summary.currentScenario = state.currentScenario;
  if (state.scenarioProgress !== undefined) {
    summary.scenarioProgress = { ...state.scenarioProgress };
  }
  if (state.activities !== undefined)
    summary.activities = state.activities.map((activity) => ({ ...activity }));
  if (state.blockingReasons !== undefined) summary.blockingReasons = [...state.blockingReasons];
  if (state.updatedAt !== undefined) summary.updatedAt = state.updatedAt;
  return summary;
}

function normalizeFinalReportFrontmatter(content: string): string {
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) return content;
  const candidates = [
    ...content.matchAll(/(?:^|\r?\n)(---\r?\n[\s\S]*?\r?\n---)(?=\r?\n|$)/g),
  ].filter((match) => /^run_id:\s*\S+/m.test(match[1] ?? ''));
  if (candidates.length !== 1) return content;
  const candidate = candidates[0];
  const frontmatter = candidate?.[1];
  if (!candidate || !frontmatter || candidate.index === undefined) return content;
  const prefixLength = candidate[0].length - frontmatter.length;
  const start = candidate.index + prefixLength;
  const body = `${content.slice(0, start)}${content.slice(start + frontmatter.length)}`;
  const lineEnding = frontmatter.includes('\r\n') ? '\r\n' : '\n';
  return `${frontmatter}${body.startsWith('\n') || body.startsWith('\r\n') ? '' : lineEnding}${body}`;
}

function safeMessage(error: unknown): string {
  if (
    error instanceof RunOrchestratorError ||
    error instanceof RunWorkspaceError ||
    error instanceof ScenarioPatchError ||
    error instanceof RoleInstructionError
  )
    return error.message;
  return 'Run 执行失败，未生成可信最终结论';
}

const SESSION_IDENTITIES: Record<AgentSessionKind, string> = {
  'main-planning': '你是 LuoWang 的 Main · 规划。你负责理解变化、维护或选择长期场景并形成计划。',
  'runner-execution': '你是 LuoWang 的 Runner。你负责在固定 target 上执行计划并收集证据。',
  'reviewer-audit': '你是 LuoWang 的 Reviewer。你负责在独立上下文中审核本次执行和证据。',
  'main-finalization': '你是 LuoWang 的 Main · 最终汇总。你负责根据落盘工件和审核形成最终报告。',
};

function buildSystemPrompt(
  kind: AgentSessionKind,
  roleInstructions: string,
  outputContract: string,
): string {
  return `${SESSION_IDENTITIES[kind]}

## Built-in Role Instructions

${roleInstructions}

## 本 Session 输出契约

${outputContract}`;
}

function mainAUserMessage(context: RunContext): string {
  const task = context.initialization
    ? '完成陌生项目初始化的 Preflight 与静态勘察，列出主要用户、入口、核心能力、证据依据、低风险运行时侦察计划和覆盖缺口。'
    : '理解累计变化、需求、代码和历史结果，选择已有场景或维护必要的长期场景。';
  return `当前任务：${task}

动态 Run 上下文：
${JSON.stringify(mainPlanningContext(context), null, 2)}`;
}

function mainAOutputContract(context: RunContext): string {
  const patchInstruction = context.initialization
    ? '本阶段只写 plan.md，不写 scenario-changes.patch；运行时侦察后由新的 Main · 规划 Session 生成候选 patch。'
    : '如需维护长期场景，只能通过 write_scenario_patch 写场景目录内的标准 git unified patch。';
  return `必须先调用 get_run_context、list_target_files，并按需调用 read_target_file/search_target_files；需要历史判断时只通过 query_run_history 查询有限、脱敏的 Run 摘要。必须在结束前通过 write_plan 写入完整 plan.md；historyIssuesAvailable=false 时在覆盖缺口中说明。plan.md 中每个实际执行场景必须写出当前工作场景的稳定 ID。
${patchInstruction}
如果确有依据判断无需测试，明确写出“无需场景测试”的理由；否则保留场景缺失、影响不明或证据不足的覆盖缺口。`;
}

function initializationCandidateUserMessage(context: RunContext): string {
  return `当前任务：在新的 Main · 规划 Session 中，综合静态证据和低风险运行时侦察，形成少量高价值候选场景；需要历史判断时只通过 query_run_history 查询有限、脱敏的 Run 摘要。

动态 Run 上下文：
${JSON.stringify(mainPlanningContext(context), null, 2)}`;
}

function initializationCandidateOutputContract(): string {
  return `先读取 plan.md、execution.md 和 draft-report.md。临时能力图只写在本次正文中；把业务结果相近的步骤合并，覆盖主要用户、入口、核心成功路径、权限/校验/持久化风险和明确外部依赖。每个 approved 场景必须有可追溯依据，不确定期望保持 draft。
候选资产只能通过 write_scenario_patch 写标准 git unified patch，且只能新增、修改或目录内 rename docs/scenario-testing/scenarios/** 的 Markdown。没有可信候选时不伪造 patch。`;
}

function runnerUserMessage(
  context: RunContext,
  purpose: 'standard' | 'initialization-reconnaissance' | 'initialization-validation',
): string {
  const task =
    purpose === 'initialization-reconnaissance'
      ? '执行陌生项目初始化的低风险运行时侦察；检查已知入口、主要导航、登录和关键状态，不创建不可逆数据。'
      : purpose === 'initialization-validation'
        ? '按候选场景顺序验证成功路径和必要拒绝路径，使用 run-id 标记并清理临时数据。'
        : '只执行 plan.md 选择的日常场景。';
  const progressInstruction =
    purpose === 'initialization-reconnaissance'
      ? '本阶段是初始化侦察，没有正式候选场景；只通过阶段活动展示进度，不调用场景进度工具伪造场景。'
      : '正式场景执行前必须调用 begin_scenario_execution 按实际顺序声明稳定场景 ID；每个场景依次调用 start_scenario 和 finish_scenario，零场景也必须显式声明空列表。';
  return `当前任务：${task}

场景进度要求：${progressInstruction}

动态 Run 上下文：
${JSON.stringify(runnerContext(context), null, 2)}`;
}

function runnerOutputContract(): string {
  return `先读取 plan.md，再按计划使用受控 target、工作场景、命令、环境、测试数据和 evidence 工具。正式场景必须通过场景进度工具按计划顺序声明、开始和完成；初始化侦察不得伪造正式场景进度。UI 场景只能使用受控的 headless、isolated Playwright MCP，优先使用 accessibility snapshot/ref；截图使用相对文件名并通过 list_evidence_files 确认存在。
测试账号只用于当前操作，绝不能写入日志、命令输出、Markdown 或证据。使用 get_test_data_prefix 标记临时数据；创建后立即登记，删除后只能提交 Harness 捕获的受控查询证据或 Playwright 截图声明，并检查待核验列表。不能自填 evidence 正文、状态码、摘要或 hash。每个场景记录实际观察、命令退出码、决定性/辅助证据、偏差和清理结果。结束前分别通过 write_execution 和 write_draft_report 写完整工件；不可用条件记录为 blocked。`;
}

function reviewerUserMessage(context: RunContext): string {
  return `当前任务：独立核对计划、原始执行证据、场景变更、场景结果、confirmed Bugs、截图事实、清理和 Harness 阻塞原因。

动态 Run 上下文：
${JSON.stringify(reviewerContext(context), null, 2)}`;
}

function reviewerOutputContract(): string {
  return `依次读取 plan.md、execution.md、draft-report.md 和存在的 scenario-changes.patch；原始证据先于 Runner 草稿。必须先调用 list_pending_test_data 获取精确 data ID 和清理声明 evidence IDs；每项清理声明再通过 read_test_data_cleanup_evidence 读取 Harness 捕获的受控文本证据，或通过 read_evidence_image 实际查看全部删除后截图，随后调用 verify_test_data_cleanup 确认或拒绝；纯 Runner 声明不构成已清理。查看截图只能使用 list_evidence_files 和 read_evidence_image，不能执行命令、读取测试账号或任意路径。
截图不可访问、上传失败、视觉能力不足、清理未确认、场景缺失或影响不明时维持 blocked。零场景只有在 Main · 规划的计划确有依据时才能确认。结束前通过 write_review 写完整 review.md，并明确是否同意最终结果。`;
}

function finalizationPromptContext(context: RunContext): Record<string, unknown> {
  return {
    runId: context.runId,
    request: context.request,
    trigger: context.trigger,
    baseCommit: context.baseCommit,
    targetCommit: context.targetCommit,
    includedCommits: context.includedCommits,
    startedAt: context.startedAt,
    finishedAt: context.reportFinishedAt,
    scenarioMode: context.scenarioMode,
    initialization: context.initialization,
    scenarioChanges: context.scenarioChanges ?? null,
    evidence: context.evidence.map(({ filename, url, contentType, sizeBytes, sha256 }) => ({
      filename,
      url,
      contentType,
      sizeBytes,
      sha256,
    })),
    blockingReasons: context.blockingReasons,
  };
}

function mainBUserMessage(context: RunContext): string {
  const task = context.initialization
    ? '汇总初始化 Run；可在 Reviewer 意见支持下用受限 writer 修订尚未发布的候选场景 patch，但修订后未重新执行必须保持 blocked。'
    : '汇总日常测试 Run，不修改场景 patch。';
  return `当前任务：${task}

动态 Run 上下文：
${JSON.stringify(finalizationPromptContext(context), null, 2)}`;
}

function mainBOutputContract(): string {
  return `必须先读取 plan.md、execution.md、draft-report.md、review.md；初始化且存在 scenario-changes.patch 时也读取它。读取草稿和审核后，必须为每个本次 confirmed Bug 按 title、keywords 或 bug_key 调用 query_issue_candidates；严格区分 ok、empty、unavailable，unavailable 最多原样重试一次。查询 unavailable、重试或预算耗尽时必须在正文写“## Issue 查询覆盖缺口”并列出对应 Bug key，不得伪装成 empty。最终 report.md frontmatter 只能包含 run_id、trigger、base_commit、target_commit、included_commits、result、started_at、finished_at、scenario_results、confirmed_bugs；started_at 和 finished_at 必须逐字使用动态 Run 上下文提供的值，其他字段值也必须与固定 Run 一致。result 优先级为 blocked > failed > passed；blockingReasons 非空时必须 blocked。
scenario_results 必须是 YAML 数组，每项只能有 id 和 result。confirmed_bugs 每项只能有 key、title、scenario_ids、issue_action，以及 link 时必需的 issue_url；failed 至少有一个 confirmed bug，issue_action 只能 create 或 link。零场景 passed 必须在计划、审核和最终报告中都有“无需场景测试”依据。
证据只写在正文并引用稳定 URL。不得复述任何测试账号字段、Secret、隐藏推理、短期签名 URL 或绝对路径。结束前通过 write_report 写完整 report.md。`;
}

function mainPlanningContext(context: RunContext) {
  return {
    runId: context.runId,
    request: context.request,
    trigger: context.trigger,
    baseCommit: context.baseCommit,
    targetCommit: context.targetCommit,
    includedCommits: context.includedCommits,
    scenarioMode: context.scenarioMode,
    initialization: context.initialization,
    historyIssuesAvailable: context.historyIssuesAvailable,
    historyIssues: context.historyIssues,
    blockingReasons: context.blockingReasons,
    scenarioChanges: context.scenarioChanges ?? null,
  };
}

function runnerContext(context: RunContext) {
  return {
    runId: context.runId,
    request: context.request,
    trigger: context.trigger,
    baseCommit: context.baseCommit,
    targetCommit: context.targetCommit,
    includedCommits: context.includedCommits,
    runDirectory: context.runDirectory,
    scenarioMode: context.scenarioMode,
    initialization: context.initialization,
    blockingReasons: context.blockingReasons,
  };
}

function reviewerContext(context: RunContext) {
  return {
    runId: context.runId,
    trigger: context.trigger,
    targetCommit: context.targetCommit,
    scenarioMode: context.scenarioMode,
    initialization: context.initialization,
    scenarioChanges: context.scenarioChanges ?? null,
    evidence: context.evidence,
    blockingReasons: context.blockingReasons,
  };
}
