import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elapsedMilliseconds, summarizeUsage } from '../src/shared/run-telemetry.js';
import { RunWorkspace, createRunId } from '../src/server/runs/workspace.js';
import type { ModelUsage, SessionUsageRecord } from '../src/shared/types.js';

const usage: ModelUsage = {
  provider: 'fixture',
  model: 'fixture',
  tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, total: 20 },
  sdkEstimatedCostUsd: 0.01,
};
const record: SessionUsageRecord = {
  sessionId: 'session-a',
  kind: 'main-planning',
  startedAt: '2026-10-03T00:00:00Z',
  finishedAt: '2026-10-03T00:00:10Z',
  usage,
};

describe('Run telemetry', () => {
  it('keeps unknown and partial usage distinct, retains SDK cache totals and deduplicates identities', () => {
    expect(summarizeUsage(undefined)).toMatchObject({
      status: 'unknown',
      tokens: null,
      sdkEstimatedCostUsd: null,
    });
    expect(summarizeUsage([record, record])).toMatchObject({
      status: 'complete',
      settledSessions: 1,
      tokens: usage.tokens,
      sdkEstimatedCostUsd: 0.01,
    });
    expect(
      summarizeUsage([
        record,
        { ...record, sessionId: 'session-b', finishedAt: null, usage: null },
      ]),
    ).toMatchObject({
      status: 'partial',
      settledSessions: 1,
      recordedSessions: 2,
      tokens: usage.tokens,
    });
    expect(
      summarizeUsage([
        { ...record, usage: { ...usage, completeness: 'partial', sdkEstimatedCostUsd: null } },
      ]),
    ).toMatchObject({ status: 'partial', sdkEstimatedCostUsd: null });
    expect(summarizeUsage([{ ...record, usage: null }])).toMatchObject({
      status: 'unknown',
      settledSessions: 1,
      tokens: null,
    });
  });

  it('replaces the same Session receipt across workspace reopen without merging distinct initialization Sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-usage-'));
    const runId = createRunId();
    try {
      const workspace = new RunWorkspace(runId, root);
      await workspace.create();
      const identity = {
        sessionId: record.sessionId,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt!,
      };
      await workspace.recordAgentUsage('main-planning', usage, identity);
      const reopened = new RunWorkspace(runId, root);
      await reopened.recordAgentUsage('main-planning', usage, identity);
      await reopened.recordAgentUsage('main-planning', null, {
        ...identity,
        sessionId: 'second-main',
      });
      const saved = JSON.parse(
        await readFile(join(workspace.runningDirectory, 'agent-usage.json'), 'utf8'),
      );
      expect(saved.sessions).toHaveLength(2);
      expect(saved.totals.tokens.total).toBe(20);
      expect(await reopened.list()).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses fixed terminal endpoints and rejects missing or reversed clocks', () => {
    expect(elapsedMilliseconds(record.startedAt, record.finishedAt)).toBe(10000);
    expect(elapsedMilliseconds(record.startedAt, null)).toBe(null);
    expect(elapsedMilliseconds(record.finishedAt, record.startedAt)).toBe(null);
    expect(elapsedMilliseconds('bad', record.finishedAt)).toBe(null);
  });
});
