import type Database from 'better-sqlite3';

import type {
  ConnectivityCheck,
  GitCommit,
  IndexedReport,
  OperationsArchiveView,
  OperationsCurrentResponse,
  OperationsCurrentRun,
  OperationsDashboardResponse,
  OperationsDependencyHealth,
  OperationsGitCommit,
  OperationsGitTreeResponse,
  OperationsIssueLink,
  OperationsQueueItem,
  OperationsRunDetail,
  OperationsRunSummary,
  OperationsScenario,
  OperationsScenarioReview,
  RepositoryStatusResponse,
  RunActivity,
  RunPhase,
  RunSummary,
  ScenarioRunHistory,
  ScenarioStatus,
} from '../../shared/types.js';
import type { AutomationService } from '../automation/service.js';
import type { TestRequestRecord } from '../automation/queue.js';
import type { AutomationScheduler } from '../automation/scheduler.js';
import type { RunRecoveryStore } from '../automation/recovery.js';
import type { ConfigurationStore } from '../configuration.js';
import type { DatabaseContext } from '../db/client.js';
import type { ConnectivityRegistry } from '../connectivity.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import type { RunStore, StoredRun, StoredRunIssue } from '../runs/store.js';
import { RunWorkspaceStore } from '../runs/workspace.js';

const DEFAULT_SCENARIO_BRANCH = 'scenario-testing';
const DEPENDENCY_STALE_AFTER_MS = 15 * 60 * 1_000;

export interface OperationsService {
  dashboard(): Promise<OperationsDashboardResponse>;
  gitTree(commit?: string): Promise<OperationsGitTreeResponse>;
  listScenarios(filters?: {
    status?: ScenarioStatus;
    tag?: string;
    query?: string;
  }): OperationsScenario[];
  getScenario(id: string): OperationsScenario | null;
  listRuns(): Promise<OperationsRunSummary[]>;
  getRun(runId: string): Promise<OperationsRunDetail | null>;
  current(): Promise<OperationsCurrentResponse>;
}

export interface OperationsServiceOptions {
  database: Database.Database;
  databaseContext: DatabaseContext;
  configuration: ConfigurationStore;
  connectivity: ConnectivityRegistry;
  repository: RepositoryService;
  indexer: RepositoryIndexer;
  runs: RunOrchestrator;
  runStore: RunStore;
  recoveryStore: RunRecoveryStore;
  automation: AutomationService;
  scheduler: AutomationScheduler;
  reportDir: string;
  now?: () => string;
}

export function createOperationsService(options: OperationsServiceOptions): OperationsService {
  return new DefaultOperationsService(options);
}

class DefaultOperationsService implements OperationsService {
  private readonly workspaceStore: RunWorkspaceStore;
  private readonly now: () => string;

  constructor(private readonly options: OperationsServiceOptions) {
    this.workspaceStore = new RunWorkspaceStore(options.reportDir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async dashboard(): Promise<OperationsDashboardResponse> {
    const fetchedAt = this.now();
    const repositoryConfig = this.options.configuration.getRepository();
    const repository = await this.readRepositoryStatus(repositoryConfig);
    const storedRuns = this.options.runStore.list();
    const runtimeRuns = await this.readRuntimeRuns();
    const runs = mergeRuns(runtimeRuns, storedRuns);
    const progress = this.readProgress(storedRuns);
    const latest = await this.readLatestTestable(repository, progress.lastCompletedTarget);
    const current = await this.current();
    const queue = this.options.automation.listQueue().map(toQueueItem);
    const scheduler = this.options.scheduler.status();
    const workspace = await this.readWorkspaceCounts(storedRuns);
    const pendingScenarioReviews = pendingReviews(storedRuns);
    const dependencies = this.readDependencies(repository);
    const staleReasons = [
      ...latest.staleReasons,
      ...(!repository.configured
        ? []
        : repository.availability === 'unavailable'
          ? [repository.errorMessage ?? '目标仓库暂时不可用']
          : []),
    ];
    const stale = staleReasons.length > 0;
    const recentRuns = runs.slice(0, 10);
    const lastArchiveError =
      scheduler.lastError ??
      storedRuns
        .flatMap((run) => [
          run.archiveError,
          run.scenarioError,
          ...run.issues.map((issue) => issue.errorMessage),
        ])
        .find((message): message is string => Boolean(message)) ??
      null;

    return {
      fetchedAt,
      stale,
      staleReason: staleReasons[0] ?? null,
      repository,
      branch: {
        name: repository.scenarioBranch,
        head: repository.remoteHead,
        indexedCommit: repository.indexedCommit,
        lastSyncedAt: repository.lastSyncedAt,
      },
      progress: {
        lastCompleted: progress.lastCompleted
          ? toOperationsRunSummary(progress.lastCompleted)
          : null,
        lastCompletedTarget: progress.lastCompletedTarget,
        latestTestableCommit: latest.commit,
        pendingCommits: latest.pendingCommits,
        pendingCount: latest.pendingCommits.length,
      },
      activeRun: current.current,
      queue,
      workspace,
      automation: {
        scheduler,
        lastArchiveError,
        pendingScenarioReviews,
      },
      dependencies,
      recentRuns,
    };
  }

  async gitTree(commit?: string): Promise<OperationsGitTreeResponse> {
    const status = await this.options.repository.getStatus();
    const target = commit?.trim() || status.remoteHead || status.indexedCommit;
    if (!target) {
      return {
        branch: status.scenarioBranch || DEFAULT_SCENARIO_BRANCH,
        commit: '',
        entries: [],
        stale: true,
        staleReason: status.errorMessage ?? '场景测试分支尚未创建',
      };
    }

    let entries: OperationsGitCommit[] = [];
    try {
      const git = await this.options.repository.getRepository();
      const history = await git.history(target);
      const runs = this.options.runStore.list();
      entries = history.map((entry) => annotateCommit(entry, runs));
    } catch {
      return {
        branch: status.scenarioBranch || DEFAULT_SCENARIO_BRANCH,
        commit: target,
        entries: [],
        stale: true,
        staleReason: 'Git 树暂时不可用；已保留最近索引 commit',
      };
    }
    const stale =
      status.availability !== 'available' ||
      !status.remoteHead ||
      (commit === undefined && status.indexedCommit !== null && status.indexedCommit !== target);
    return {
      branch: status.scenarioBranch || DEFAULT_SCENARIO_BRANCH,
      commit: target,
      entries,
      stale,
      staleReason: stale ? (status.errorMessage ?? 'Git 缓存尚未同步到当前 HEAD') : null,
    };
  }

  listScenarios(
    filters: { status?: ScenarioStatus; tag?: string; query?: string } = {},
  ): OperationsScenario[] {
    const query = filters.query?.trim().toLocaleLowerCase();
    const source = this.options.indexer.listScenarios({
      status: filters.status,
      tag: filters.tag,
    });
    const storedRuns = this.options.runStore.list();
    const indexedReports = this.options.indexer.listReports();
    const history = scenarioHistory(storedRuns, indexedReports);
    return source
      .filter((scenario) => {
        if (!query) return true;
        return [
          scenario.id,
          scenario.name,
          scenario.description,
          scenario.content,
          ...scenario.tags,
        ].some((value) => value.toLocaleLowerCase().includes(query));
      })
      .map((scenario) => ({
        ...scenario,
        history: history.get(scenario.id) ?? [],
        pendingPullRequests: storedRuns
          .filter(
            (run) =>
              run.scenarioStatus === 'pull_request' &&
              Boolean(run.scenarioPrUrl) &&
              run.scenarioResults.some((result) => result.id === scenario.id),
          )
          .map((run) => ({
            runId: run.runId,
            url: run.scenarioPrUrl as string,
            targetCommit: run.targetCommit,
          })),
      }));
  }

  getScenario(id: string): OperationsScenario | null {
    return this.listScenarios().find((scenario) => scenario.id === id) ?? null;
  }

  async listRuns(): Promise<OperationsRunSummary[]> {
    const [runtimeRuns, storedRuns] = await Promise.all([
      this.readRuntimeRuns(),
      Promise.resolve(this.options.runStore.list()),
    ]);
    return mergeRuns(runtimeRuns, storedRuns);
  }

  async getRun(runId: string): Promise<OperationsRunDetail | null> {
    const [runtime, stored] = await Promise.all([
      this.options.runs.get(runId),
      Promise.resolve(this.options.runStore.get(runId)),
    ]);
    if (!runtime && !stored) return null;
    const summary = mergeRun(runtime ? [runtime] : [], stored ? [stored] : [])[0];
    if (!summary) return null;
    return {
      ...summary,
      artifacts: runtime?.artifacts ?? stored?.artifacts ?? {},
    };
  }

  async current(): Promise<OperationsCurrentResponse> {
    const current = await this.options.runs.current();
    if (!current) return { current: null, fetchedAt: this.now() };
    const stored = this.options.runStore.get(current.runId);
    const summary = mergeRun([current], stored ? [stored] : [])[0] as OperationsRunSummary;
    return {
      current: toCurrentRun(summary),
      fetchedAt: this.now(),
    };
  }

  private async readRepositoryStatus(
    repositoryConfig: ReturnType<ConfigurationStore['getRepository']>,
  ): Promise<RepositoryStatusResponse> {
    try {
      return await this.options.repository.getStatus();
    } catch {
      const indexState = this.options.indexer.indexState();
      return {
        configured: repositoryConfig.repository.trim() !== '',
        availability: repositoryConfig.repository.trim() === '' ? 'not_configured' : 'unavailable',
        errorMessage: '目标仓库状态暂时不可用；已保留上一次索引事实',
        repository: repositoryConfig.repository,
        scenarioBranch: repositoryConfig.scenarioBranch || DEFAULT_SCENARIO_BRANCH,
        localReady: false,
        remoteHead: null,
        indexedCommit: indexState.commitSha,
        lastSyncedAt: indexState.syncedAt,
        indexErrors: indexState.errors,
      };
    }
  }

  private async readRuntimeRuns(): Promise<RunSummary[]> {
    try {
      return await this.options.runs.list();
    } catch {
      return [];
    }
  }

  private readProgress(storedRuns: StoredRun[]): {
    lastCompletedTarget: string | null;
    lastCompleted: StoredRun | null;
  } {
    const row = this.options.database
      .prepare('SELECT last_completed_target, run_id FROM run_store_progress WHERE id = 1')
      .get() as { last_completed_target: string | null; run_id: string | null } | undefined;
    const lastCompletedTarget =
      row?.last_completed_target ?? this.options.runStore.getLastCompletedTarget();
    const lastCompleted =
      (row?.run_id ? storedRuns.find((run) => run.runId === row.run_id) : undefined) ??
      storedRuns.find((run) => run.progressed && run.targetCommit === lastCompletedTarget) ??
      null;
    return { lastCompletedTarget, lastCompleted };
  }

  private async readLatestTestable(
    repository: RepositoryStatusResponse,
    baseCommit: string | null,
  ): Promise<{ commit: string | null; pendingCommits: string[]; staleReasons: string[] }> {
    if (!repository.remoteHead) {
      return {
        commit: repository.indexedCommit,
        pendingCommits: [],
        staleReasons: repository.configured
          ? [repository.errorMessage ?? '场景测试分支 HEAD 暂时不可用']
          : [],
      };
    }
    if (!baseCommit || baseCommit === repository.remoteHead) {
      return { commit: repository.remoteHead, pendingCommits: [], staleReasons: [] };
    }
    try {
      const git = await this.options.repository.getRepository();
      const commits = await git.commitsBetween(baseCommit, repository.remoteHead);
      const pendingCommits = commits
        .filter(({ paths }) => paths.length === 0 || paths.some(isTestablePath))
        .map(({ sha }) => sha);
      return { commit: repository.remoteHead, pendingCommits, staleReasons: [] };
    } catch {
      return {
        commit: repository.remoteHead,
        pendingCommits: [],
        staleReasons: ['无法计算上一次完成目标到当前 HEAD 的待测提交范围'],
      };
    }
  }

  private async readWorkspaceCounts(storedRuns: StoredRun[]): Promise<{
    running: number;
    completed: number;
    pendingArchive: number;
  }> {
    try {
      const [running, completed] = await Promise.all([
        this.workspaceStore.list('running'),
        this.workspaceStore.list('completed'),
      ]);
      return {
        running: running.length,
        completed: completed.length,
        pendingArchive: storedRuns.filter((run) => run.archiveStatus !== 'completed').length,
      };
    } catch {
      return {
        running: 0,
        completed: 0,
        pendingArchive: storedRuns.filter((run) => run.archiveStatus !== 'completed').length,
      };
    }
  }

  private readDependencies(repository: RepositoryStatusResponse): OperationsDependencyHealth[] {
    const checks = this.options.connectivity.list();
    const mapped = checks.map(toDependencyHealth);
    const databaseOk = this.options.databaseContext.isHealthy();
    return [
      {
        id: 'sqlite',
        label: 'SQLite',
        status: databaseOk ? 'ok' : 'degraded',
        message: databaseOk ? '数据库可读写' : '数据库健康检查失败',
        checkedAt: this.now(),
        stale: false,
      },
      {
        id: 'github',
        label: 'GitHub / 场景测试分支',
        status:
          repository.availability === 'available'
            ? 'ok'
            : repository.availability === 'not_configured'
              ? 'not_configured'
              : 'unavailable',
        message:
          repository.availability === 'available'
            ? '仓库可访问'
            : (repository.errorMessage ?? '仓库尚未完成配置'),
        checkedAt: repository.lastSyncedAt,
        stale: repository.availability !== 'available',
      },
      ...mapped,
    ];
  }
}

function mergeRuns(runtimeRuns: RunSummary[], storedRuns: StoredRun[]): OperationsRunSummary[] {
  const runtimeById = new Map(runtimeRuns.map((run) => [run.runId, run]));
  const storedById = new Map(storedRuns.map((run) => [run.runId, run]));
  const ids = new Set([...runtimeById.keys(), ...storedById.keys()]);
  return [...ids]
    .map(
      (runId) =>
        mergeRun(
          runtimeById.has(runId) ? [runtimeById.get(runId) as RunSummary] : [],
          storedById.has(runId) ? [storedById.get(runId) as StoredRun] : [],
        )[0] as OperationsRunSummary,
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function mergeRun(runtimeRuns: RunSummary[], storedRuns: StoredRun[]): OperationsRunSummary[] {
  const runtime = runtimeRuns[0];
  const stored = storedRuns[0];
  if (!runtime && !stored) return [];
  const summary: RunSummary = runtime ?? storedToSummary(stored as StoredRun);
  const scenarioResults = stored?.scenarioResults ?? [];
  const confirmedBugs = stored?.confirmedBugs ?? [];
  return [
    {
      ...summary,
      request: summary.request || stored?.request || '',
      baseCommit: summary.baseCommit ?? stored?.baseCommit ?? null,
      targetCommit: summary.targetCommit ?? stored?.targetCommit ?? null,
      includedCommits:
        summary.includedCommits.length > 0
          ? summary.includedCommits
          : (stored?.includedCommits ?? []),
      artifactNames:
        summary.artifactNames.length > 0
          ? summary.artifactNames
          : Object.keys(stored?.artifacts ?? {}),
      scenarioMode: summary.scenarioMode ?? stored?.scenarioMode,
      initialization: summary.initialization ?? stored?.initialization,
      scenarioPrUrl: summary.scenarioPrUrl ?? stored?.scenarioPrUrl,
      archive: stored ? toArchiveView(stored) : null,
      scenarioResults,
      confirmedBugs,
      issues: stored?.issues.map(toIssueLink) ?? [],
    },
  ];
}

function storedToSummary(stored: StoredRun): RunSummary {
  return {
    runId: stored.runId,
    status: 'completed',
    phase: 'completed',
    result: stored.result,
    trigger: stored.trigger,
    request: stored.request,
    baseCommit: stored.baseCommit,
    targetCommit: stored.targetCommit,
    includedCommits: stored.includedCommits,
    startedAt: stored.startedAt,
    finishedAt: stored.finishedAt,
    errorMessage: stored.archiveError,
    artifactNames: Object.keys(stored.artifacts),
    scenarioMode: stored.scenarioMode,
    initialization: stored.initialization,
    scenarioPrUrl: stored.scenarioPrUrl,
    updatedAt: stored.updatedAt,
  };
}

function toOperationsRunSummary(run: StoredRun): OperationsRunSummary {
  return mergeRun([], [run])[0] as OperationsRunSummary;
}

function toArchiveView(run: StoredRun): OperationsArchiveView {
  return {
    reportStatus: run.reportStatus,
    reportCommitSha: run.reportCommitSha,
    archiveStatus: run.archiveStatus,
    archiveError: run.archiveError,
    progressed: run.progressed,
    progressedAt: run.progressedAt,
    scenarioStatus: run.scenarioStatus,
    scenarioCommitSha: run.scenarioCommitSha,
    scenarioPrUrl: run.scenarioPrUrl,
    scenarioError: run.scenarioError,
  };
}

function toIssueLink(issue: StoredRunIssue): OperationsIssueLink {
  return {
    bugKey: issue.bugKey,
    title: issue.title,
    scenarioIds: issue.scenarioIds,
    issueAction: issue.issueAction,
    requestedIssueUrl: issue.requestedIssueUrl,
    status: issue.status,
    issueNumber: issue.issueNumber,
    issueUrl: issue.issueUrl,
    errorMessage: issue.errorMessage,
    attempts: issue.attempts,
  };
}

function annotateCommit(commit: GitCommit, runs: StoredRun[]): OperationsGitCommit {
  const includedRuns = runs
    .filter((run) => run.includedCommits.includes(commit.sha))
    .map((run) => ({ runId: run.runId, result: run.result, targetCommit: run.targetCommit }));
  const targetRuns = runs
    .filter((run) => run.targetCommit === commit.sha)
    .map((run) => ({
      runId: run.runId,
      result: run.result,
      issueUrls: run.issues
        .map((issue) => issue.issueUrl ?? issue.requestedIssueUrl)
        .filter((url): url is string => Boolean(url)),
      scenarioPrUrl: run.scenarioPrUrl,
    }));
  return { ...commit, includedRuns, targetRuns };
}

function scenarioHistory(
  storedRuns: StoredRun[],
  reports: IndexedReport[],
): Map<string, ScenarioRunHistory[]> {
  const result = new Map<string, ScenarioRunHistory[]>();
  const add = (scenarioId: string, item: ScenarioRunHistory) => {
    const values = result.get(scenarioId) ?? [];
    if (!values.some((existing) => existing.runId === item.runId)) values.push(item);
    result.set(scenarioId, values);
  };
  for (const run of storedRuns) {
    for (const scenario of run.scenarioResults) {
      add(scenario.id, {
        runId: run.runId,
        result: scenario.result,
        finishedAt: run.finishedAt,
        targetCommit: run.targetCommit,
      });
    }
  }
  for (const report of reports) {
    for (const scenario of report.scenarioResults) {
      add(scenario.id, {
        runId: report.runId,
        result: scenario.result,
        finishedAt: report.finishedAt,
        targetCommit: report.targetCommit,
      });
    }
  }
  for (const values of result.values()) {
    values.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  }
  return result;
}

function pendingReviews(runs: StoredRun[]): OperationsScenarioReview[] {
  return runs
    .filter((run) => run.scenarioStatus === 'pull_request' && run.scenarioPrUrl)
    .map((run) => ({
      runId: run.runId,
      url: run.scenarioPrUrl as string,
      targetCommit: run.targetCommit,
      result: run.result,
      createdAt: run.createdAt,
      errorMessage: run.scenarioError,
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function toQueueItem(item: TestRequestRecord): OperationsQueueItem {
  return { ...item };
}

function toCurrentRun(run: OperationsRunSummary): OperationsCurrentRun {
  const phase = run.phase;
  const role = phaseRole(phase);
  const activities = sanitizeActivities(run.activities ?? [], run.updatedAt ?? run.startedAt);
  const progress = run.scenarioProgress ?? {
    completed: run.scenarioResults.filter((item) => item.result !== 'blocked').length,
    total: run.scenarioResults.length,
  };
  return {
    run,
    role,
    stage: phaseLabel(phase),
    currentScenario: run.currentScenario ?? null,
    progress,
    activities,
    blockingReasons: run.blockingReasons ?? (run.errorMessage ? [run.errorMessage] : []),
    files: [...run.artifactNames],
    updatedAt: run.updatedAt ?? run.finishedAt ?? run.startedAt,
  };
}

function sanitizeActivities(activities: RunActivity[], fallbackAt: string): RunActivity[] {
  return activities
    .filter((activity) => activity && typeof activity.message === 'string')
    .slice(-20)
    .map((activity) => ({
      at: activity.at || fallbackAt,
      message: activity.message.slice(0, 500),
      kind: activity.kind,
    }));
}

function phaseRole(phase: RunPhase): OperationsCurrentRun['role'] {
  switch (phase) {
    case 'main-a':
      return 'main-a';
    case 'runner':
      return 'runner';
    case 'reviewer':
      return 'reviewer';
    case 'main-b':
    case 'finalizing':
      return 'main-b';
    default:
      return null;
  }
}

function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case 'preparing':
      return '准备中';
    case 'main-a':
      return 'Main · 规划：分析与选场景';
    case 'runner':
      return 'Runner：执行场景';
    case 'reviewer':
      return 'Reviewer：独立审核';
    case 'main-b':
      return 'Main · 最终汇总：汇总报告';
    case 'finalizing':
      return '最终整理';
    case 'completed':
      return '已完成';
    case 'failed':
      return '执行失败';
    case 'interrupted':
      return '已中断';
  }
}

function toDependencyHealth(check: ConnectivityCheck): OperationsDependencyHealth {
  const status = check.result.status;
  const mappedStatus: OperationsDependencyHealth['status'] =
    status === 'ok'
      ? 'ok'
      : status === 'not_configured'
        ? 'not_configured'
        : status === 'not_available'
          ? 'unavailable'
          : status === 'failed' || status === 'timeout' || status === 'unreachable'
            ? 'degraded'
            : 'unknown';
  return {
    id: check.id,
    label: check.label,
    status: mappedStatus,
    message: check.result.message,
    checkedAt: check.result.checkedAt,
    stale: isStale(check.result.checkedAt),
  };
}

function isStale(checkedAt: string | null): boolean {
  if (!checkedAt) return true;
  const timestamp = Date.parse(checkedAt);
  return Number.isNaN(timestamp) || Date.now() - timestamp > DEPENDENCY_STALE_AFTER_MS;
}

function isTestablePath(path: string): boolean {
  return !(
    path.startsWith('docs/scenario-testing/scenarios/') ||
    path.startsWith('docs/scenario-testing/reports/')
  );
}
