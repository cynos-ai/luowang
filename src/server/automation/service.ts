import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { RunSummary } from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunArchiver, ArchiveResult } from '../runs/archiver.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import type { RunStore } from '../runs/store.js';
import { RunWorkspaceStore } from '../runs/workspace.js';
import { createRunRecoveryStore, type RunRecoveryStore } from './recovery.js';
import {
  createTestRequestQueue,
  TestRequestQueueError,
  type TestRequestInput,
  type TestRequestQueue,
  type TestRequestRecord,
} from './queue.js';
import { createAutomationStateStore, type AutomationStateStore } from './state.js';

export interface AutomationSubmission {
  queue: TestRequestRecord;
  run: RunSummary | null;
}

export interface RetentionCleanupResult {
  removedRunIds: string[];
  skippedRunIds: string[];
}

export interface AutomationService {
  submitTestRequest(input: TestRequestInput): Promise<AutomationSubmission>;
  listQueue(): TestRequestRecord[];
  getQueue(queueId: number): TestRequestRecord | null;
  recover(): Promise<void>;
  drain(): Promise<void>;
  scanArchives(): Promise<ArchiveResult[]>;
  cleanupRetention(): Promise<RetentionCleanupResult>;
  rerun(runId: string, request?: string): Promise<AutomationSubmission>;
  cleanupRun(runId: string): Promise<void>;
  state(): AutomationStateStore;
}

export interface AutomationServiceOptions {
  database: Database.Database;
  configuration: ConfigurationStore;
  repository: RepositoryService;
  indexer?: RepositoryIndexer;
  runs: RunOrchestrator;
  archiver: RunArchiver;
  runStore?: RunStore;
  reportDir: string;
  queue?: TestRequestQueue;
  recoveryStore?: RunRecoveryStore;
  state?: AutomationStateStore;
  now?: () => Date;
  logger?: Logger;
}

export class AutomationServiceError extends Error {
  readonly code:
    | 'AUTOMATION_REQUEST_INVALID'
    | 'AUTOMATION_RUN_NOT_FOUND'
    | 'AUTOMATION_RUN_ACTIVE'
    | 'AUTOMATION_CLEANUP_FAILED';

  constructor(code: AutomationServiceError['code'], message: string) {
    super(message);
    this.name = 'AutomationServiceError';
    this.code = code;
  }
}

export function createAutomationService(options: AutomationServiceOptions): AutomationService {
  const now = options.now ?? (() => new Date());
  const state =
    options.state ??
    createAutomationStateStore(options.database, { now: () => now().toISOString() });
  const queue =
    options.queue ?? createTestRequestQueue(options.database, { now: () => now().toISOString() });
  const recoveryStore =
    options.recoveryStore ??
    createRunRecoveryStore(options.database, { now: () => now().toISOString() });
  return new DefaultAutomationService({ ...options, now, state, queue, recoveryStore });
}

export const createTestRequestCoordinator = createAutomationService;

class DefaultAutomationService implements AutomationService {
  private readonly workspaceStore: RunWorkspaceStore;
  private readonly now: () => Date;
  private activeQueueId: number | null = null;
  private activeRunId: string | null = null;
  private dispatching = false;
  private recovering = false;

  constructor(
    private readonly options: AutomationServiceOptions & {
      queue: TestRequestQueue;
      recoveryStore: RunRecoveryStore;
      state: AutomationStateStore;
    },
  ) {
    this.workspaceStore = new RunWorkspaceStore(options.reportDir);
    this.now = options.now ?? (() => new Date());
  }

  async submitTestRequest(input: TestRequestInput): Promise<AutomationSubmission> {
    const queued = this.options.queue.enqueue(input);
    const dispatched = await this.dispatchNext();
    const current = this.options.queue.get(queued.queueId) ?? queued;
    return {
      queue: current,
      run: dispatched?.queueId === queued.queueId ? dispatched.run : null,
    };
  }

  listQueue(): TestRequestRecord[] {
    return this.options.queue.list();
  }

  getQueue(queueId: number): TestRequestRecord | null {
    return this.options.queue.get(queueId);
  }

  async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.options.runs.recover();
      for (const item of this.options.queue.listInFlight()) {
        await this.recoverQueueItem(item);
      }
    } finally {
      this.recovering = false;
    }
    await this.dispatchNext();
  }

  async drain(): Promise<void> {
    await this.dispatchNext();
  }

  async scanArchives(): Promise<ArchiveResult[]> {
    const results = await this.options.archiver.scan();
    const byRunId = new Map(results.map((result) => [result.runId, result]));
    for (const item of this.options.queue.listInFlight()) {
      if (item.status !== 'waiting_archive' || !item.runId) continue;
      const result = byRunId.get(item.runId);
      if (result) this.finishArchive(item.queueId, item.runId, result);
      else await this.archiveQueueItem(item.queueId, item.runId);
    }
    await this.dispatchNext();
    return results;
  }

  async cleanupRetention(): Promise<RetentionCleanupResult> {
    const retentionDays = this.options.configuration.getHarness().local.retentionDays;
    const result: RetentionCleanupResult = { removedRunIds: [], skippedRunIds: [] };
    if (!this.options.runStore) return result;

    const cutoff = this.now().getTime() - retentionDays * 24 * 60 * 60 * 1_000;
    for (const run of this.options.runStore.list()) {
      if (run.archiveStatus !== 'completed') continue;
      const finishedAt = Date.parse(run.finishedAt);
      if (Number.isNaN(finishedAt) || finishedAt > cutoff) continue;
      try {
        await this.workspaceStore.remove(run.runId, 'completed');
        result.removedRunIds.push(run.runId);
      } catch (error) {
        result.skippedRunIds.push(run.runId);
        this.options.logger?.warn(
          { runId: run.runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'retention cleanup failed; completed Run was retained',
        );
      }
    }
    return result;
  }

  async rerun(runId: string, request?: string): Promise<AutomationSubmission> {
    const detail = await this.options.runs.get(runId);
    if (!detail) {
      throw new AutomationServiceError('AUTOMATION_RUN_NOT_FOUND', `Run 不存在：${runId}`);
    }
    const rerunRequest = request?.trim() || `人工重测 Run ${runId}`;
    return this.submitTestRequest({
      request: rerunRequest,
      trigger: 'manual',
      targetRef: detail.targetCommit,
    });
  }

  async cleanupRun(runId: string): Promise<void> {
    const current = await this.options.runs.current();
    if (current?.runId === runId) {
      throw new AutomationServiceError('AUTOMATION_RUN_ACTIVE', '当前 Run 正在执行，不能清理');
    }
    const knownRun = await this.options.runs.get(runId);
    let removed = false;
    for (const placement of ['running', 'completed'] as const) {
      if ((await this.workspaceStore.list(placement)).includes(runId)) {
        await this.workspaceStore.remove(runId, placement);
        removed = true;
      }
    }
    this.options.recoveryStore.remove(runId);
    if (!removed && !knownRun) {
      throw new AutomationServiceError('AUTOMATION_CLEANUP_FAILED', 'Run 目录不存在');
    }
  }

  state(): AutomationStateStore {
    return this.options.state;
  }

  private async dispatchNext(): Promise<{ queueId: number; run: RunSummary } | null> {
    if (this.activeQueueId !== null || this.dispatching || this.recovering) return null;
    this.dispatching = true;
    try {
      const current = await this.options.runs.current();
      if (current) return null;
      const item = this.options.queue.claimNext();
      if (!item) return null;

      this.activeQueueId = item.queueId;
      try {
        const run = await this.options.runs.start({
          request: item.request,
          trigger: item.trigger,
          targetCommit: item.targetRef ?? undefined,
        });
        this.options.queue.markStarted(item.queueId, run.runId);
        this.activeRunId = run.runId;
        void this.monitorRun(item.queueId, run.runId);
        return { queueId: item.queueId, run };
      } catch (error) {
        this.options.queue.fail(item.queueId, safeMessage(error));
        this.activeQueueId = null;
        this.activeRunId = null;
        Promise.resolve()
          .then(() => this.dispatchNext())
          .catch(() => undefined);
        return null;
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async monitorRun(queueId: number, runId: string): Promise<void> {
    try {
      const detail = await this.options.runs.wait(runId);
      if (!detail) {
        this.options.queue.fail(queueId, 'Run 完成状态无法读取');
        return;
      }
      if (detail.status === 'completed') {
        this.options.queue.markWaitingArchive(queueId, runId);
        await this.archiveQueueItem(queueId, runId);
      } else if (detail.status === 'interrupted') {
        this.options.queue.fail(
          queueId,
          detail.errorMessage ?? 'Run 因进程重启而中断',
          'interrupted',
        );
      } else {
        this.options.queue.fail(queueId, detail.errorMessage ?? 'Run 执行失败');
      }
    } catch (error) {
      try {
        this.options.queue.fail(queueId, safeMessage(error));
      } catch {
        // The queue may have been reconciled by the recovery or archive task.
      }
      this.options.logger?.warn(
        { queueId, runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'automation request processing failed',
      );
    } finally {
      if (this.activeQueueId === queueId) {
        this.activeQueueId = null;
        this.activeRunId = null;
      }
      await this.dispatchNext();
    }
  }

  private async recoverQueueItem(item: TestRequestRecord): Promise<void> {
    if (item.status === 'waiting_archive') {
      if (item.runId) await this.archiveQueueItem(item.queueId, item.runId);
      else this.options.queue.fail(item.queueId, '等待归档的队列请求缺少 Run ID');
      return;
    }

    if (!item.runId) {
      this.options.queue.requeue(item.queueId);
      return;
    }

    const detail = await this.options.runs.get(item.runId);
    if (detail?.status === 'completed') {
      this.options.queue.markWaitingArchive(item.queueId, item.runId);
      await this.archiveQueueItem(item.queueId, item.runId);
    } else if (detail?.status === 'interrupted' || !detail) {
      if (detail?.status === 'interrupted') {
        this.options.recoveryStore.record(
          {
            ...detail,
            trigger: item.trigger,
            request: item.request,
            targetCommit: detail.targetCommit ?? item.targetRef,
          },
          { interruptedAt: detail.finishedAt ?? undefined },
        );
      }
      this.options.queue.fail(
        item.queueId,
        '进程重启时 Run 尚在 running 目录，未恢复 Agent 会话',
        'interrupted',
      );
    } else if (detail.status === 'failed') {
      this.options.queue.fail(item.queueId, detail.errorMessage ?? 'Run 执行失败');
    }
  }

  private async archiveQueueItem(queueId: number, runId: string): Promise<void> {
    try {
      const result = await this.options.archiver.archive(runId);
      this.finishArchive(queueId, runId, result);
    } catch (error) {
      this.options.queue.complete(queueId, {
        runId,
        archiveStatus: 'failed',
        progressed: false,
        errorMessage: safeMessage(error),
      });
    }
  }

  private finishArchive(queueId: number, runId: string, result: ArchiveResult): void {
    this.options.queue.complete(queueId, {
      runId,
      archiveStatus: result.status,
      progressed: result.progressed,
      errorMessage: result.errorMessage,
    });
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof TestRequestQueueError) return error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '自动化请求处理失败';
}
