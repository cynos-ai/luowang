import { strict as assert } from 'node:assert';

import { afterEach, describe, it, vi } from 'vitest';

import type { ConnectivityRegistry } from '../src/server/connectivity.js';
import { createSharedDependencyMonitor } from '../src/server/projects/shared-dependency-monitor.js';
import type { ConnectivityCheck } from '../src/shared/types.js';

describe('shared dependency monitor', () => {
  afterEach(() => vi.useRealTimers());

  it('checks only missing or expired shared dependency snapshots', async () => {
    const calls: string[] = [];
    const snapshots = new Map<string, string | null>([
      ['provider-model', '2026-10-05T00:45:00.000Z'],
      ['playwright-mcp', '2026-10-05T00:20:00.000Z'],
      ['oss', null],
    ]);
    const connectivity = registry(
      [check('provider-model', null), check('playwright-mcp', null), check('oss', null)],
      calls,
    );
    const monitor = createSharedDependencyMonitor({
      connectivity,
      intervalMs: 30 * 60_000,
      lastCheckedAt: (id) => snapshots.get(id) ?? null,
    });

    await monitor.checkStale(new Date('2026-10-05T01:00:00.000Z'));

    assert.deepEqual(calls.sort(), ['oss', 'playwright-mcp']);
  });

  it('coalesces immediate triggers and reruns after an overlapping stale check', async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connectivity = registry([check('provider-model', null)], calls, async () => blocked);
    const monitor = createSharedDependencyMonitor({
      connectivity,
      intervalMs: 30 * 60_000,
      lastCheckedAt: (id) => (id === 'provider-model' ? null : '2999-01-01T00:00:00.000Z'),
    });

    const stale = monitor.checkStale(new Date('2026-10-05T01:00:00.000Z'));
    monitor.trigger(['provider-model']);
    monitor.trigger(['provider-model']);
    await Promise.resolve();
    assert.deepEqual(calls, ['provider-model']);

    release?.();
    await stale;
    await monitor.stop();
    assert.deepEqual(calls, ['provider-model', 'provider-model']);
  });

  it('runs an initial stale refresh, repeats on the interval, and stops its timer', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const connectivity = registry([check('oss', null)], calls);
    const monitor = createSharedDependencyMonitor({
      connectivity,
      intervalMs: 1_000,
      lastCheckedAt: (id) => (id === 'oss' ? null : '2999-01-01T00:00:00.000Z'),
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(calls, ['oss']);

    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(calls, ['oss', 'oss']);
    await monitor.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    assert.deepEqual(calls, ['oss', 'oss']);
  });
});

function check(id: string, checkedAt: string | null): ConnectivityCheck {
  return {
    id,
    label: id,
    available: true,
    result: { status: checkedAt ? 'ok' : 'not_checked', message: '', checkedAt, latencyMs: null },
  };
}

function registry(
  checks: ConnectivityCheck[],
  calls: string[],
  beforeResult?: (id: string) => Promise<void>,
): ConnectivityRegistry {
  return {
    list: () => checks,
    run: async (id) => {
      calls.push(id);
      await beforeResult?.(id);
      return check(id, '2026-10-05T01:00:00.000Z');
    },
    runAll: async () => [],
  };
}
