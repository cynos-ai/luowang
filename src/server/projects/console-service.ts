import type Database from 'better-sqlite3';

import type {
  ConsoleCheckStatus,
  ConsoleProjectReference,
  ConsoleReadinessSnapshot,
  ConsoleRunReference,
  OperationsSchedulerStatus,
  SystemCheckResponse,
  SystemDependencyStatus,
  SystemResourcesResponse,
  SystemStatusResponse,
  WorkspaceAttentionItem,
  WorkspaceProjectSummary,
  WorkspaceRecentRun,
  WorkspaceResponse,
  WorkspaceActiveRun,
} from '../../shared/types.js';
import type { ProjectAutomationDispatcher } from '../automation/project-dispatcher.js';
import { createTestRequestQueue, type TestRequestRecord } from '../automation/queue.js';
import type { ConnectivityRegistry } from '../connectivity.js';
import { createProjectRunStore, type StoredRun } from '../runs/store.js';
import type { ProjectResourceInventory } from './resource-inventory.js';
import type { ProjectRecord, ProjectStore } from './store.js';

const READINESS_CHECKS = [
  ['repository', '仓库身份'],
  ['credentials', '项目凭据'],
  ['deployment', '共享依赖'],
  ['environment', '非生产环境'],
  ['image', '执行镜像'],
] as const;

const SYSTEM_CHECKS = {
  provider: ['provider-model', '模型 Provider', 'models'],
  browser: ['playwright-mcp', '浏览器运行环境', 'browser'],
  oss: ['oss', '对象存储', 'object-storage'],
} as const;

export interface ProjectConsoleService {
  workspace(): Promise<WorkspaceResponse>;
  systemStatus(): SystemStatusResponse;
  resources(): Promise<SystemResourcesResponse>;
  runSystemCheck(checkId: keyof typeof SYSTEM_CHECKS): Promise<SystemCheckResponse>;
}

export function createProjectConsoleService(input: {
  database: Database.Database;
  projects: ProjectStore;
  dispatcher: ProjectAutomationDispatcher;
  connectivity: ConnectivityRegistry;
  schedulerStatus: () => OperationsSchedulerStatus;
  inspectResources: () => Promise<ProjectResourceInventory>;
  version: string;
  build?: string | null;
  databaseHealthy: () => boolean;
  secretStoreAvailable: () => boolean;
  now?: () => string;
}): ProjectConsoleService {
  const now = input.now ?? (() => new Date().toISOString());

  return {
    async workspace() {
      const fetchedAt = now();
      const partialErrors: WorkspaceResponse['partialErrors'] = [];
      const projects = input.projects.list();
      const projectById = new Map(projects.map((project) => [project.projectId, project]));
      let queue: TestRequestRecord[] = [];
      try {
        queue = createTestRequestQueue(input.database)
          .list()
          .filter((item) => ['queued', 'running', 'waiting_archive'].includes(item.status));
      } catch {
        partialErrors.push({
          projectId: null,
          code: 'QUEUE_READ_FAILED',
          message: '队列暂时不可读',
        });
      }
      const running = queue.filter((item) => item.status === 'running');
      const capacity = { occupied: running.length, limit: input.dispatcher.maxConcurrentProjects };
      const activeRuns: WorkspaceActiveRun[] = [];
      for (const item of running) {
        const project = item.projectId ? projectById.get(item.projectId) : null;
        if (!project) continue;
        let run = null;
        if (item.runId) {
          try {
            run = await input.dispatcher.getActiveRun(project.projectId, item.runId);
            if (!run) throw new Error('active Run unavailable');
          } catch {
            partialErrors.push({
              projectId: project.projectId,
              code: 'ACTIVE_RUN_READ_FAILED',
              message: '当前执行暂时不可读',
            });
          }
        }
        activeRuns.push({
          queueId: item.queueId,
          runId: item.runId,
          project: projectReference(project),
          status: run?.status ?? 'running',
          phase: run?.phase ?? 'preparing',
          result: run?.result ?? null,
          targetCommit: run?.targetCommit ?? item.resolvedTargetCommit,
          startedAt: run?.startedAt ?? item.claimedAt ?? item.createdAt,
          finishedAt: run?.finishedAt ?? null,
          role: run ? roleFor(run.phase) : null,
          stage: run?.phase ?? (item.runId ? '执行状态暂时不可读' : '准备目标'),
          currentScenario: run?.currentScenario ?? null,
          progress: run?.scenarioProgress ?? null,
          updatedAt: run?.updatedAt ?? item.updatedAt,
        });
      }
      const recentRuns: WorkspaceRecentRun[] = [];
      const summaries: WorkspaceProjectSummary[] = [];
      const attention: WorkspaceAttentionItem[] = [];
      for (const project of projects) {
        try {
          const runs = createProjectRunStore(input.database, project.projectId).list();
          const recent = runs[0] ?? null;
          if (recent)
            recentRuns.push({ ...runReference(recent), project: projectReference(project) });
          const index = readIndex(input.database, project.projectId);
          const readiness = readReadiness(input.database, project.projectId);
          const queued = queue.filter((item) => item.projectId === project.projectId);
          const queuePosition = queued.findIndex((item) => item.status === 'queued');
          const summary: WorkspaceProjectSummary = {
            project: projectReference(project),
            activity: activeRuns.some((item) => item.project.projectId === project.projectId)
              ? 'running'
              : queued.length > 0
                ? 'queued'
                : project.status === 'paused'
                  ? 'paused'
                  : 'idle',
            projectQueuePosition: queuePosition < 0 ? null : queuePosition + 1,
            recentRun: recent ? runReference(recent) : null,
            readiness,
            attentionCount: 0,
            indexedCommit: index.commitSha,
            lastIndexedAt: index.syncedAt,
            staleReason: index.errors > 0 ? `索引包含 ${index.errors} 个错误` : null,
            readError: null,
          };
          addProjectAttention(attention, project, readiness, recent, index);
          summary.attentionCount = attention.filter(
            (item) => item.project?.projectId === project.projectId,
          ).length;
          summaries.push(summary);
        } catch {
          partialErrors.push({
            projectId: project.projectId,
            code: 'PROJECT_SUMMARY_READ_FAILED',
            message: '项目摘要暂时不可读',
          });
          summaries.push({
            project: projectReference(project),
            activity: project.status === 'paused' ? 'paused' : 'idle',
            projectQueuePosition: null,
            recentRun: null,
            readiness: notCheckedReadiness(),
            attentionCount: 1,
            indexedCommit: null,
            lastIndexedAt: null,
            staleReason: null,
            readError: { code: 'PROJECT_SUMMARY_READ_FAILED', message: '项目摘要暂时不可读' },
          });
        }
      }
      addBackgroundAttention(input.database, attention, projectById);
      return {
        fetchedAt,
        activeRuns,
        capacity,
        queue: queue.flatMap((item) => {
          if (!item.projectId) return [];
          const project = projectById.get(item.projectId);
          if (!project || !['queued', 'running', 'waiting_archive'].includes(item.status))
            return [];
          return [
            {
              projectPosition: queue.filter(
                (other) => other.projectId === item.projectId && other.queueId <= item.queueId,
              ).length,
              waitingReason:
                item.status === 'running'
                  ? '正在执行'
                  : item.status === 'waiting_archive'
                    ? '等待归档'
                    : project.status === 'paused'
                      ? '项目已暂停'
                      : queue.some(
                            (other) =>
                              other.projectId === item.projectId &&
                              other.status === 'waiting_archive',
                          )
                        ? '本项目等待归档'
                        : queue.some(
                              (other) =>
                                other.projectId === item.projectId && other.status === 'running',
                            )
                          ? '本项目正在执行'
                          : capacity.occupied >= capacity.limit
                            ? '全局执行名额已满'
                            : '等待调度',
              queueId: item.queueId,
              requestId: item.requestId,
              project: projectReference(project),
              request: item.request,
              trigger: item.trigger,
              status: item.status as 'queued' | 'running' | 'waiting_archive',
              createdAt: item.createdAt,
            },
          ];
        }),
        projects: summaries,
        recentRuns: recentRuns
          .sort((left, right) => right.finishedAt!.localeCompare(left.finishedAt!))
          .slice(0, 10),
        attention: attention.sort((left, right) =>
          (right.occurredAt ?? '').localeCompare(left.occurredAt ?? ''),
        ),
        partialErrors,
      };
    },

    systemStatus() {
      return {
        fetchedAt: now(),
        service: { name: 'luowang', version: input.version, build: input.build ?? null },
        database: input.databaseHealthy() ? 'ok' : 'error',
        secretStore: safeSecretStoreAvailable(input.secretStoreAvailable)
          ? 'available'
          : 'unavailable',
        scheduler: input.schedulerStatus(),
        executionCapacity: {
          occupied: (
            input.database
              .prepare("SELECT count(*) AS count FROM test_request_queue WHERE status = 'running'")
              .get() as { count: number }
          ).count,
          limit: input.dispatcher.maxConcurrentProjects,
        },
        dependencies: (Object.keys(SYSTEM_CHECKS) as Array<keyof typeof SYSTEM_CHECKS>).map((id) =>
          readSystemDependency(input.database, id),
        ),
        recovery: { guideId: 'multi-project-recovery', available: true },
      };
    },

    async resources() {
      const inventory = await input.inspectResources();
      return { fetchedAt: now(), ...inventory };
    },

    async runSystemCheck(checkId) {
      const [registryId] = SYSTEM_CHECKS[checkId];
      const outcome = await input.connectivity.run(registryId);
      return { check: readSystemDependency(input.database, checkId), result: outcome.result };
    },
  };
}

function projectReference(project: ProjectRecord): ConsoleProjectReference {
  return {
    projectId: project.projectId,
    displayName: project.displayName,
    repositoryOwner: project.repositoryOwner,
    repositoryName: project.repositoryName,
    status: project.status,
  };
}

function runReference(run: StoredRun): ConsoleRunReference {
  return {
    runId: run.runId,
    status: 'completed',
    phase: 'completed',
    result: run.result,
    targetCommit: run.targetCommit,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function readIndex(database: Database.Database, projectId: string) {
  const state = database
    .prepare(`SELECT commit_sha, synced_at FROM repository_index_state WHERE project_id = ?`)
    .get(projectId) as { commit_sha: string | null; synced_at: string | null } | undefined;
  const errors = database
    .prepare('SELECT count(*) AS count FROM repository_index_errors WHERE project_id = ?')
    .get(projectId) as { count: number };
  return {
    commitSha: state?.commit_sha ?? null,
    syncedAt: state?.synced_at ?? null,
    errors: errors.count,
  };
}

function readReadiness(database: Database.Database, projectId: string): ConsoleReadinessSnapshot {
  const rows = database
    .prepare(
      `SELECT check_id, status, message, checked_at
       FROM project_connectivity_check_results WHERE project_id = ?`,
    )
    .all(projectId) as Array<{
    check_id: string;
    status: string;
    message: string;
    checked_at: string;
  }>;
  if (rows.length === 0) return notCheckedReadiness();
  const byId = new Map(rows.map((row) => [row.check_id, row]));
  const checks = READINESS_CHECKS.map(([id, label]) => {
    const row = byId.get(id);
    return {
      id,
      label,
      status: row ? readinessStatus(row.status) : ('not_checked' as const),
      message: row ? safeDiagnosticMessage(row.message) : '尚未检查',
      checkedAt: row?.checked_at ?? null,
    };
  });
  const complete = checks.every((check) => check.status !== 'not_checked');
  const ready = complete && checks.every((check) => check.status === 'ok');
  return {
    status: ready ? 'ready' : complete ? 'not_ready' : 'stale',
    checkedAt:
      rows
        .map((row) => row.checked_at)
        .sort()
        .at(-1) ?? null,
    staleReason: complete ? null : '部分运行准备结果需要重新检查',
    checks,
  };
}

function notCheckedReadiness(): ConsoleReadinessSnapshot {
  return { status: 'not_checked', checkedAt: null, staleReason: null, checks: [] };
}

function readinessStatus(status: string): ConsoleCheckStatus {
  if (status === 'ok') return 'ok';
  if (status === 'not_configured') return 'not_configured';
  if (status === 'needs_recheck') return 'degraded';
  return 'unavailable';
}

function addProjectAttention(
  items: WorkspaceAttentionItem[],
  project: ProjectRecord,
  readiness: ConsoleReadinessSnapshot,
  run: StoredRun | null,
  index: { errors: number; syncedAt: string | null },
): void {
  const reference = projectReference(project);
  if (readiness.status !== 'ready') {
    items.push({
      id: `readiness:${project.projectId}`,
      kind: 'not_ready',
      severity:
        readiness.status === 'not_ready' || readiness.status === 'error' ? 'error' : 'warning',
      title: readiness.status === 'not_checked' ? '运行准备尚未检查' : '项目未就绪',
      detail: project.displayName,
      occurredAt: readiness.checkedAt,
      project: reference,
      target: { kind: 'project-readiness', projectId: project.projectId },
    });
  }
  if (run?.result === 'blocked') {
    items.push({
      id: `blocked:${project.projectId}:${run.runId}`,
      kind: 'blocked_run',
      severity: 'warning',
      title: '测试被阻塞',
      detail: run.runId,
      occurredAt: run.finishedAt,
      project: reference,
      target: { kind: 'run', projectId: project.projectId, runId: run.runId },
    });
  }
  if (
    run?.activities.some(
      (activity) =>
        activity.code === 'test_data_cleanup_failed' ||
        activity.code === 'test_data_cleanup_record_failed',
    )
  ) {
    items.push({
      id: `cleanup:${project.projectId}:${run.runId}`,
      kind: 'cleanup_failed',
      severity: 'warning',
      title: '测试数据清理需要处理',
      detail: run.runId,
      occurredAt: run.updatedAt,
      project: reference,
      target: { kind: 'run', projectId: project.projectId, runId: run.runId },
    });
  }
  if (run && ['failed', 'partial'].includes(run.archiveStatus)) {
    items.push({
      id: `archive:${project.projectId}:${run.runId}`,
      kind: 'archive_failed',
      severity: 'error',
      title: '归档需要处理',
      detail: run.runId,
      occurredAt: run.updatedAt,
      project: reference,
      target: { kind: 'run', projectId: project.projectId, runId: run.runId },
    });
  }
  if (run?.scenarioStatus === 'pull_request' && run.scenarioPrUrl) {
    items.push({
      id: `scenario-review:${project.projectId}:${run.runId}`,
      kind: 'scenario_review',
      severity: 'warning',
      title: '场景 PR 等待审核',
      detail: run.runId,
      occurredAt: run.updatedAt,
      project: reference,
      target: { kind: 'run', projectId: project.projectId, runId: run.runId },
    });
  }
  if (index.errors > 0) {
    items.push({
      id: `index:${project.projectId}`,
      kind: 'index_error',
      severity: 'warning',
      title: '场景索引包含错误',
      detail: `${index.errors} 个文件需要处理`,
      occurredAt: index.syncedAt,
      project: reference,
      target: { kind: 'project-overview', projectId: project.projectId },
    });
  }
}

function addBackgroundAttention(
  database: Database.Database,
  items: WorkspaceAttentionItem[],
  projects: Map<string, ProjectRecord>,
): void {
  const rows = database
    .prepare(
      `SELECT project_id, updated_at FROM project_automation_state
       WHERE key IN ('scheduler.last-error', 'scheduler.index-error')`,
    )
    .all() as Array<{ project_id: string; updated_at: string }>;
  for (const row of rows) {
    const project = projects.get(row.project_id);
    if (!project) continue;
    items.push({
      id: `background:${row.project_id}:${row.updated_at}`,
      kind: 'background_error',
      severity: 'warning',
      title: '项目后台任务失败',
      detail: project.displayName,
      occurredAt: row.updated_at,
      project: projectReference(project),
      target: { kind: 'project-overview', projectId: project.projectId },
    });
  }
}

function roleFor(phase: string): 'main-a' | 'runner' | 'reviewer' | 'main-b' | null {
  return ['main-a', 'runner', 'reviewer', 'main-b'].includes(phase)
    ? (phase as 'main-a' | 'runner' | 'reviewer' | 'main-b')
    : null;
}

function readSystemDependency(
  database: Database.Database,
  id: keyof typeof SYSTEM_CHECKS,
): SystemDependencyStatus {
  const [registryId, label, settingsSection] = SYSTEM_CHECKS[id];
  const row = database
    .prepare(
      `SELECT status, message, checked_at FROM connectivity_check_results WHERE check_id = ?`,
    )
    .get(registryId) as { status: string; message: string; checked_at: string } | undefined;
  const status = row ? systemCheckStatus(row.status) : 'not_checked';
  return {
    id,
    label,
    status,
    message: row ? safeDiagnosticMessage(row.message) : '尚未检查',
    checkedAt: row?.checked_at ?? null,
    lastSucceededAt: row?.status === 'ok' ? row.checked_at : null,
    settingsSection,
  };
}

function systemCheckStatus(status: string): ConsoleCheckStatus {
  if (status === 'ok') return 'ok';
  if (status === 'not_configured') return 'not_configured';
  if (status === 'unknown') return 'unknown';
  if (status === 'not_checked') return 'not_checked';
  return 'unavailable';
}

function safeDiagnosticMessage(message: string): string {
  return message
    .slice(0, 240)
    .replace(/https?:\/\/[^\s@/]+@/gi, 'https://')
    .replace(/(?:github_pat_|gh[opsur]_|sk-)[A-Za-z0-9_-]+/gi, '[REDACTED]')
    .replace(/\/(?:home|Users)\/[^\s]+/g, '[PATH]');
}

function safeSecretStoreAvailable(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}
