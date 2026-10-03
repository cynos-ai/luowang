import type { OperationsQueueItem, OperationsRunDetail } from './types.js';

export interface RunDiagnostic {
  kind: 'verification-gap' | 'execution' | 'stop' | 'archive' | 'cleanup' | 'preparation';
  source: 'harness' | 'reviewer' | 'administrator' | 'historical-unknown';
  message: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export type RunDiagnosticFacts = Pick<
  OperationsRunDetail,
  | 'status'
  | 'result'
  | 'finishedAt'
  | 'updatedAt'
  | 'stopReason'
  | 'stopRequestedAt'
  | 'blockingReasons'
  | 'activities'
> & {
  errorMessage?: string | null;
  artifacts: Partial<Record<string, string>>;
  archive?: Pick<
    NonNullable<OperationsRunDetail['archive']>,
    'archiveStatus' | 'archiveError'
  > | null;
};

/** Pure presentation of owned facts; never classify model prose or infer a network cause. */
export function diagnoseRun(
  run: RunDiagnosticFacts,
  queue?: OperationsQueueItem | null,
): RunDiagnostic[] {
  const issues: RunDiagnostic[] = [];
  const add = (
    kind: RunDiagnostic['kind'],
    source: RunDiagnostic['source'],
    message: string,
    firstObservedAt: string | null,
    lastObservedAt = firstObservedAt,
  ) => issues.push({ kind, source, message, firstObservedAt, lastObservedAt });
  if (run.stopReason === 'user_requested')
    add(
      'stop',
      'administrator',
      '管理员请求停止；已发生的操作和清理事实保留。',
      run.stopRequestedAt ?? null,
      run.finishedAt,
    );
  else if (run.status === 'failed' || run.status === 'interrupted')
    add(
      'execution',
      'historical-unknown',
      run.errorMessage ?? '运行未完整结束；记录未提供具体故障原因。',
      run.finishedAt,
      run.updatedAt ?? run.finishedAt,
    );
  for (const reason of run.blockingReasons ?? [])
    add('verification-gap', 'harness', reason, null, run.finishedAt);
  if (run.result === 'blocked')
    add(
      'verification-gap',
      run.artifacts['review.md'] ? 'reviewer' : 'historical-unknown',
      '正式结论存在验证缺口；请查看逐场景结果与审核中的缺少条件。新的依赖检查不会修改本次结论。',
      run.finishedAt,
    );
  if (run.archive?.archiveStatus === 'failed' || run.archive?.archiveStatus === 'partial')
    add(
      'archive',
      'harness',
      run.archive.archiveError ?? '部分归档操作未完成，功能结论保持。',
      null,
      queue?.updatedAt ?? null,
    );
  for (const activity of run.activities ?? []) {
    if (
      activity.code === 'test_data_cleanup_failed' ||
      activity.code === 'test_data_cleanup_record_failed'
    )
      add('cleanup', 'harness', activity.message, activity.at);
  }
  return issues;
}

export function diagnosePreparation(queue: OperationsQueueItem): RunDiagnostic | null {
  if (queue.runId || !['failed', 'interrupted'].includes(queue.status)) return null;
  return {
    kind: 'preparation',
    source: queue.stopReason === 'user_requested' ? 'administrator' : 'historical-unknown',
    message:
      queue.stopReason === 'user_requested'
        ? '管理员取消请求，未开始模型测试。'
        : (queue.errorMessage ?? '准备未完成，尚无 Run 或测试结论；故障类别未知。'),
    firstObservedAt: queue.stopRequestedAt ?? queue.completedAt,
    lastObservedAt: queue.updatedAt,
  };
}
