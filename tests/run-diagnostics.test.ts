import { describe, expect, it } from 'vitest';
import { diagnoseRun, diagnosePreparation } from '../src/shared/run-diagnostics.js';
import type { OperationsRunDetail, OperationsQueueItem } from '../src/shared/types.js';

describe('Run problem presentation', () => {
  it('keeps passed, cleanup and archive separate without parsing error prose', () => {
    const run = Object.freeze({
      status: 'completed',
      result: 'passed',
      finishedAt: '2026-10-03T00:00:00Z',
      artifacts: { 'review.md': '通过' },
      blockingReasons: [],
      activities: [
        {
          at: '2026-10-03T00:01:00Z',
          code: 'test_data_cleanup_failed',
          message: 'auth timeout network',
        },
      ],
      archive: { archiveStatus: 'partial', archiveError: 'unknown auth failure' },
    }) as unknown as OperationsRunDetail;
    const issues = diagnoseRun(run);
    expect(issues.map((item) => item.kind)).toEqual(['archive', 'cleanup']);
    expect(issues.every((item) => item.source === 'harness')).toBe(true);
    expect(issues[0].firstObservedAt).toBe(null);
    expect(run.result).toBe('passed');
    expect(
      diagnoseRun({
        ...run,
        activities: [{ at: 'today', kind: 'warning', message: '清理失败 timeout' }],
        archive: null,
      }),
    ).toEqual([]);
  });
  it('attributes an explicit admin stop and never constructs a fake Run for preparation failure', () => {
    const queue = {
      runId: null,
      status: 'interrupted',
      stopReason: 'user_requested',
      stopRequestedAt: '2026-10-03T00:00:00Z',
      updatedAt: '2026-10-03T00:01:00Z',
      completedAt: null,
    } as OperationsQueueItem;
    expect(diagnosePreparation(queue)).toMatchObject({
      source: 'administrator',
      kind: 'preparation',
      firstObservedAt: queue.stopRequestedAt,
    });
    expect(diagnosePreparation({ ...queue, runId: 'existing' })).toBe(null);
    expect(diagnosePreparation({ ...queue, status: 'queued' })).toBe(null);
  });
  it('retains original blocked despite a subsequent successful check and distinguishes missing historical attribution', () => {
    const run = {
      status: 'completed',
      result: 'blocked',
      finishedAt: null,
      artifacts: {},
      activities: [],
      blockingReasons: [],
    } as unknown as OperationsRunDetail;
    expect(diagnoseRun(run)).toMatchObject([
      { kind: 'verification-gap', source: 'historical-unknown', firstObservedAt: null },
    ]);
    expect(diagnoseRun({ ...run, artifacts: { 'review.md': '缺少原会话证据' } })).toMatchObject([
      { source: 'reviewer' },
    ]);
  });
});
