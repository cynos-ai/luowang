import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunArchiver } from '../runs/archiver.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import { createRunId } from '../runs/workspace.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import { createProjectRunServices } from '../projects/run-services.js';
import type { ProjectTaskRuntime } from '../projects/task-runtime.js';
import { createProjectTaskRuntime } from '../projects/task-runtime.js';
import type { ProjectStore } from '../projects/store.js';
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
  enqueue(projectId: string, input: TestRequestInput): TestRequestRecord;
  drain(): Promise<void>;
  recover(): Promise<void>;
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
  createServices?: (task: ProjectTaskRuntime) => ProjectDispatchServices;
}): ProjectAutomationDispatcher {
  const coordinator = createProjectQueueCoordinator(options.database);
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
      }));
  const queueFor = (projectId: string) =>
    createProjectTestRequestQueue(options.database, projectId);
  const servicesFor = (item: TestRequestRecord) => {
    const task = createProjectTaskRuntime(item, options.projects, options.deployment, {
      repoRoot: options.repoRoot,
      reportRoot: options.reportRoot,
    });
    return createServices(task);
  };
  const logError = (error: unknown, message: string) =>
    options.logger?.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      message,
    );
  let drainPromise: Promise<void> | null = null;
  let recoveryPromise: Promise<void> | null = null;

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
      queue.markStarted(item.queueId, runId);
      const detail = await services.runs.wait(runId);
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
      try {
        queue.fail(item.queueId, safeMessage(error));
        if (services) await cleanupRef(item, services.repository);
      } catch (secondary) {
        logError(secondary, 'project queue failure reconciliation failed');
      }
      return null;
    }
  }

  async function drainInner(): Promise<void> {
    const archives = new Set<Promise<void>>();
    for (;;) {
      const item = coordinator.claimNext();
      if (item) {
        const pendingArchive = await processClaimed(item);
        if (pendingArchive) {
          const tracked = pendingArchive.archive.finally(() => archives.delete(tracked));
          archives.add(tracked);
        }
        continue;
      }
      if (archives.size === 0) return;
      await Promise.race(archives);
    }
  }

  async function recoverInner(): Promise<void> {
    const archives: Promise<void>[] = [];
    for (const item of createTestRequestQueue(options.database).listInFlight()) {
      if (!item.projectId) throw new Error('待恢复请求缺少项目归属');
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
    const firstDrain = drain();
    await Promise.all([firstDrain, ...archives]);
    await drain();
  }

  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    drainPromise = drainInner().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  };
  return {
    enqueue(projectId, input) {
      return queueFor(projectId).enqueue(input);
    },
    drain,
    recover() {
      if (recoveryPromise) return recoveryPromise;
      recoveryPromise = recoverInner().finally(() => {
        recoveryPromise = null;
      });
      return recoveryPromise;
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
