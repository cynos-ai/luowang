import type { Logger } from 'pino';

import type { ConnectivityRegistry } from '../connectivity.js';

export const SHARED_DEPENDENCY_CHECK_IDS = ['provider-model', 'playwright-mcp', 'oss'] as const;

export type SharedDependencyCheckId = (typeof SHARED_DEPENDENCY_CHECK_IDS)[number];

export interface SharedDependencyMonitor {
  trigger(checkIds: readonly SharedDependencyCheckId[]): void;
  checkStale(at?: Date): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;

export function createSharedDependencyMonitor(input: {
  connectivity: ConnectivityRegistry;
  lastCheckedAt: (checkId: SharedDependencyCheckId) => string | null;
  logger?: Logger;
  intervalMs?: number;
  now?: () => Date;
}): SharedDependencyMonitor {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = input.now ?? (() => new Date());
  const pending = new Set<SharedDependencyCheckId>();
  const inFlight = new Map<SharedDependencyCheckId, Promise<void>>();
  let drainTask: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;

  function run(checkId: SharedDependencyCheckId): Promise<void> {
    const existing = inFlight.get(checkId);
    if (existing) return existing;
    const task: Promise<void> = input.connectivity
      .run(checkId)
      .then(() => undefined)
      .catch((error: unknown) => {
        input.logger?.warn(
          { checkId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'shared dependency check failed',
        );
      })
      .finally(() => inFlight.delete(checkId));
    inFlight.set(checkId, task);
    return task;
  }

  function reportBackgroundFailure(error: unknown): void {
    input.logger?.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'shared dependency refresh failed',
    );
  }

  async function drain(): Promise<void> {
    while (pending.size > 0) {
      const batch = [...pending];
      pending.clear();
      await Promise.all(
        batch.map(async (checkId) => {
          const existing = inFlight.get(checkId);
          if (existing) await existing;
          await run(checkId);
        }),
      );
    }
  }

  function scheduleDrain(): void {
    if (drainTask) return;
    drainTask = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainTask = null;
        if (pending.size > 0) scheduleDrain();
      });
  }

  async function checkStale(at: Date = now()): Promise<void> {
    const threshold = at.getTime() - intervalMs;
    const stale = SHARED_DEPENDENCY_CHECK_IDS.filter((checkId) => {
      const value = input.lastCheckedAt(checkId);
      const checkedAt = value ? Date.parse(value) : NaN;
      return !Number.isFinite(checkedAt) || checkedAt <= threshold;
    });
    await Promise.all(stale.map(run));
  }

  return {
    trigger(checkIds) {
      for (const checkId of checkIds) pending.add(checkId);
      scheduleDrain();
    },
    checkStale,
    start() {
      if (timer) return;
      void checkStale().catch(reportBackgroundFailure);
      timer = setInterval(() => void checkStale().catch(reportBackgroundFailure), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await drainTask;
      await Promise.all([...inFlight.values()]);
    },
  };
}
