import { useEffect, useState } from 'react';

import type { HealthResponse } from '../shared/types';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

async function loadHealth(): Promise<HealthResponse> {
  const response = await fetch('/health', { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Health check returned ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

function StatusPill({ status }: { status: 'ok' | 'error' | 'loading' }) {
  const label = status === 'ok' ? '正常' : status === 'error' ? '异常' : '检查中';
  return <span className={`status-pill status-${status}`}>{label}</span>;
}

export default function App() {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void loadHealth()
      .then((health) => {
        if (active) {
          setState({ kind: 'ready', health });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : '无法读取服务状态',
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const serviceStatus =
    state.kind === 'ready' && state.health.status === 'ok'
      ? 'ok'
      : state.kind === 'loading'
        ? 'loading'
        : 'error';
  const databaseStatus =
    state.kind === 'ready' && state.health.database === 'ok'
      ? 'ok'
      : state.kind === 'loading'
        ? 'loading'
        : 'error';

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">AI SCENARIO TESTING HARNESS</div>
        <h1 id="page-title">
          罗网 <span>LuoWang</span>
        </h1>
        <p className="intro">面向可信场景测试的独立控制台。</p>
      </section>

      <section className="status-grid" aria-label="系统状态">
        <article className="status-card">
          <div>
            <p className="card-label">服务状态</p>
            <h2>Gateway</h2>
          </div>
          <StatusPill status={serviceStatus} />
        </article>
        <article className="status-card">
          <div>
            <p className="card-label">数据存储</p>
            <h2>SQLite</h2>
          </div>
          <StatusPill status={databaseStatus} />
        </article>
      </section>

      <section className="detail-panel" aria-live="polite">
        {state.kind === 'loading' && <p>正在读取系统状态…</p>}
        {state.kind === 'error' && <p className="error-text">状态读取失败：{state.message}</p>}
        {state.kind === 'ready' && (
          <dl className="details">
            <div>
              <dt>版本</dt>
              <dd>{state.health.version}</dd>
            </div>
            <div>
              <dt>最近检查</dt>
              <dd>{new Date(state.health.timestamp).toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
