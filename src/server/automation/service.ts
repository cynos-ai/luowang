import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { RunSummary } from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunArchiver, ArchiveResult } from '../runs/archiver.js';
import type { RunOrchestrator } from '../runs/orchestrator.js';
import type { RunStore } from '../runs/store.js';
import { createRunId, RunWorkspaceStore } from '../runs/workspace.js';
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
      await this.reconcileMergeRequestRefs();
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
      if (result) await this.finishArchive(item.queueId, item.runId, result);
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
      requestKind: 'manual-current-head',
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
        const targetCommit = await this.resolveTarget(item);
        const runInput = {
          request: item.request,
          trigger: item.trigger,
          runId: queueRunId(item),
          targetCommit,
          ...(item.initialization ? { initialization: true as const } : {}),
        };
        const run = await this.options.runs.start(runInput);
        this.options.queue.markStarted(item.queueId, run.runId);
        this.activeRunId = run.runId;
        void this.monitorRun(item.queueId, run.runId);
        return { queueId: item.queueId, run };
      } catch (error) {
        await this.failQueueItem(item.queueId, safeMessage(error));
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
        await this.failQueueItem(queueId, 'Run 完成状态无法读取');
        return;
      }
      if (detail.status === 'completed') {
        this.options.queue.markWaitingArchive(queueId, runId);
        await this.archiveQueueItem(queueId, runId);
      } else if (detail.status === 'interrupted') {
        await this.failQueueItem(
          queueId,
          detail.errorMessage ?? 'Run 因进程重启而中断',
          'interrupted',
        );
      } else {
        await this.failQueueItem(queueId, detail.errorMessage ?? 'Run 执行失败');
      }
    } catch (error) {
      try {
        await this.failQueueItem(queueId, safeMessage(error));
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
      if (item.runId) {
        const detail = await this.options.runs.get(item.runId);
        if (!item.resolvedTargetCommit && detail?.targetCommit) {
          this.options.queue.markResolved(item.queueId, detail.targetCommit);
        }
        await this.archiveQueueItem(item.queueId, item.runId);
      } else {
        await this.failQueueItem(item.queueId, '等待归档的队列请求缺少 Run ID');
      }
      return;
    }

    let runId = item.runId;
    if (!runId) {
      const reservedRunId = queueRunId(item);
      const reservedRun = await this.options.runs.get(reservedRunId);
      if (!reservedRun) {
        this.options.queue.requeue(item.queueId);
        return;
      }
      this.options.queue.markStarted(item.queueId, reservedRunId);
      runId = reservedRunId;
      item = this.options.queue.get(item.queueId) ?? item;
    }

    const detail = await this.options.runs.get(runId);
    if (!item.resolvedTargetCommit && detail?.targetCommit) {
      this.options.queue.markResolved(item.queueId, detail.targetCommit);
    }
    if (detail?.status === 'completed') {
      this.options.queue.markWaitingArchive(item.queueId, runId);
      await this.archiveQueueItem(item.queueId, runId);
    } else if (detail?.status === 'interrupted' || !detail) {
      if (detail?.status === 'interrupted') {
        this.options.recoveryStore.record(
          { ...detail, trigger: item.trigger, request: item.request },
          { interruptedAt: detail.finishedAt ?? undefined },
        );
      }
      await this.failQueueItem(
        item.queueId,
        '进程重启时 Run 尚在 running 目录，未恢复 Agent 会话',
        'interrupted',
      );
    } else if (detail.status === 'failed') {
      await this.failQueueItem(item.queueId, detail.errorMessage ?? 'Run 执行失败');
    }
  }

  private async resolveTarget(item: TestRequestRecord): Promise<string> {
    if (item.resolvedTargetCommit) {
      if (!(await this.options.repository.isPublishedTarget(item.resolvedTargetCommit))) {
        throw new AutomationServiceError(
          'AUTOMATION_REQUEST_INVALID',
          '已固定的 target 不在远端场景测试分支历史中',
        );
      }
      return item.resolvedTargetCommit;
    }

    if (item.requestKind === 'manual-merge-source') {
      let prepared = item.preparedMergeCommit;
      if (!prepared) {
        if (!item.sourceRef) {
          throw new AutomationServiceError(
            'AUTOMATION_REQUEST_INVALID',
            'merge-source 请求缺少 sourceRef',
          );
        }
        if (await this.options.repository.readMergeRequestRef(item.queueId)) {
          throw new AutomationServiceError(
            'AUTOMATION_REQUEST_INVALID',
            'internal ref 已存在但 prepared commit 尚未持久化，拒绝猜测或重做 merge',
          );
        }
        const result = await this.options.repository.prepareMergeRequest(
          item.sourceRef,
          item.queueId,
          item.initialization,
        );
        prepared = result.preparedCommit;
        this.options.queue.markPrepared(item.queueId, prepared, result.mode);
      }
      const refreshed = this.options.queue.get(item.queueId);
      const published = await this.options.repository.publishPreparedMerge(
        item.queueId,
        prepared,
        refreshed?.preparedMergeMode ?? item.preparedMergeMode,
      );
      return this.options.queue.markResolved(item.queueId, published).resolvedTargetCommit!;
    }

    const repository = await this.options.repository.getRepository();
    await repository.fetch();
    const head = await repository.remoteBranchHead(this.options.repository.getScenarioBranch());
    if (!head) {
      throw new AutomationServiceError(
        'AUTOMATION_REQUEST_INVALID',
        item.requestKind === 'automatic-head'
          ? '场景测试分支尚未创建，自动请求没有可测试批次'
          : '场景测试分支尚未创建；请通过 initialization merge-source 请求首次创建',
      );
    }
    return this.options.queue.markResolved(item.queueId, head).resolvedTargetCommit!;
  }

  private async reconcileMergeRequestRefs(): Promise<void> {
    if (
      typeof this.options.repository.getRepositoryUrl !== 'function' ||
      typeof this.options.repository.listMergeRequestRefs !== 'function' ||
      this.options.repository.getRepositoryUrl().trim() === ''
    )
      return;
    const records = new Map(this.options.queue.list().map((item) => [item.queueId, item]));
    for (const queueId of await this.options.repository.listMergeRequestRefs()) {
      const item = records.get(queueId);
      if (!item || !['queued', 'running', 'waiting_archive'].includes(item.status)) {
        await this.cleanupMergeRequestRef(queueId);
        continue;
      }
      if (!item.preparedMergeCommit || !item.preparedMergeMode) {
        await this.failQueueItem(
          queueId,
          'internal ref 已存在但 prepared commit 尚未持久化，拒绝猜测或重做 merge',
        );
      }
    }
  }

  private async failQueueItem(
    queueId: number,
    message: string,
    status: 'failed' | 'interrupted' = 'failed',
  ): Promise<void> {
    this.options.queue.fail(queueId, message, status);
    await this.cleanupTerminalRef(queueId);
  }

  private async cleanupTerminalRef(queueId: number): Promise<void> {
    const item = this.options.queue.get(queueId);
    if (!item || item.requestKind !== 'manual-merge-source') return;
    if (!['completed', 'failed', 'interrupted'].includes(item.status)) return;
    await this.cleanupMergeRequestRef(queueId);
  }

  private async cleanupMergeRequestRef(queueId: number): Promise<void> {
    try {
      await this.options.repository.cleanupMergeRequestRef(queueId);
    } catch (error) {
      this.options.logger?.warn(
        { queueId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'terminal merge request internal ref cleanup failed',
      );
    }
  }

  private async archiveQueueItem(queueId: number, runId: string): Promise<void> {
    try {
      const result = await this.options.archiver.archive(runId);
      await this.finishArchive(queueId, runId, result);
    } catch (error) {
      this.options.queue.complete(queueId, {
        runId,
        archiveStatus: 'failed',
        progressed: false,
        errorMessage: safeMessage(error),
      });
      await this.cleanupTerminalRef(queueId);
    }
  }

  private async finishArchive(
    queueId: number,
    runId: string,
    result: ArchiveResult,
  ): Promise<void> {
    this.options.queue.complete(queueId, {
      runId,
      archiveStatus: result.status,
      progressed: result.progressed,
      errorMessage: result.errorMessage,
    });
    await this.cleanupTerminalRef(queueId);
  }
}

function queueRunId(item: Pick<TestRequestRecord, 'createdAt' | 'requestId'>): string {
  const timestamp = Date.parse(item.createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new AutomationServiceError('AUTOMATION_REQUEST_INVALID', '队列请求创建时间无效');
  }
  const entropy = createHash('sha256').update(item.requestId).digest().subarray(0, 10);
  return createRunId(timestamp, entropy);
}

function safeMessage(error: unknown): string {
  if (error instanceof TestRequestQueueError) return error.message;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '自动化请求处理失败';
}
