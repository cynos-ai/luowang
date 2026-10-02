import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { RunDetail, RunSummary } from '../../shared/types.js';

import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunArchiver } from '../runs/archiver.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import { createRunId } from '../runs/workspace.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import { createProjectRunServices } from '../projects/run-services.js';
import { recoverProjectDockerResources } from '../projects/docker-recovery.js';
import type { ProjectTaskRuntime } from '../projects/task-runtime.js';
import { createProjectTaskRuntime } from '../projects/task-runtime.js';
import type { ProjectStore } from '../projects/store.js';
import { awaitsCutoverActivation } from '../projects/cutover-activation.js';
import { createProjectQueueCoordinator } from './project-queue-coordinator.js';
import {
  createProjectTestRequestQueue,
  createTestRequestQueue,
  type TestRequestInput,
  type TestRequestQueue,
  type TestRequestRecord,
} from './queue.js';

export interface ProjectDispatchServices {
  repository: RepositoryService;
  runs: RunOrchestrator;
  archiver: RunArchiver;
}

export interface ProjectAutomationDispatcher {
  readonly maxConcurrentProjects: number;
  enqueue(projectId: string, input: TestRequestInput): TestRequestRecord;
  drain(): Promise<void>;
  recover(): Promise<void>;
  retryArchives(at?: Date): Promise<void>;
  currentRuns(projectId?: string): Promise<Array<{ projectId: string; run: RunSummary }>>;
  stop(): Promise<void>;
  getActiveRun(projectId: string, runId: string): Promise<RunDetail | null>;
}

export function createProjectAutomationDispatcher(options: {
  database: Database.Database;
  deployment: ConfigurationStore;
  projects: ProjectStore;
  secrets: ScopedSecretStore;
  repoRoot: string;
  reportRoot: string;
  storageRoot: string;
  logger?: Logger;
  maxConcurrentProjects?: number;
  createServices?: (task: ProjectTaskRuntime) => ProjectDispatchServices;
}): ProjectAutomationDispatcher {
  const maxConcurrentProjects = options.maxConcurrentProjects ?? 2;
  const coordinator = createProjectQueueCoordinator(options.database, maxConcurrentProjects);
  const createServices =
    options.createServices ??
    ((task: ProjectTaskRuntime) =>
      createProjectRunServices({
        database: options.database,
        task,
        secrets: options.secrets,
        repoRoot: options.repoRoot,
        reportRoot: options.reportRoot,
        storageRoot: options.storageRoot,
        logger: options.logger,
      }));
  const queueFor = (projectId: string) =>
    createProjectTestRequestQueue(options.database, projectId);
  const servicesFor = (item: TestRequestRecord, purpose: 'run' | 'archive-retry' = 'run') => {
    const task = createProjectTaskRuntime(
      item,
      options.projects,
      options.deployment,
      {
        repoRoot: options.repoRoot,
        reportRoot: options.reportRoot,
      },
      purpose,
    );
    return createServices(task);
  };
  const logError = (error: unknown, message: string) =>
    options.logger?.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      message,
    );
  let idle: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  const work = new Set<Promise<void>>();
  let pumping = false;
  let stopping = false;
  let recovering = false;
  let recoveryPromise: Promise<void> | null = null;
  let retryPromise: Promise<void> | null = null;
  const activeRuns = new Map<string, { runId: string; runs: RunOrchestrator }>();
  const deferredArchives = new Set<number>();

  async function retryArchivesInner(at: Date): Promise<void> {
    for (const item of createTestRequestQueue(options.database).list()) {
      if (item.projectId && awaitsCutoverActivation(options.database, item.projectId)) continue;
      if (deferredArchives.has(item.queueId) && item.projectId && item.runId) {
        deferredArchives.delete(item.queueId);
        if (item.status === 'waiting_archive') {
          const queue = queueFor(item.projectId);
          try {
            await archive(item, queue, servicesFor(item), item.runId);
          } catch (error) {
            queue.complete(item.queueId, {
              runId: item.runId,
              archiveStatus: 'failed',
              progressed: false,
              errorMessage: safeMessage(error),
            });
          }
          continue;
        }
      }
      if (
        item.status !== 'completed' ||
        (item.archiveStatus !== 'failed' && item.archiveStatus !== 'partial') ||
        !item.projectId ||
        !item.runId ||
        at.getTime() - Date.parse(item.updatedAt) < 60_000
      )
        continue;
      const queue = queueFor(item.projectId);
      try {
        const services = servicesFor(item, 'archive-retry');
        const result = await services.archiver.retry(item.runId);
        queue.recordArchiveRetry(item.queueId, item.runId, {
          archiveStatus: result.status,
          progressed: result.progressed,
          errorMessage: result.errorMessage,
        });
      } catch (error) {
        try {
          queue.recordArchiveRetry(item.queueId, item.runId, {
            archiveStatus: 'failed',
            progressed: false,
            errorMessage: safeMessage(error),
          });
        } catch (recordError) {
          logError(recordError, 'project archive retry status update failed');
        }
        options.logger?.warn(
          {
            projectId: item.projectId,
            runId: item.runId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'project archive retry failed',
        );
      }
    }
  }

  async function cleanupRef(item: TestRequestRecord, repository: RepositoryService) {
    if (item.requestKind !== 'manual-merge-source') return;
    try {
      await repository.cleanupMergeRequestRef(item.queueId);
    } catch (error) {
      options.logger?.warn(
        { queueId: item.queueId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'project merge request ref cleanup failed',
      );
    }
  }

  async function archive(
    item: TestRequestRecord,
    queue: TestRequestQueue,
    services: ProjectDispatchServices,
    runId: string,
  ): Promise<void> {
    try {
      const result = await services.archiver.archive(runId);
      queue.complete(item.queueId, {
        runId,
        archiveStatus: result.status,
        progressed: result.progressed,
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      queue.complete(item.queueId, {
        runId,
        archiveStatus: 'failed',
        progressed: false,
        errorMessage: safeMessage(error),
      });
    }
    await cleanupRef(item, services.repository);
  }

  async function processClaimed(
    item: TestRequestRecord,
  ): Promise<{ archive: Promise<void> } | null> {
    if (!item.projectId) throw new Error('队列请求缺少项目归属');
    const queue = queueFor(item.projectId);
    let services: ProjectDispatchServices | undefined;
    try {
      services = servicesFor(item);
      const targetCommit = await resolveTarget(item, queue, services.repository);
      const runId = queueRunId(item);
      const run = await services.runs.start({
        request: item.request,
        trigger: item.trigger,
        runId,
        targetCommit,
        ...(item.initialization ? { initialization: true } : {}),
      });
      if (run.runId !== runId) throw new Error('Run ID 与队列预留 ID 不一致');
      activeRuns.set(item.projectId, { runId, runs: services.runs });
      queue.markStarted(item.queueId, runId);
      const detail = await services.runs.wait(runId);
      activeRuns.delete(item.projectId);
      if (detail?.status === 'completed') {
        queue.markWaitingArchive(item.queueId, runId);
        return { archive: archive(item, queue, services, runId) };
      }
      queue.fail(
        item.queueId,
        detail?.errorMessage ?? 'Run 完成状态无法读取',
        detail?.status === 'interrupted' ? 'interrupted' : 'failed',
      );
      await cleanupRef(item, services.repository);
      return null;
    } catch (error) {
      activeRuns.delete(item.projectId);
      try {
        queue.fail(item.queueId, safeMessage(error));
        if (services) await cleanupRef(item, services.repository);
      } catch (secondary) {
        logError(secondary, 'project queue failure reconciliation failed');
      }
      return null;
    }
  }

  function track(operation: Promise<void>): void {
    const tracked = operation
      .catch((error: unknown) => {
        logError(error, 'project task reconciliation failed');
      })
      .finally(() => {
        work.delete(tracked);
        pump();
      });
    work.add(tracked);
  }

  function pump(): void {
    if (pumping || recovering) return;
    pumping = true;
    try {
      if (!stopping) {
        for (let item = coordinator.claimNext(); item; item = coordinator.claimNext()) {
          track(
            processClaimed(item).then(async (pending) => {
              // waiting_archive no longer consumes a slot, even if publishing is slow.
              pump();
              await pending?.archive;
            }),
          );
        }
      }
      if (work.size === 0) {
        const completed = idle;
        idle = null;
        completed?.resolve();
      }
    } catch (error) {
      const failed = idle;
      idle = null;
      failed?.reject(error);
      logError(error, 'project queue dispatch failed');
    } finally {
      pumping = false;
    }
  }

  async function recoverInner(): Promise<void> {
    if (!options.createServices) {
      const recovered = await recoverProjectDockerResources(options.database);
      options.logger?.info(recovered, 'project Docker resources recovered');
    }
    const archives: Promise<void>[] = [];
    for (const item of createTestRequestQueue(options.database).listInFlight()) {
      if (!item.projectId) throw new Error('待恢复请求缺少项目归属');
      if (
        item.status === 'waiting_archive' &&
        awaitsCutoverActivation(options.database, item.projectId)
      ) {
        deferredArchives.add(item.queueId);
        continue;
      }
      const queue = queueFor(item.projectId);
      let services: ProjectDispatchServices;
      try {
        services = servicesFor(item);
      } catch (error) {
        queue.fail(item.queueId, safeMessage(error), 'interrupted');
        continue;
      }
      try {
        if (item.status === 'waiting_archive') {
          if (item.runId) archives.push(archive(item, queue, services, item.runId));
          else queue.fail(item.queueId, '待归档请求缺少 Run ID', 'interrupted');
          continue;
        }
        await services.runs.recover();
        const runId = item.runId ?? queueRunId(item);
        const detail = await services.runs.get(runId);
        if (!detail && item.runId === null) {
          queue.requeue(item.queueId);
          continue;
        }
        if (item.runId === null) queue.markStarted(item.queueId, runId);
        if (detail?.status === 'completed') {
          queue.markWaitingArchive(item.queueId, runId);
          archives.push(archive(item, queue, services, runId));
        } else {
          queue.fail(
            item.queueId,
            detail?.errorMessage ?? '进程重启时 Run 尚未完成',
            'interrupted',
          );
          await cleanupRef(item, services.repository);
        }
      } catch (error) {
        queue.fail(item.queueId, safeMessage(error), 'interrupted');
        await cleanupRef(item, services.repository);
      }
    }
    for (const operation of archives) track(operation);
  }

  const drain = (): Promise<void> => {
    if (!idle) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      idle = { promise, resolve, reject };
    }
    const result = idle.promise;
    pump();
    return result;
  };
  return {
    maxConcurrentProjects,
    enqueue(projectId, input) {
      return queueFor(projectId).enqueue(input);
    },
    drain,
    recover() {
      if (recoveryPromise) return recoveryPromise;
      if (work.size > 0) return Promise.reject(new Error('活动任务存在，不能执行启动恢复'));
      recovering = true;
      recoveryPromise = recoverInner().then(() => {
        recovering = false;
        if (idle) pump();
      });
      return recoveryPromise;
    },
    async stop() {
      stopping = true;
      await recoveryPromise;
      await drain();
      await retryPromise;
    },
    retryArchives(at = new Date()) {
      if (retryPromise) return retryPromise;
      retryPromise = retryArchivesInner(at).finally(() => {
        retryPromise = null;
        pump();
      });
      return retryPromise;
    },
    async currentRuns(selectedProjectId) {
      const current = await Promise.all(
        [...activeRuns]
          .filter(([projectId]) => !selectedProjectId || projectId === selectedProjectId)
          .map(async ([projectId, entry]) => {
            const run = await entry.runs.current();
            return run ? { projectId, run } : null;
          }),
      );
      return current.filter(
        (item): item is { projectId: string; run: RunSummary } => item !== null,
      );
    },
    async getActiveRun(projectId, runId) {
      const current = activeRuns.get(projectId);
      if (!current || current.runId !== runId) return null;
      return current.runs.get(runId);
    },
  };
}

async function resolveTarget(
  item: TestRequestRecord,
  queue: TestRequestQueue,
  repository: RepositoryService,
): Promise<string> {
  if (item.resolvedTargetCommit) {
    if (!(await repository.isPublishedTarget(item.resolvedTargetCommit))) {
      throw new Error('已固定的 target 不在所属项目场景测试分支历史中');
    }
    return item.resolvedTargetCommit;
  }
  if (item.requestKind === 'manual-merge-source') {
    let prepared = item.preparedMergeCommit;
    if (!prepared) {
      if (!item.sourceRef) throw new Error('merge-source 请求缺少 sourceRef');
      if (await repository.readMergeRequestRef(item.queueId)) {
        throw new Error('internal ref 已存在但 prepared commit 尚未持久化');
      }
      const result = await repository.prepareMergeRequest(
        item.sourceRef,
        item.queueId,
        item.initialization,
      );
      prepared = result.preparedCommit;
      queue.markPrepared(item.queueId, prepared, result.mode);
    }
    const refreshed = queue.get(item.queueId);
    const published = await repository.publishPreparedMerge(
      item.queueId,
      prepared,
      refreshed?.preparedMergeMode ?? item.preparedMergeMode,
    );
    return queue.markResolved(item.queueId, published).resolvedTargetCommit!;
  }
  const git = await repository.getRepository();
  await git.fetch();
  const head = await git.remoteBranchHead(repository.getScenarioBranch());
  if (!head) throw new Error('所属项目场景测试分支尚未创建');
  return queue.markResolved(item.queueId, head).resolvedTargetCommit!;
}

function queueRunId(item: Pick<TestRequestRecord, 'createdAt' | 'requestId'>): string {
  const timestamp = Date.parse(item.createdAt);
  if (!Number.isFinite(timestamp)) throw new Error('队列请求创建时间无效');
  return createRunId(
    timestamp,
    createHash('sha256').update(item.requestId).digest().subarray(0, 10),
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '项目自动化请求处理失败';
}
