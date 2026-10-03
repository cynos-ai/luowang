import { useEffect, useState } from 'react';
import type { RunTelemetry } from '../../shared/types';
import { elapsedMilliseconds, summarizeUsage } from '../../shared/run-telemetry';

export function RunTelemetryPanel({
  telemetry,
  active,
  lastActivityAt,
  fetchedAt,
  stageStartedAt,
  compact = false,
}: {
  telemetry?: RunTelemetry;
  active: boolean;
  lastActivityAt?: string | null;
  fetchedAt?: string | null;
  stageStartedAt?: string | null;
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const usage = summarizeUsage(telemetry?.sessions);
  const stages = telemetry?.stages ?? [];
  const current = stages.at(-1);
  const label =
    active || usage.status === 'partial'
      ? '已结束 Session 的部分用量'
      : usage.status === 'unknown'
        ? '用量未知'
        : '已记录 Session 用量';
  return (
    <section className="content-block" aria-label="运行时间与模型用量">
      {!compact && <h2>运行时间与模型用量</h2>}
      <p>数据刷新：{fetchedAt ?? '未知'}</p>
      <p>
        最近活动：{lastActivityAt ?? '未知'}
        {active && lastActivityAt ? `（距今 ${duration(lastActivityAt, now)}）` : ''}
      </p>
      {active && <p>没有新活动不代表已挂死；可能仍在等待模型或工具。刷新失败时以上为上次记录。</p>}
      {compact ? (
        <p>
          阶段开始：{current?.startedAt ?? stageStartedAt ?? '未知'} · 阶段耗时：
          {duration(
            current?.startedAt ?? stageStartedAt,
            current?.finishedAt ?? (active ? now : null),
          )}
        </p>
      ) : stages.length ? (
        <ul>
          {stages.map((stage, index) => (
            <li key={index}>
              {stage.phase} · 开始 {stage.startedAt} · 耗时{' '}
              {duration(
                stage.startedAt,
                stage.finishedAt ?? (active && index === stages.length - 1 ? now : null),
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>历史阶段时间未记录。</p>
      )}
      <p>
        {label} · 已结束 {telemetry ? usage.settledSessions : '未知'} / 已记录{' '}
        {telemetry ? usage.recordedSessions : '未知'} 个 Session
      </p>
      <p>
        输入 {usage.tokens?.input ?? '未知'} · 输出 {usage.tokens?.output ?? '未知'} · 缓存读取{' '}
        {usage.tokens?.cacheRead ?? '未知'} · 缓存写入 {usage.tokens?.cacheWrite ?? '未知'} · SDK
        总量 {usage.tokens?.total ?? '未知'}
      </p>
      <p>
        SDK 估价（已知部分）：
        {usage.sdkEstimatedCostUsd === null ? '未知' : `$${usage.sdkEstimatedCostUsd.toFixed(6)}`}
        ；不是 Provider 账单。
      </p>
      {!compact &&
        telemetry?.sessions.map((session) => (
          <p key={session.sessionId}>
            {session.kind} · {session.finishedAt ? '已结束' : '未结算'} · 输入{' '}
            {session.usage?.tokens.input ?? '未知'} · 输出 {session.usage?.tokens.output ?? '未知'}{' '}
            · 缓存读取 {session.usage?.tokens.cacheRead ?? '未知'} · 缓存写入{' '}
            {session.usage?.tokens.cacheWrite ?? '未知'} · 总量{' '}
            {session.usage?.tokens.total ?? '未知'} · 估价{' '}
            {session.usage?.sdkEstimatedCostUsd == null
              ? '未知'
              : `$${session.usage.sdkEstimatedCostUsd.toFixed(6)}`}
            {session.usage?.completeness === 'partial' ? '（部分记录）' : ''}
          </p>
        ))}
    </section>
  );
}

function duration(start: string | null | undefined, end: string | null | undefined): string {
  const milliseconds = elapsedMilliseconds(start, end);
  if (milliseconds === null) return '未知';
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
