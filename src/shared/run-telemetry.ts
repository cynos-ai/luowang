import type { ModelUsage, SessionUsageRecord } from './types.js';

/** Sum only observed SDK values. Missing values never become zero usage. */
export function summarizeUsage(sessions: SessionUsageRecord[] | undefined) {
  const unique = [
    ...new Map((sessions ?? []).map((record) => [record.sessionId, record])).values(),
  ];
  const settled = unique.filter((record) => record.finishedAt !== null || record.settled === true);
  const known = settled.flatMap((record) => (record.usage ? [record.usage] : []));
  const tokens = known.length
    ? known.reduce<ModelUsage['tokens']>(
        (sum, usage) => ({
          input: sum.input + usage.tokens.input,
          output: sum.output + usage.tokens.output,
          cacheRead: sum.cacheRead + usage.tokens.cacheRead,
          cacheWrite: sum.cacheWrite + usage.tokens.cacheWrite,
          total: sum.total + usage.tokens.total,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      )
    : null;
  return {
    status: !known.length
      ? 'unknown'
      : unique.every(
            (record) =>
              (record.finishedAt || record.settled) &&
              record.usage &&
              record.usage.completeness !== 'partial',
          )
        ? 'complete'
        : 'partial',
    settledSessions: settled.length,
    recordedSessions: unique.length,
    tokens,
    sdkEstimatedCostUsd:
      known.length && known.every((usage) => usage.sdkEstimatedCostUsd !== null)
        ? known.reduce((sum, usage) => sum + usage.sdkEstimatedCostUsd!, 0)
        : null,
  } as const;
}

export function elapsedMilliseconds(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}
