import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { RunTrigger } from '../../shared/types.js';

export type TestRequestStatus =
  'queued' | 'running' | 'waiting_archive' | 'completed' | 'failed' | 'interrupted';

export interface TestRequestInput {
  request: string;
  trigger: RunTrigger;
  /** A SHA, branch, tag, or another ref resolved by the Run Orchestrator. */
  targetRef?: string | null;
  /** Backwards-compatible spelling used by the Run API. */
  targetCommit?: string | null;
}

export interface TestRequestRecord {
  queueId: number;
  requestId: string;
  trigger: RunTrigger;
  triggerSources: RunTrigger[];
  requestIds: string[];
  request: string;
  targetRef: string | null;
  status: TestRequestStatus;
  runId: string | null;
  claimedAt: string | null;
  waitingArchiveAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  archiveStatus: 'completed' | 'partial' | 'failed' | null;
  progressed: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueCompletion {
  runId?: string | null;
  archiveStatus?: 'completed' | 'partial' | 'failed' | null;
  progressed?: boolean | null;
  errorMessage?: string | null;
}

export interface TestRequestQueue {
  enqueue(input: TestRequestInput): TestRequestRecord;
  claimNext(): TestRequestRecord | null;
  markStarted(queueId: number, runId: string): TestRequestRecord;
  requeue(queueId: number): TestRequestRecord;
  markWaitingArchive(queueId: number, runId: string): TestRequestRecord;
  complete(queueId: number, completion?: QueueCompletion): TestRequestRecord;
  fail(queueId: number, message: string, status?: 'failed' | 'interrupted'): TestRequestRecord;
  get(queueId: number): TestRequestRecord | null;
  list(): TestRequestRecord[];
  listPending(): TestRequestRecord[];
  listInFlight(): TestRequestRecord[];
}

export class TestRequestQueueError extends Error {
  readonly code: 'QUEUE_REQUEST_INVALID' | 'QUEUE_NOT_FOUND' | 'QUEUE_STATE_INVALID';

  constructor(code: TestRequestQueueError['code'], message: string) {
    super(message);
    this.name = 'TestRequestQueueError';
    this.code = code;
  }
}

const MAX_REQUEST_LENGTH = 16_384;
const MAX_TARGET_REF_LENGTH = 255;
const AUTOMATIC_TRIGGERS: readonly RunTrigger[] = ['git', 'schedule'];

export function createTestRequestQueue(
  database: Database.Database,
  options: { now?: () => string; requestId?: () => string } = {},
): TestRequestQueue {
  return new SqliteTestRequestQueue(
    database,
    options.now ?? (() => new Date().toISOString()),
    options.requestId ?? randomUUID,
  );
}

/** Alias used by callers that refer to the queue as the trigger queue. */
export const createTriggerQueue = createTestRequestQueue;

class SqliteTestRequestQueue implements TestRequestQueue {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
    private readonly requestId: () => string,
  ) {}

  enqueue(input: TestRequestInput): TestRequestRecord {
    const normalized = normalizeInput(input);
    const timestamp = this.now();
    const requestId = normalizeRequestId(this.requestId());
    const transaction = this.database.transaction(() => {
      const tail = this.database
        .prepare(
          `SELECT * FROM test_request_queue
           WHERE status = 'queued'
           ORDER BY queue_id DESC
           LIMIT 1`,
        )
        .get() as QueueRow | undefined;

      if (tail && isAutomatic(tail.trigger) && isAutomatic(normalized.trigger)) {
        const sources = uniqueTriggers([
          ...parseJson<RunTrigger[]>(tail.trigger_sources_json, [tail.trigger]),
          normalized.trigger,
        ]);
        const requestIds = [
          ...parseJson<string[]>(tail.request_ids_json, [tail.request_id]),
          requestId,
        ];
        const mergedRequest = mergeRequests(tail.request, normalized.request);
        this.database
          .prepare(
            `UPDATE test_request_queue
             SET trigger = ?, request = ?, target_ref = ?,
                 trigger_sources_json = ?, request_ids_json = ?, updated_at = ?
             WHERE queue_id = ?`,
          )
          .run(
            mergeTrigger(tail.trigger as RunTrigger, normalized.trigger),
            mergedRequest,
            normalized.targetRef,
            JSON.stringify(sources),
            JSON.stringify(requestIds),
            timestamp,
            tail.queue_id,
          );
        return tail.queue_id;
      }

      const result = this.database
        .prepare(
          `INSERT INTO test_request_queue
           (request_id, trigger, request, target_ref, trigger_sources_json, request_ids_json,
            status, run_id, claimed_at, waiting_archive_at, completed_at, error_message,
            archive_status, progressed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          requestId,
          normalized.trigger,
          normalized.request,
          normalized.targetRef,
          JSON.stringify([normalized.trigger]),
          JSON.stringify([requestId]),
          timestamp,
          timestamp,
        );
      return Number(result.lastInsertRowid);
    });

    const queueId = transaction();
    const record = this.get(queueId);
    if (!record) throw new TestRequestQueueError('QUEUE_NOT_FOUND', '队列请求写入后无法读取');
    return record;
  }

  claimNext(): TestRequestRecord | null {
    const timestamp = this.now();
    const queueId = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT queue_id FROM test_request_queue
           WHERE status = 'queued'
           ORDER BY queue_id ASC
           LIMIT 1`,
        )
        .get() as { queue_id: number } | undefined;
      if (!row) return null;
      const result = this.database
        .prepare(
          `UPDATE test_request_queue
           SET status = 'running', claimed_at = ?, updated_at = ?
           WHERE queue_id = ? AND status = 'queued'`,
        )
        .run(timestamp, timestamp, row.queue_id);
      return result.changes === 1 ? row.queue_id : null;
    })();
    return queueId === null ? null : this.require(queueId);
  }

  markStarted(queueId: number, runId: string): TestRequestRecord {
    this.assertRunId(runId);
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE test_request_queue
         SET run_id = ?, updated_at = ?
         WHERE queue_id = ? AND status = 'running'`,
      )
      .run(runId, timestamp, queueId);
    if (result.changes !== 1) {
      throw new TestRequestQueueError('QUEUE_STATE_INVALID', '队列请求不在 running 状态');
    }
    return this.require(queueId);
  }

  requeue(queueId: number): TestRequestRecord {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE test_request_queue
         SET status = 'queued', claimed_at = NULL, updated_at = ?
         WHERE queue_id = ? AND status = 'running' AND run_id IS NULL`,
      )
      .run(timestamp, queueId);
    if (result.changes !== 1) {
      throw new TestRequestQueueError(
        'QUEUE_STATE_INVALID',
        '只有尚未创建 Run 的 running 请求可以重新排队',
      );
    }
    return this.require(queueId);
  }

  markWaitingArchive(queueId: number, runId: string): TestRequestRecord {
    this.assertRunId(runId);
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE test_request_queue
         SET status = 'waiting_archive', run_id = ?, waiting_archive_at = ?, updated_at = ?
         WHERE queue_id = ? AND status = 'running'`,
      )
      .run(runId, timestamp, timestamp, queueId);
    if (result.changes !== 1) {
      throw new TestRequestQueueError('QUEUE_STATE_INVALID', '队列请求不在 running 状态');
    }
    return this.require(queueId);
  }

  complete(queueId: number, completion: QueueCompletion = {}): TestRequestRecord {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE test_request_queue
         SET status = 'completed', run_id = COALESCE(?, run_id), completed_at = ?,
             error_message = ?, archive_status = ?, progressed = ?, updated_at = ?
         WHERE queue_id = ? AND status IN ('running', 'waiting_archive')`,
      )
      .run(
        completion.runId ?? null,
        timestamp,
        completion.errorMessage ?? null,
        completion.archiveStatus ?? null,
        completion.progressed === undefined || completion.progressed === null
          ? null
          : completion.progressed
            ? 1
            : 0,
        timestamp,
        queueId,
      );
    if (result.changes !== 1) {
      throw new TestRequestQueueError(
        'QUEUE_STATE_INVALID',
        '队列请求不在可完成的 running 或 waiting_archive 状态',
      );
    }
    return this.require(queueId);
  }

  fail(
    queueId: number,
    message: string,
    status: 'failed' | 'interrupted' = 'failed',
  ): TestRequestRecord {
    const normalizedMessage = normalizeErrorMessage(message);
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE test_request_queue
         SET status = ?, completed_at = ?, error_message = ?, updated_at = ?
         WHERE queue_id = ? AND status IN ('queued', 'running', 'waiting_archive')`,
      )
      .run(status, timestamp, normalizedMessage, timestamp, queueId);
    if (result.changes !== 1) {
      throw new TestRequestQueueError('QUEUE_STATE_INVALID', '队列请求已经结束，不能再次失败');
    }
    return this.require(queueId);
  }

  get(queueId: number): TestRequestRecord | null {
    const row = this.database
      .prepare('SELECT * FROM test_request_queue WHERE queue_id = ?')
      .get(queueId) as QueueRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): TestRequestRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM test_request_queue ORDER BY queue_id ASC')
        .all() as QueueRow[]
    ).map(toRecord);
  }

  listPending(): TestRequestRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM test_request_queue
         WHERE status IN ('queued', 'running', 'waiting_archive')
         ORDER BY queue_id ASC`,
        )
        .all() as QueueRow[]
    ).map(toRecord);
  }

  listInFlight(): TestRequestRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM test_request_queue
         WHERE status IN ('running', 'waiting_archive')
         ORDER BY queue_id ASC`,
        )
        .all() as QueueRow[]
    ).map(toRecord);
  }

  private require(queueId: number): TestRequestRecord {
    const record = this.get(queueId);
    if (!record) throw new TestRequestQueueError('QUEUE_NOT_FOUND', `队列请求不存在：${queueId}`);
    return record;
  }

  private assertRunId(runId: string): void {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) {
      throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', 'Run ID 格式无效');
    }
  }
}

interface QueueRow {
  queue_id: number;
  request_id: string;
  trigger: string;
  request: string;
  target_ref: string | null;
  trigger_sources_json: string;
  request_ids_json: string;
  status: TestRequestStatus;
  run_id: string | null;
  claimed_at: string | null;
  waiting_archive_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  archive_status: 'completed' | 'partial' | 'failed' | null;
  progressed: number | null;
  created_at: string;
  updated_at: string;
}

function normalizeInput(input: TestRequestInput): {
  request: string;
  trigger: RunTrigger;
  targetRef: string | null;
} {
  if (!input || typeof input.request !== 'string' || input.request.trim() === '') {
    throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', '测试请求内容不能为空');
  }
  if (input.request.length > MAX_REQUEST_LENGTH || input.request.includes('\u0000')) {
    throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', '测试请求内容过长或包含无效字符');
  }
  if (!['git', 'schedule', 'manual', 'api'].includes(input.trigger)) {
    throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', '测试请求来源无效');
  }
  if (input.targetRef !== undefined && input.targetCommit !== undefined) {
    if (
      input.targetRef !== null &&
      input.targetCommit !== null &&
      input.targetRef.trim() !== input.targetCommit.trim()
    ) {
      throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', 'targetRef 与 targetCommit 不一致');
    }
  }
  const candidate = input.targetRef ?? input.targetCommit;
  let targetRef: string | null = null;
  if (candidate !== undefined && candidate !== null) {
    targetRef = candidate.trim();
    if (
      targetRef === '' ||
      targetRef.length > MAX_TARGET_REF_LENGTH ||
      [...targetRef].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', 'target ref 格式无效');
    }
  }
  return { request: input.request.trim(), trigger: input.trigger, targetRef };
}

function normalizeRequestId(value: string): string {
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 200 || hasControlCharacters(normalized)) {
    throw new TestRequestQueueError('QUEUE_REQUEST_INVALID', '请求 ID 无效');
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function mergeRequests(existing: string, incoming: string): string {
  const values = [existing.trim(), incoming.trim()].filter(Boolean);
  const unique = [...new Set(values)];
  const merged = unique.join('\n\n--- 自动触发请求合并 ---\n\n');
  return merged.length <= MAX_REQUEST_LENGTH ? merged : merged.slice(-MAX_REQUEST_LENGTH);
}

function mergeTrigger(existing: RunTrigger, incoming: RunTrigger): RunTrigger {
  return existing === 'git' || incoming === 'git' ? 'git' : 'schedule';
}

function isAutomatic(trigger: string): trigger is 'git' | 'schedule' {
  return AUTOMATIC_TRIGGERS.includes(trigger as 'git' | 'schedule');
}

function uniqueTriggers(values: RunTrigger[]): RunTrigger[] {
  return [...new Set(values)].filter((value): value is RunTrigger =>
    ['git', 'schedule', 'manual', 'api'].includes(value),
  );
}

function toRecord(row: QueueRow): TestRequestRecord {
  return {
    queueId: row.queue_id,
    requestId: row.request_id,
    trigger: row.trigger as RunTrigger,
    triggerSources: uniqueTriggers(
      parseJson<RunTrigger[]>(row.trigger_sources_json, [row.trigger as RunTrigger]),
    ),
    requestIds: parseJson<string[]>(row.request_ids_json, [row.request_id]),
    request: row.request,
    targetRef: row.target_ref,
    status: row.status,
    runId: row.run_id,
    claimedAt: row.claimed_at,
    waitingArchiveAt: row.waiting_archive_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    archiveStatus: row.archive_status,
    progressed: row.progressed === null ? null : row.progressed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeErrorMessage(message: string): string {
  const normalized = message.trim();
  if (normalized === '') return '测试请求处理失败';
  return normalized.length <= 4_096 ? normalized : normalized.slice(0, 4_096);
}
