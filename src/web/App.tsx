import { useEffect, useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from './api';
import { Field } from './components/FormControls';
import { LoginPanel } from './components/LoginPanel';
import { Shell } from './components/Shell';
import { SettingsPage } from './settings/SettingsPage';

import type {
  AuthStatusResponse,
  ConfigResponse,
  HealthResponse,
  IndexedReport,
  IndexedScenario,
  OperationsDashboardResponse,
  OperationsCurrentResponse,
  OperationsGitCommit,
  OperationsGitTreeResponse,
  OperationsRunDetail,
  OperationsRunSummary,
  OperationsScenario,
  RepositoryHistoryResponse,
  RepositoryStatusResponse,
} from '../shared/types';

type BusyAction = 'login' | null;
type ConsoleView = 'dashboard' | 'git' | 'scenarios' | 'runs' | 'active' | 'settings';

const CONSOLE_VIEWS: Array<{ id: ConsoleView; label: string }> = [
  { id: 'dashboard', label: '总览' },
  { id: 'git', label: 'Git 树' },
  { id: 'scenarios', label: '场景' },
  { id: 'runs', label: 'Runs' },
  { id: 'active', label: '当前测试' },
  { id: 'settings', label: '配置' },
];

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loginPassword, setLoginPassword] = useState('');
  const [busy, setBusy] = useState<BusyAction>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState<ConsoleView>('dashboard');

  const loadAuthenticatedData = async () => {
    setConfig(await requestJson<ConfigResponse>('/api/config'));
  };

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      try {
        const nextHealth = await loadHealth();
        if (active) {
          setHealth(nextHealth);
        }
      } catch (cause: unknown) {
        if (active) {
          setError(toUserMessage(cause, '无法读取服务状态'));
        }
      }

      try {
        const nextAuth = await requestJson<AuthStatusResponse>('/api/auth/status');
        if (!active) {
          return;
        }
        setAuth(nextAuth);
        if (nextAuth.authenticated) {
          await loadAuthenticatedData();
        }
      } catch (cause: unknown) {
        if (active) {
          setError(toUserMessage(cause, '无法读取认证状态'));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void initialize();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuth((current) => ({ configured: current?.configured ?? true, authenticated: false }));
      setConfig(null);
      setError('登录已过期，请重新登录');
    };
    window.addEventListener('luowang:unauthorized', onUnauthorized);
    return () => window.removeEventListener('luowang:unauthorized', onUnauthorized);
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('login');
    setError('');
    setMessage('');
    try {
      await requestJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: loginPassword }),
      });
      const nextAuth = await requestJson<AuthStatusResponse>('/api/auth/status');
      setAuth(nextAuth);
      setLoginPassword('');
      await loadAuthenticatedData();
      setMessage('登录成功');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '登录失败'));
    } finally {
      setBusy(null);
    }
  };

  const handleLogout = async () => {
    setError('');
    try {
      await requestJson('/api/auth/logout', { method: 'POST' });
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '退出登录失败'));
    }
    setAuth({ configured: auth?.configured ?? true, authenticated: false });
    setConfig(null);
    setMessage('已退出登录');
  };

  if (loading) {
    return (
      <Shell health={health}>
        <section className="detail-panel" aria-live="polite">
          <p>正在读取系统状态…</p>
        </section>
      </Shell>
    );
  }

  if (!auth?.authenticated || !config) {
    return (
      <Shell health={health}>
        <LoginPanel
          configured={auth?.configured ?? false}
          password={loginPassword}
          busy={busy === 'login'}
          message={message}
          error={error}
          onPasswordChange={setLoginPassword}
          onSubmit={handleLogin}
        />
      </Shell>
    );
  }

  return (
    <Shell health={health}>
      <div className="console-toolbar">
        <div>
          <p className="eyebrow">ADMIN CONSOLE</p>
          <h2>运维控制台</h2>
        </div>
        <button className="button button-ghost" type="button" onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>

      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}

      <nav className="console-nav" aria-label="控制台导航">
        {CONSOLE_VIEWS.map((item) => (
          <button
            className={`nav-button ${view === item.id ? 'nav-button-active' : ''}`}
            key={item.id}
            type="button"
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view === 'dashboard' && <DashboardPanel onNavigate={setView} />}
      {view === 'git' && <RepositoryWorkspace />}
      {view === 'scenarios' && <ScenariosPanel />}
      {view === 'runs' && <RunsPanel />}
      {view === 'active' && <ActiveRunPanel />}

      {view === 'settings' && (
        <SettingsPage
          config={config}
          onConfigChange={setConfig}
          onMessage={setMessage}
          onError={setError}
          onSessionEnded={(nextMessage) => {
            setConfig(null);
            setAuth({ configured: true, authenticated: false });
            setMessage(nextMessage);
          }}
        />
      )}
    </Shell>
  );
}

function RepositoryWorkspace() {
  const [status, setStatus] = useState<RepositoryStatusResponse | null>(null);
  const [scenarios, setScenarios] = useState<IndexedScenario[]>([]);
  const [reports, setReports] = useState<IndexedReport[]>([]);
  const [history, setHistory] = useState<RepositoryHistoryResponse | null>(null);
  const [tree, setTree] = useState<OperationsGitCommit[]>([]);
  const [treeStaleReason, setTreeStaleReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'sync' | 'branch' | 'merge' | null>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setBusy('load');
    setError('');
    try {
      const [nextStatus, nextScenarios, nextReports, nextHistory] = await Promise.all([
        requestJson<RepositoryStatusResponse>('/api/repository/status'),
        requestJson<{ scenarios: IndexedScenario[] }>('/api/scenarios'),
        requestJson<{ reports: IndexedReport[] }>('/api/reports'),
        requestJson<RepositoryHistoryResponse>('/api/history'),
      ]);
      setStatus(nextStatus);
      setScenarios(nextScenarios.scenarios);
      setReports(nextReports.reports);
      setHistory(nextHistory);
      const treeCommit = nextStatus.remoteHead ?? nextStatus.indexedCommit;
      if (treeCommit) {
        const nextTree = await requestJson<OperationsGitTreeResponse>(
          `/api/operations/git-tree?commit=${encodeURIComponent(treeCommit)}`,
        );
        setTree(nextTree.entries);
        setTreeStaleReason(nextTree.stale ? nextTree.staleReason : null);
      } else {
        setTree([]);
        setTreeStaleReason(nextStatus.errorMessage);
      }
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '无法读取仓库索引'));
      setTreeStaleReason('仓库索引暂时不可用，页面保留最近一次事实');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const sync = async () => {
    setBusy('sync');
    setError('');
    setMessage('');
    try {
      const result = await requestJson<{
        status: string;
        message: string;
        errors: Array<{ path: string; message: string }>;
      }>('/api/repository/sync', { method: 'POST' });
      setMessage(result.message);
      await load();
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '仓库同步失败'));
    } finally {
      setBusy(null);
    }
  };

  const createBranch = async () => {
    const initialRef = window.prompt('输入用于创建场景测试分支的 branch、tag 或 SHA', 'main');
    if (
      !initialRef ||
      !window.confirm(`确认从 ${initialRef} 首次创建场景测试分支并启动初始化 Run？`)
    )
      return;
    setBusy('branch');
    setError('');
    try {
      const result = await requestJson<{ queueId: number }>('/api/repository/merge', {
        method: 'POST',
        body: JSON.stringify({ sourceRef: initialRef, confirmed: true, initialization: true }),
      });
      setMessage(`首次创建与初始化请求已进入队列：#${result.queueId}`);
      await load();
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '场景测试分支创建失败'));
    } finally {
      setBusy(null);
    }
  };

  const merge = async () => {
    const sourceRef = window.prompt('输入要合并到场景测试分支的 branch、tag 或 SHA');
    if (!sourceRef || !window.confirm(`确认以 --no-ff 合并 ${sourceRef}？`)) return;
    setBusy('merge');
    setError('');
    try {
      const result = await requestJson<{ queueId: number }>('/api/repository/merge', {
        method: 'POST',
        body: JSON.stringify({ sourceRef, confirmed: true }),
      });
      setMessage(`merge 与固定 target 测试请求已进入队列：#${result.queueId}`);
      await load();
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '来源 ref 合并失败'));
    } finally {
      setBusy(null);
    }
  };

  const statusLabel = status
    ? status.availability === 'unavailable'
      ? '暂时不可用'
      : status.configured
        ? status.remoteHead
          ? '已连接'
          : '待准备分支'
        : '未配置'
    : '读取中';

  return (
    <section className="panel repository-workspace" aria-labelledby="repository-workspace-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">REPOSITORY INDEX</p>
          <h2 id="repository-workspace-title">仓库事实与场景</h2>
        </div>
        <div className="action-row">
          <button
            className="button button-ghost"
            type="button"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            刷新
          </button>
          <button
            className="button"
            type="button"
            disabled={busy !== null || !status?.configured}
            onClick={() => void sync()}
          >
            {busy === 'sync' ? '同步中…' : '同步索引'}
          </button>
        </div>
      </div>
      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      {(status?.errorMessage || treeStaleReason) && (
        <p className="notice notice-warning" role="status">
          数据可能陈旧：{status?.errorMessage ?? treeStaleReason}。页面保留最近一次可用事实。
        </p>
      )}
      <div className="repository-summary">
        <div>
          <span>状态</span>
          <strong>{statusLabel}</strong>
        </div>
        <div>
          <span>场景分支</span>
          <strong>{status?.scenarioBranch ?? '—'}</strong>
        </div>
        <div>
          <span>远端 HEAD</span>
          <strong>{shortSha(status?.remoteHead)}</strong>
        </div>
        <div>
          <span>索引 commit</span>
          <strong>{shortSha(status?.indexedCommit)}</strong>
        </div>
        <div>
          <span>最近索引</span>
          <strong>{status?.lastSyncedAt ? formatDate(status.lastSyncedAt) : '—'}</strong>
        </div>
      </div>
      <div className="action-row repository-actions">
        <button
          className="button button-ghost"
          type="button"
          disabled={busy !== null || !status?.configured}
          onClick={() => void createBranch()}
        >
          排队首次创建并初始化
        </button>
        <button
          className="button button-ghost"
          type="button"
          disabled={busy !== null || !status?.configured}
          onClick={() => void merge()}
        >
          排队 merge-source 并测试
        </button>
      </div>
      {status?.indexErrors.length ? (
        <div className="index-errors" role="status">
          <strong>索引错误</strong>
          {status.indexErrors.map((item) => (
            <p key={`${item.path}:${item.message}`}>
              <code>{item.path}</code>：{item.message}
            </p>
          ))}
        </div>
      ) : null}
      <div className="repository-columns">
        <div>
          <div className="subheading">
            <h3>场景（{scenarios.length}）</h3>
            <span>SQLite 读模型</span>
          </div>
          {scenarios.length === 0 ? (
            <p className="muted">暂无已索引场景</p>
          ) : (
            scenarios.map((scenario) => <ScenarioCard key={scenario.id} scenario={scenario} />)
          )}
        </div>
        <div>
          <div className="subheading">
            <h3>正式报告（{reports.length}）</h3>
            <span>
              {history?.issuesAvailable ? `Issues ${history.issues.length}` : 'Issues 暂不可用'}
            </span>
          </div>
          {reports.length === 0 ? (
            <p className="muted">暂无已索引报告</p>
          ) : (
            reports.map((report) => <ReportCard key={report.runId} report={report} />)
          )}
        </div>
      </div>
      <details className="tree-view">
        <summary>Git 树（{tree.length} 个文件）</summary>
        <ul>
          {tree.slice(0, 100).map((entry) => (
            <li key={entry.sha}>
              <code>{shortSha(entry.sha)}</code> {entry.subject}
              {entry.includedRuns.length > 0 && (
                <span className="tree-badge">包含 {entry.includedRuns.length} 次</span>
              )}
              {entry.targetRuns.length > 0 && (
                <span className="tree-badge tree-badge-target">
                  目标{' '}
                  {entry.targetRuns.map((run) => `${shortSha(run.runId)}:${run.result}`).join('、')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function ScenarioCard({ scenario }: { scenario: IndexedScenario }) {
  return (
    <details className="indexed-card">
      <summary>
        <span>
          <strong>{scenario.id}</strong> {scenario.name}
        </span>
        <em className={`scenario-${scenario.status}`}>{scenario.status}</em>
      </summary>
      <p>{scenario.description}</p>
      <div className="tag-row">
        {scenario.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <p className="file-meta">
        <code>{scenario.path}</code> · {shortSha(scenario.commitSha)}
      </p>
      <pre>{scenario.content}</pre>
    </details>
  );
}

function DashboardPanel({ onNavigate }: { onNavigate: (view: ConsoleView) => void }) {
  const [dashboard, setDashboard] = useState<OperationsDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setBusy(true);
    try {
      const next = await requestJson<OperationsDashboardResponse>('/api/operations/dashboard');
      setDashboard(next);
      setError('');
    } catch (cause: unknown) {
      const message = toUserMessage(cause, '无法读取运维总览');
      setDashboard((current) =>
        current ? { ...current, stale: true, staleReason: message } : current,
      );
      setError(message);
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading && !dashboard) {
    return <PanelMessage message="正在读取 Dashboard…" />;
  }
  if (!dashboard) {
    return <PanelMessage message={error || '暂无 Dashboard 数据'} error />;
  }

  const last = dashboard.progress.lastCompleted;
  return (
    <>
      <section className="panel operations-hero" aria-labelledby="dashboard-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OPERATIONS DASHBOARD</p>
            <h2 id="dashboard-title">测试分支与运行状态</h2>
          </div>
          <button
            className="button button-ghost"
            type="button"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? '刷新中…' : '刷新'}
          </button>
        </div>
        {dashboard.stale && (
          <p className="notice notice-warning" role="status">
            数据可能陈旧：{dashboard.staleReason ?? '外部依赖暂时不可用'}
            。页面保留最近一次事实，不把陈旧缓存显示为最新成功。
          </p>
        )}
        {message && <p className="notice notice-success">{message}</p>}
        {error && <p className="notice notice-error">{error}</p>}
        <div className="operations-metrics">
          <Metric
            label="场景测试分支"
            value={dashboard.branch.name}
            detail={shortSha(dashboard.branch.head)}
          />
          <Metric
            label="上次已完成目标"
            value={shortSha(dashboard.progress.lastCompletedTarget)}
            detail={last ? `${last.result} · ${shortSha(last.runId)}` : '尚无可推进 Run'}
          />
          <Metric
            label="待测提交"
            value={String(dashboard.progress.pendingCount)}
            detail={shortSha(dashboard.progress.latestTestableCommit)}
          />
          <Metric
            label="当前 Run"
            value={dashboard.activeRun ? dashboard.activeRun.stage : '空闲'}
            detail={dashboard.activeRun ? shortSha(dashboard.activeRun.run.runId) : '没有正在执行'}
          />
        </div>
      </section>

      <section className="panel" aria-labelledby="submit-run-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MANUAL TRIGGER</p>
            <h2 id="submit-run-title">发起一次测试</h2>
          </div>
          <button
            className="button button-ghost"
            type="button"
            onClick={() => onNavigate('active')}
          >
            查看当前测试
          </button>
        </div>
        <RunRequestForm
          onSubmitted={(text) => {
            setMessage(text);
            void load();
          }}
        />
      </section>

      <div className="operations-columns">
        <section className="panel" aria-labelledby="queue-title">
          <div className="section-heading">
            <h2 id="queue-title">
              等待队列（{dashboard.queue.filter((item) => item.status !== 'completed').length}）
            </h2>
            <button className="button-link" type="button" onClick={() => onNavigate('runs')}>
              查看 Runs
            </button>
          </div>
          {dashboard.queue.length === 0 ? (
            <p className="muted">队列为空</p>
          ) : (
            <div className="compact-list">
              {dashboard.queue
                .slice(-8)
                .reverse()
                .map((item) => (
                  <div className="compact-row" key={item.queueId}>
                    <span>
                      <strong>#{item.queueId}</strong> {item.trigger}
                    </span>
                    <span className={`state-${item.status}`}>{queueStatusLabel(item.status)}</span>
                    <small>
                      {shortSha(item.runId ?? item.resolvedTargetCommit ?? item.sourceRef)}
                    </small>
                  </div>
                ))}
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="dependency-title">
          <div className="section-heading">
            <h2 id="dependency-title">依赖健康</h2>
            <button className="button-link" type="button" onClick={() => onNavigate('settings')}>
              检查配置
            </button>
          </div>
          <DependencyList dependencies={dashboard.dependencies} />
        </section>
      </div>

      <div className="operations-columns">
        <section className="panel" aria-labelledby="automation-title">
          <div className="section-heading">
            <h2 id="automation-title">后台任务</h2>
            <span className={dashboard.automation.scheduler.running ? 'state-ok' : 'state-warning'}>
              {dashboard.automation.scheduler.running ? '运行中' : '未启动'}
            </span>
          </div>
          <dl className="operations-details">
            <div>
              <dt>Git Poll</dt>
              <dd>{formatMaybe(dashboard.automation.scheduler.nextPollAt)}</dd>
            </div>
            <div>
              <dt>Archiver</dt>
              <dd>{formatMaybe(dashboard.automation.scheduler.nextArchiveAt)}</dd>
            </div>
            <div>
              <dt>Indexer</dt>
              <dd>{formatMaybe(dashboard.automation.scheduler.nextIndexerAt)}</dd>
            </div>
            <div>
              <dt>保留清理</dt>
              <dd>{formatMaybe(dashboard.automation.scheduler.nextCleanupAt)}</dd>
            </div>
          </dl>
          <p className="muted">
            running {dashboard.workspace.running} · completed {dashboard.workspace.completed} ·
            待归档 {dashboard.workspace.pendingArchive}
          </p>
          {dashboard.automation.lastArchiveError && (
            <p className="notice notice-error">
              最近后台错误：{dashboard.automation.lastArchiveError}
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="review-title">
          <div className="section-heading">
            <h2 id="review-title">待审核场景 PR</h2>
            <button className="button-link" type="button" onClick={() => onNavigate('scenarios')}>
              查看场景
            </button>
          </div>
          {dashboard.automation.pendingScenarioReviews.length === 0 ? (
            <p className="muted">没有待审核场景 PR</p>
          ) : (
            <div className="compact-list">
              {dashboard.automation.pendingScenarioReviews.map((review) => (
                <div className="compact-row" key={review.runId}>
                  <span>
                    <strong>{shortSha(review.runId)}</strong> · {review.result}
                  </span>
                  <a href={review.url} target="_blank" rel="noreferrer">
                    打开 PR
                  </a>
                  <small>{shortSha(review.targetCommit)}</small>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="recent-runs-title">
        <div className="section-heading">
          <h2 id="recent-runs-title">最近 Runs</h2>
          <button className="button-link" type="button" onClick={() => onNavigate('runs')}>
            全部 Runs
          </button>
        </div>
        {dashboard.recentRuns.length === 0 ? (
          <p className="muted">暂无 Run 记录</p>
        ) : (
          <RunSummaryTable runs={dashboard.recentRuns.slice(0, 6)} />
        )}
      </section>
    </>
  );
}

function RunRequestForm({ onSubmitted }: { onSubmitted: (message: string) => void }) {
  const [request, setRequest] = useState('验证当前场景测试分支的核心业务流程');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<{ queueId: number; status?: string; runId?: string }>(
        '/api/runs',
        {
          method: 'POST',
          body: JSON.stringify({ request }),
        },
      );
      onSubmitted(
        result.runId
          ? `Run 已开始：${shortSha(result.runId)}`
          : `请求已进入队列：#${result.queueId}`,
      );
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '测试请求提交失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="run-request-form" onSubmit={(event) => void submit(event)}>
      <Field label="测试请求">
        <textarea
          aria-label="测试请求"
          rows={2}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
      </Field>
      <p className="muted">
        target 将在该请求轮到执行时固定为远端场景测试分支 HEAD；指定 branch、tag 或 SHA
        请使用仓库页的 merge-source 入口。
      </p>
      {error && <p className="notice notice-error">{error}</p>}
      <button className="button" type="submit" disabled={busy || request.trim() === ''}>
        {busy ? '提交中…' : '提交测试请求'}
      </button>
    </form>
  );
}

function ScenariosPanel() {
  const [scenarios, setScenarios] = useState<OperationsScenario[]>([]);
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (tag.trim()) params.set('tag', tag.trim());
      if (query.trim()) params.set('query', query.trim());
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const result = await requestJson<{ scenarios: OperationsScenario[] }>(
        `/api/operations/scenarios${suffix}`,
      );
      setScenarios(result.scenarios);
      setStale(false);
      setError('');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '无法读取场景'));
      setStale(scenarios.length > 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const counts = scenarios.reduce<Record<string, number>>((result, scenario) => {
    result[scenario.status] = (result[scenario.status] ?? 0) + 1;
    return result;
  }, {});

  return (
    <section className="panel" aria-labelledby="scenarios-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SCENARIO LIBRARY</p>
          <h2 id="scenarios-title">长期场景</h2>
        </div>
        <button
          className="button button-ghost"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? '读取中…' : '刷新'}
        </button>
      </div>
      <form
        className="filter-row"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <Field label="关键词">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ID、名称、描述、正文或标签"
          />
        </Field>
        <Field label="状态">
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="approved">approved</option>
            <option value="draft">draft</option>
            <option value="deprecated">deprecated</option>
          </select>
        </Field>
        <Field label="标签">
          <input
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            placeholder="例如 core"
          />
        </Field>
        <button className="button" type="submit">
          筛选
        </button>
      </form>
      <p className="muted scenario-counts">
        当前结果 {scenarios.length} · approved {counts.approved ?? 0} · draft {counts.draft ?? 0} ·
        deprecated {counts.deprecated ?? 0}
      </p>
      {error && <p className="notice notice-error">{error}</p>}
      {stale && (
        <p className="notice notice-warning" role="status">
          当前显示的是上一次成功读取的场景缓存，可能陈旧。
        </p>
      )}
      {!loading && scenarios.length === 0 && (
        <p className="empty-state">没有符合筛选条件的场景。场景正文只读自 Git 缓存。</p>
      )}
      <div className="scenario-list">
        {scenarios.map((scenario) => (
          <details className="indexed-card scenario-detail" key={scenario.id}>
            <summary>
              <span>
                <strong>{scenario.id}</strong> {scenario.name}
              </span>
              <em className={`scenario-${scenario.status}`}>{scenario.status}</em>
            </summary>
            <p>{scenario.description}</p>
            <div className="tag-row">
              {scenario.tags.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <p className="file-meta">
              <code>{scenario.path}</code> · Git {shortSha(scenario.commitSha)} · 索引于{' '}
              {formatDate(scenario.indexedAt)}
            </p>
            <pre>{scenario.content}</pre>
            <h3>历史 Runs（{scenario.history.length}）</h3>
            {scenario.history.length === 0 ? (
              <p className="muted">暂无历史执行结果</p>
            ) : (
              <div className="compact-list">
                {scenario.history.slice(0, 10).map((item) => (
                  <div className="compact-row" key={item.runId}>
                    <span>
                      {shortSha(item.runId)} · <ResultText result={item.result} />
                    </span>
                    <small>
                      {shortSha(item.targetCommit)} · {formatDate(item.finishedAt)}
                    </small>
                  </div>
                ))}
              </div>
            )}
            {scenario.pendingPullRequests.length > 0 && (
              <div className="review-links">
                <strong>待审核 PR</strong>
                {scenario.pendingPullRequests.map((item) => (
                  <a href={item.url} target="_blank" rel="noreferrer" key={item.runId}>
                    {shortSha(item.runId)} · {shortSha(item.targetCommit)}
                  </a>
                ))}
              </div>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}

function RunsPanel() {
  const [runs, setRuns] = useState<OperationsRunSummary[]>([]);
  const [selected, setSelected] = useState<OperationsRunDetail | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyRun, setBusyRun] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await requestJson<{ runs: OperationsRunSummary[] }>('/api/operations/runs');
      setRuns(result.runs);
      setStale(false);
      setError('');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '无法读取 Runs'));
      setStale(runs.length > 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openRun = async (runId: string) => {
    setBusyRun(runId);
    try {
      const result = await requestJson<{ run: OperationsRunDetail }>(
        `/api/operations/runs/${encodeURIComponent(runId)}`,
      );
      setSelected(result.run);
      setError('');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '无法读取 Run 详情'));
    } finally {
      setBusyRun('');
    }
  };

  const retryArchive = async (runId: string) => {
    if (!window.confirm(`确认重试 Run ${runId} 的归档？`)) return;
    setBusyRun(runId);
    try {
      await requestJson(`/api/runs/${encodeURIComponent(runId)}/archive`, { method: 'POST' });
      await load();
      await openRun(runId);
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '归档重试失败'));
    } finally {
      setBusyRun('');
    }
  };

  const visibleRuns = runs.filter(
    (run) => !filter || run.result === filter || run.status === filter,
  );
  return (
    <section className="panel" aria-labelledby="runs-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RUN STORE</p>
          <h2 id="runs-title">测试 Runs</h2>
        </div>
        <div className="action-row">
          <select
            aria-label="Run 状态筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">全部</option>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="blocked">blocked</option>
            <option value="interrupted">interrupted</option>
          </select>
          <button
            className="button button-ghost"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      {stale && (
        <p className="notice notice-warning" role="status">
          当前显示的是上一次成功读取的 Run 缓存，可能陈旧。
        </p>
      )}
      {!loading && visibleRuns.length === 0 && <p className="empty-state">暂无符合条件的 Run。</p>}
      {visibleRuns.length > 0 && (
        <RunSummaryTable
          runs={visibleRuns}
          onSelect={(run) => void openRun(run.runId)}
          busyRun={busyRun}
        />
      )}
      {selected && (
        <RunDetailPanel
          run={selected}
          busy={busyRun === selected.runId}
          onRetry={() => void retryArchive(selected.runId)}
        />
      )}
    </section>
  );
}

function ActiveRunPanel() {
  const [data, setData] = useState<OperationsCurrentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  const load = async () => {
    try {
      const result = await requestJson<OperationsCurrentResponse>('/api/operations/current');
      setData(result);
      setStale(false);
      setError('');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '无法读取当前测试'));
      setStale(data !== null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading && !data) return <PanelMessage message="正在读取当前测试…" />;
  if (!data?.current) {
    return (
      <section className="panel" aria-labelledby="active-title">
        <p className="eyebrow">ACTIVE RUN</p>
        <h2 id="active-title">当前测试</h2>
        {error && <p className="notice notice-error">{error}</p>}
        {stale && (
          <p className="notice notice-warning" role="status">
            当前测试数据读取失败，页面保留上一次事实。
          </p>
        )}
        <p className="empty-state">当前没有正在执行的 Run。提交人工请求后，这里会自动轮询更新。</p>
      </section>
    );
  }
  const current = data.current;
  return (
    <section className="panel" aria-labelledby="active-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ACTIVE RUN</p>
          <h2 id="active-title">当前测试 · {current.stage}</h2>
        </div>
        <span className={`run-status run-${current.run.status}`}>{current.run.status}</span>
      </div>
      {error && <p className="notice notice-error">{error}</p>}
      {stale && (
        <p className="notice notice-warning" role="status">
          当前显示的是上一次成功读取的活动缓存，可能陈旧。
        </p>
      )}
      <div className="operations-metrics">
        <Metric
          label="负责角色"
          value={current.role ? roleLabel(current.role) : '准备中'}
          detail={shortSha(current.run.runId)}
        />
        <Metric
          label="base commit"
          value={shortSha(current.run.baseCommit)}
          detail="上次已完成目标"
        />
        <Metric
          label="target commit"
          value={shortSha(current.run.targetCommit)}
          detail="固定 checkout 目标"
        />
        <Metric
          label="场景进度"
          value={`${current.progress.completed}/${current.progress.total}`}
          detail={current.currentScenario ?? '当前场景待上报'}
        />
      </div>
      {current.blockingReasons.length > 0 && (
        <div className="notice notice-warning">
          <strong>阻塞原因</strong>
          {current.blockingReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      )}
      <div className="operations-columns">
        <div>
          <h3>关键活动</h3>
          {current.activities.length === 0 ? (
            <p className="muted">暂无可展示的活动（隐藏推理不会显示）。</p>
          ) : (
            <div className="activity-list">
              {current.activities.map((activity, index) => (
                <div
                  className={`activity activity-${activity.kind}`}
                  key={`${activity.at}-${index}`}
                >
                  <time>{formatDate(activity.at)}</time>
                  <span>{activity.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <h3>已产生文件</h3>
          {current.files.length === 0 ? (
            <p className="muted">尚未产生 Run 工件</p>
          ) : (
            <div className="file-list">
              {current.files.map((file) => (
                <span key={file}>{file}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="file-meta">
        最近更新 {formatDate(current.updatedAt)} · request：{current.run.request}
      </p>
    </section>
  );
}

function RunSummaryTable({
  runs,
  onSelect,
  busyRun,
}: {
  runs: OperationsRunSummary[];
  onSelect?: (run: OperationsRunSummary) => void;
  busyRun?: string;
}) {
  return (
    <div className="run-table-wrap">
      <table className="run-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>结果</th>
            <th>阶段/状态</th>
            <th>target</th>
            <th>范围</th>
            <th>归档</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td>
                {onSelect ? (
                  <button className="button-link" type="button" onClick={() => onSelect(run)}>
                    {shortSha(run.runId)}
                  </button>
                ) : (
                  <code>{shortSha(run.runId)}</code>
                )}
                <small>{formatDate(run.startedAt)}</small>
              </td>
              <td>
                <ResultText result={run.result} />
              </td>
              <td>
                {run.phase}
                <small>{run.status}</small>
              </td>
              <td>
                <code>{shortSha(run.targetCommit)}</code>
              </td>
              <td>{run.includedCommits.length} commits</td>
              <td>
                {run.archive
                  ? run.archive.archiveStatus
                  : run.status === 'completed'
                    ? '未归档'
                    : '—'}
                {busyRun === run.runId && <small>处理中…</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetailPanel({
  run,
  busy,
  onRetry,
}: {
  run: OperationsRunDetail;
  busy: boolean;
  onRetry: () => void;
}) {
  const artifactNames = ['plan.md', 'execution.md', 'draft-report.md', 'review.md', 'report.md'];
  const canRetry = run.archive && run.archive.archiveStatus !== 'completed';
  return (
    <section className="run-detail" aria-labelledby="run-detail-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RUN DETAIL</p>
          <h3 id="run-detail-title">{run.runId}</h3>
        </div>
        {canRetry && (
          <button className="button" type="button" disabled={busy} onClick={onRetry}>
            {busy ? '重试中…' : '重试归档'}
          </button>
        )}
      </div>
      <dl className="operations-details">
        <div>
          <dt>请求</dt>
          <dd>{run.request || '—'}</dd>
        </div>
        <div>
          <dt>base / target</dt>
          <dd>
            <code>{shortSha(run.baseCommit)}</code> → <code>{shortSha(run.targetCommit)}</code>
          </dd>
        </div>
        <div>
          <dt>included commits</dt>
          <dd>
            {run.includedCommits.length
              ? run.includedCommits.map((sha) => <code key={sha}>{shortSha(sha)}</code>)
              : '—'}
          </dd>
        </div>
        <div>
          <dt>场景结果</dt>
          <dd>
            {run.scenarioResults.length
              ? run.scenarioResults.map((item) => (
                  <span className="inline-result" key={item.id}>
                    {item.id}: {item.result}
                  </span>
                ))
              : '零场景或尚未形成结果'}
          </dd>
        </div>
      </dl>
      <h4>Run 工件</h4>
      <div className="artifact-grid">
        {artifactNames.map((name) => (
          <details className="artifact-card" key={name}>
            <summary>{name}</summary>
            {run.artifacts[name] ? (
              <pre>{run.artifacts[name]}</pre>
            ) : (
              <p className="muted">不适用或尚未产生</p>
            )}
          </details>
        ))}
        {run.artifacts['scenario-changes.patch'] && (
          <details className="artifact-card">
            <summary>scenario-changes.patch</summary>
            <pre>{run.artifacts['scenario-changes.patch']}</pre>
          </details>
        )}
      </div>
      {run.confirmedBugs.length > 0 && (
        <>
          <h4>Confirmed Bugs 与 Issues</h4>
          <div className="bug-list">
            {run.confirmedBugs.map((bug) => {
              const issue = run.issues.find((item) => item.bugKey === bug.key);
              const issueUrl = issue?.issueUrl ?? issue?.requestedIssueUrl;
              return (
                <div className="bug-row" key={bug.key}>
                  <strong>{bug.key}</strong>
                  <span>{bug.title}</span>
                  <span>
                    {issueUrl ? (
                      <a href={issueUrl} target="_blank" rel="noreferrer">
                        Issue {issue?.issueNumber ?? ''}
                      </a>
                    ) : (
                      (issue?.status ?? '未归档')
                    )}
                  </span>
                  {issue?.errorMessage && <small>{issue.errorMessage}</small>}
                </div>
              );
            })}
          </div>
        </>
      )}
      {run.evidence && run.evidence.length > 0 && (
        <>
          <h4>OSS 证据</h4>
          <div className="evidence-list">
            {run.evidence.map((item) => (
              <a href={item.url} target="_blank" rel="noreferrer" key={item.id}>
                {item.filename} · {item.contentType}
              </a>
            ))}
          </div>
        </>
      )}
      {run.scenarioPrUrl && (
        <p className="file-meta">
          场景 PR：{' '}
          <a href={run.scenarioPrUrl} target="_blank" rel="noreferrer">
            {run.scenarioPrUrl}
          </a>
        </p>
      )}
      {run.archive && (
        <p className="file-meta">
          report：{run.archive.reportStatus} · 报告 commit {shortSha(run.archive.reportCommitSha)} ·
          场景 {run.archive.scenarioStatus} ·{' '}
          {run.archive.archiveError ?? run.archive.scenarioError ?? '无归档错误'}
        </p>
      )}
    </section>
  );
}

function DependencyList({
  dependencies,
}: {
  dependencies: OperationsDashboardResponse['dependencies'];
}) {
  return (
    <div className="dependency-list">
      {dependencies.map((dependency) => (
        <div className="dependency-row" key={dependency.id}>
          <span>
            <strong>{dependency.label}</strong>
            <small>{dependency.message}</small>
          </span>
          <span className={`dependency-status dependency-${dependency.status}`}>
            {dependencyStatusLabel(dependency.status)}
            {dependency.stale && <small>陈旧</small>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function PanelMessage({ message, error = false }: { message: string; error?: boolean }) {
  return (
    <section
      className={`panel panel-message ${error ? 'panel-message-error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <p>{message}</p>
    </section>
  );
}

function ResultText({ result }: { result: 'passed' | 'failed' | 'blocked' | null }) {
  return <span className={`result-text result-${result ?? 'unknown'}`}>{result ?? '进行中'}</span>;
}

function queueStatusLabel(status: OperationsDashboardResponse['queue'][number]['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'waiting_archive':
      return '等待归档';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'interrupted':
      return '已中断';
  }
}

function dependencyStatusLabel(
  status: OperationsDashboardResponse['dependencies'][number]['status'],
): string {
  switch (status) {
    case 'ok':
      return '正常';
    case 'degraded':
      return '异常';
    case 'unavailable':
      return '不可用';
    case 'not_configured':
      return '未配置';
    case 'unknown':
      return '未知';
  }
}

function roleLabel(role: NonNullable<OperationsDashboardResponse['activeRun']>['role']): string {
  switch (role) {
    case 'main-a':
      return 'Main · 规划';
    case 'runner':
      return 'Runner';
    case 'reviewer':
      return 'Reviewer';
    case 'main-b':
      return 'Main · 最终汇总';
    default:
      return '—';
  }
}

function formatMaybe(value: string | null): string {
  return value ? formatDate(value) : '—';
}

function ReportCard({ report }: { report: IndexedReport }) {
  return (
    <details className="indexed-card">
      <summary>
        <span>
          <strong>{report.runId}</strong> {report.trigger}
        </span>
        <em className={`report-${report.result}`}>{report.result}</em>
      </summary>
      <p>
        target <code>{shortSha(report.targetCommit)}</code> · {formatDate(report.finishedAt)}
      </p>
      {report.confirmedBugs.length > 0 && (
        <p>confirmed bugs：{report.confirmedBugs.map((bug) => bug.title).join('、')}</p>
      )}
      <div className="file-list">
        {Object.keys(report.files)
          .sort()
          .map((file) => (
            <span key={file}>{file}</span>
          ))}
      </div>
      <p className="file-meta">
        <code>{report.path}</code> · indexed {shortSha(report.commitSha)}
      </p>
      <pre>{report.content}</pre>
    </details>
  );
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : '—';
}

async function loadHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
