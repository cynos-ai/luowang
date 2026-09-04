import type { ReactNode } from 'react';

import type { HealthResponse } from '../../shared/types';

export function Shell({
  health,
  children,
}: {
  health: HealthResponse | null;
  children: ReactNode;
}) {
  const serviceStatus = health?.status === 'ok' ? 'ok' : health ? 'error' : 'loading';
  const databaseStatus = health?.database === 'ok' ? 'ok' : health ? 'error' : 'loading';
  return (
    <main className="shell">
      <header className="site-header" aria-labelledby="page-title">
        <div className="brand-block">
          <div className="eyebrow">AI SCENARIO TESTING HARNESS</div>
          <h1 id="page-title">
            罗网 <span>LuoWang</span>
          </h1>
          <p className="intro">面向可信场景测试的独立控制台。</p>
        </div>
        <section className="health-strip" aria-label="系统状态">
          <HealthItem label="服务" value="Gateway" status={serviceStatus} />
          <HealthItem label="存储" value="SQLite" status={databaseStatus} />
          {health && (
            <div className="health-meta">
              <span>v{health.version}</span>
              <small>{formatDate(health.timestamp)}</small>
            </div>
          )}
        </section>
      </header>
      {children}
    </main>
  );
}

function HealthItem({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: 'ok' | 'error' | 'loading';
}) {
  const statusLabel = status === 'ok' ? '正常' : status === 'error' ? '异常' : '检查中';
  return (
    <div className="health-item">
      <span className={`health-dot health-${status}`} aria-hidden="true" />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      <em>{statusLabel}</em>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
