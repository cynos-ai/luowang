import { useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  AuthStatusResponse,
  HarnessConfig,
  HealthResponse,
  IndexedReport,
  IndexedScenario,
  RepositoryConfig,
  RunSummary,
  SecretMetadata,
} from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { LoginPanel } from '../components/LoginPanel';
import { Shell } from '../components/Shell';

type ProjectConfig = Omit<RepositoryConfig, 'repository'> & {
  language: string;
  testDataCleanupUrl: string;
  executionDockerfile: string;
};
type Project = {
  projectId: string;
  displayName: string;
  repositoryOwner: string;
  repositoryName: string;
  status: 'active' | 'paused';
  configRevision: number;
};
type ProjectSecret = 'gitToken' | 'testUsername' | 'testPassword' | 'testDataCleanupToken';
type ProjectDetail = {
  project: Project;
  configuration: ProjectConfig;
  secrets: Record<ProjectSecret, SecretMetadata>;
};
type Readiness = {
  checkedAt: string;
  ready: boolean;
  checks: Array<{ id: string; status: string; message: string }>;
};
type QueueItem = {
  queueId: number;
  status: string;
  request: string;
  runId: string | null;
  errorMessage: string | null;
  createdAt: string;
};
type IndexState = {
  commitSha: string | null;
  syncedAt: string | null;
  errors: Array<{ path: string; message: string }>;
};
type Section = 'projects' | 'deployment' | 'account';

const SECRET_LABELS: Array<[ProjectSecret, string]> = [
  ['gitToken', 'GitHub Token'],
  ['testUsername', '测试账号'],
  ['testPassword', '测试密码'],
  ['testDataCleanupToken', '清理 Token'],
];
const CHECK_LABELS: Record<string, string> = {
  repository: 'GitHub 仓库',
  deployment: '模型、浏览器和对象存储',
  environment: '非生产测试环境',
  image: '项目执行镜像',
  credentials: '测试与清理凭据',
};
const CHECK_STATUSES: Record<string, string> = {
  ok: '通过',
  not_configured: '未配置',
  failed: '失败',
  needs_recheck: '待重检',
};

function projectFromHash(): string | null {
  const match = window.location.hash.match(/^#\/projects\/([0-9a-f-]{36})$/i);
  return match?.[1] ?? null;
}

export default function ProjectApp() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [password, setPassword] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(projectFromHash);
  const [section, setSection] = useState<Section>('projects');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [gitToken, setGitToken] = useState('');

  const reloadProjects = async () => {
    const response = await requestJson<{ projects: Project[] }>('/api/projects');
    setProjects(response.projects);
  };

  useEffect(() => {
    let mounted = true;
    void Promise.allSettled([
      requestJson<HealthResponse>('/health').then((value) => mounted && setHealth(value)),
      requestJson<AuthStatusResponse>('/api/auth/status').then(async (value) => {
        if (!mounted) return;
        setAuth(value);
        if (value.authenticated) await reloadProjects();
      }),
    ]).finally(() => mounted && setLoading(false));
    const onHash = () => {
      setSelectedId(projectFromHash());
      setSection('projects');
    };
    const onUnauthorized = () => {
      setAuth({ configured: true, authenticated: false });
      setProjects([]);
      setError('登录已过期，请重新登录');
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('luowang:unauthorized', onUnauthorized);
    return () => {
      mounted = false;
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('luowang:unauthorized', onUnauthorized);
    };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await requestJson('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      setPassword('');
      setAuth(await requestJson<AuthStatusResponse>('/api/auth/status'));
      await reloadProjects();
    } catch (cause) {
      setError(toUserMessage(cause, '登录失败'));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await requestJson('/api/auth/logout', { method: 'POST' });
      setAuth({ configured: true, authenticated: false });
      setProjects([]);
      setSelectedId(null);
      window.location.hash = '';
    } catch (cause) {
      setError(toUserMessage(cause, '退出失败'));
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          displayName: name,
          repositoryUrl,
          ...(gitToken ? { gitToken } : {}),
        }),
      });
      setName('');
      setRepositoryUrl('');
      setGitToken('');
      await reloadProjects();
      window.location.hash = `#/projects/${result.project.projectId}`;
      setMessage('项目已连接并暂停。完成配置、准备镜像和就绪检查后再启用。');
    } catch (cause) {
      setError(toUserMessage(cause, '连接项目失败'));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <Shell health={health}>
        <section className="detail-panel">正在读取服务状态…</section>
      </Shell>
    );
  if (!auth?.authenticated) {
    return (
      <Shell health={health}>
        <LoginPanel
          configured={auth?.configured ?? false}
          password={password}
          busy={busy}
          message={message}
          error={error}
          onPasswordChange={setPassword}
          onSubmit={login}
        />
      </Shell>
    );
  }
  return (
    <Shell health={health}>
      <div className="console-toolbar">
        <div>
          <p className="eyebrow">MULTI-PROJECT CONSOLE</p>
          <h2>项目控制台</h2>
        </div>
        <button className="button button-ghost" type="button" onClick={() => void logout()}>
          退出登录
        </button>
      </div>
      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      <nav className="console-nav" aria-label="控制台导航">
        {(['projects', 'deployment', 'account'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={`nav-button ${section === item ? 'nav-button-active' : ''}`}
            onClick={() => setSection(item)}
          >
            {item === 'projects' ? '项目' : item === 'deployment' ? '部署设置' : '账号'}
          </button>
        ))}
      </nav>
      {section === 'projects' && (
        <>
          <section className="panel">
            <h3>我的项目</h3>
            {projects.length === 0 ? (
              <p>还没有项目。先连接一个 GitHub 仓库。</p>
            ) : (
              <div className="project-list">
                {projects.map((project) => (
                  <button
                    className={`project-card ${selectedId === project.projectId ? 'project-card-active' : ''}`}
                    type="button"
                    key={project.projectId}
                    onClick={() => {
                      window.location.hash = `#/projects/${project.projectId}`;
                    }}
                  >
                    <strong>{project.displayName}</strong>
                    <small>
                      {project.repositoryOwner}/{project.repositoryName}
                    </small>
                    <span>{project.status === 'active' ? '已启用' : '已暂停'}</span>
                  </button>
                ))}
              </div>
            )}
            <form className="project-create" onSubmit={(event) => void createProject(event)}>
              <h4>连接新项目</h4>
              <label className="field">
                项目名称
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="field">
                GitHub 仓库地址
                <input
                  required
                  type="url"
                  placeholder="https://github.com/owner/repo"
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                />
              </label>
              <label className="field">
                GitHub Token（私有仓库必填）
                <input
                  type="password"
                  autoComplete="off"
                  value={gitToken}
                  onChange={(event) => setGitToken(event.target.value)}
                />
              </label>
              <button className="button" type="submit" disabled={busy}>
                核验并创建暂停项目
              </button>
            </form>
          </section>
          {selectedId && projects.some((project) => project.projectId === selectedId) && (
            <ProjectView
              key={selectedId}
              projectId={selectedId}
              onProjectsChange={() => void reloadProjects()}
            />
          )}
          {selectedId && !projects.some((project) => project.projectId === selectedId) && (
            <p className="notice notice-warning">链接中的项目不存在或尚未载入。</p>
          )}
        </>
      )}
      {section === 'deployment' && <DeploymentView />}
      {section === 'account' && (
        <AccountView
          onSessionEnded={() => {
            setAuth({ configured: true, authenticated: false });
            setProjects([]);
          }}
        />
      )}
    </Shell>
  );
}

function ProjectView({
  projectId,
  onProjectsChange,
}: {
  projectId: string;
  onProjectsChange: () => void;
}) {
  const base = `/api/projects/${projectId}`;
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [draft, setDraft] = useState<ProjectConfig | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [readinessError, setReadinessError] = useState('');
  const [index, setIndex] = useState<IndexState | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [scenarios, setScenarios] = useState<IndexedScenario[]>([]);
  const [reports, setReports] = useState<IndexedReport[]>([]);
  const [secretValues, setSecretValues] = useState<Partial<Record<ProjectSecret, string>>>({});
  const [runRequest, setRunRequest] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [initializeFromSource, setInitializeFromSource] = useState(false);
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [image, setImage] = useState<{
    targetCommit: string;
    imageId: string;
    reused: boolean;
  } | null>(null);
  const mounted = useRef(true);
  const requests = useRef<AbortController | null>(null);

  async function load(signal?: AbortSignal) {
    const current = () => mounted.current && !signal?.aborted;
    const detailRequest = requestJson<ProjectDetail>(base, { signal }).then((value) => {
      if (current()) {
        setDetail(value);
        setDraft(value.configuration);
      }
    });
    const optional = [
      requestJson<Readiness>(`${base}/readiness`, { signal }).then(
        (value) => {
          if (current()) {
            setReadiness(value);
            setReadinessError('');
          }
        },
        (cause: unknown) => {
          if (current()) setReadinessError(toUserMessage(cause, '就绪检查失败'));
        },
      ),
      requestJson<{ index: IndexState }>(`${base}/index`, { signal }).then((value) => {
        if (current()) setIndex(value.index);
      }),
      requestJson<{ queue: QueueItem[] }>(`${base}/queue`, { signal }).then((value) => {
        if (current()) setQueue(value.queue);
      }),
      requestJson<{ runs: RunSummary[] }>(`${base}/runs`, { signal }).then((value) => {
        if (current()) setRuns(value.runs);
      }),
      requestJson<{ scenarios: IndexedScenario[] }>(`${base}/scenarios`, { signal }).then(
        (value) => {
          if (current()) setScenarios(value.scenarios);
        },
      ),
      requestJson<{ reports: IndexedReport[] }>(`${base}/reports`, { signal }).then((value) => {
        if (current()) setReports(value.reports);
      }),
    ];
    const [detailOutcome, ...outcomes] = await Promise.allSettled([detailRequest, ...optional]);
    if (detailOutcome.status === 'rejected') throw detailOutcome.reason;
    if (current() && outcomes.some((result) => result.status === 'rejected')) {
      setError('部分项目状态暂时不可用；项目设置仍可修改，请稍后重试。');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    mounted.current = true;
    void load(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(toUserMessage(cause, '项目资料暂时不可用'));
    });
    const timer = window.setInterval(() => {
      void Promise.all([
        requestJson<{ queue: QueueItem[] }>(`${base}/queue`, { signal: controller.signal }),
        requestJson<{ runs: RunSummary[] }>(`${base}/runs`, { signal: controller.signal }),
      ])
        .then(([nextQueue, nextRuns]) => {
          if (!controller.signal.aborted) {
            setQueue(nextQueue.queue);
            setRuns(nextRuns.runs);
          }
        })
        .catch(() => {});
    }, 5000);
    return () => {
      mounted.current = false;
      controller.abort();
      requests.current = null;
      window.clearInterval(timer);
    };
  }, [projectId]);

  async function action(label: string, operation: () => Promise<unknown>) {
    setBusy(label);
    setError('');
    setMessage('');
    try {
      await operation();
      if (!mounted.current) return;
      await load(requests.current?.signal);
      if (!mounted.current) return;
      onProjectsChange();
      setMessage(`${label}完成`);
    } catch (cause) {
      if (mounted.current) setError(toUserMessage(cause, `${label}失败`));
    } finally {
      if (mounted.current) setBusy('');
    }
  }

  if (!detail || !draft)
    return (
      <section className="panel">
        <p>{error || '正在读取项目…'}</p>
      </section>
    );
  const project = detail.project;
  return (
    <>
      <section className="panel project-overview">
        <div className="console-toolbar">
          <div>
            <p className="eyebrow">PROJECT</p>
            <h3>{project.displayName}</h3>
            <p>
              {project.repositoryOwner}/{project.repositoryName} ·{' '}
              {project.status === 'active' ? '已启用' : '已暂停新测试'}
            </p>
          </div>
          <div className="project-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void action('就绪检查', async () => {})}
            >
              重新检查
            </button>
            <button
              className="button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void action(project.status === 'active' ? '暂停' : '启用', () =>
                  requestJson(`${base}/${project.status === 'active' ? 'pause' : 'resume'}`, {
                    method: 'POST',
                  }),
                )
              }
            >
              {project.status === 'active' ? '暂停新测试' : '检查并启用'}
            </button>
          </div>
        </div>
        {message && <p className="notice notice-success">{message}</p>}
        {error && <p className="notice notice-error">{error}</p>}
        {project.status === 'paused' && (
          <p className="notice notice-neutral">暂停只阻止新请求；已运行和待归档工作会继续。</p>
        )}
        <div className="project-facts">
          <div>
            <small>最近索引提交</small>
            <strong>{index?.commitSha?.slice(0, 12) ?? '尚无'}</strong>
            <small>{index?.syncedAt ?? '未同步'}</small>
          </div>
          <div>
            <small>排队请求</small>
            <strong>{queue.filter((item) => item.status === 'queued').length}</strong>
          </div>
          <div>
            <small>已记录 Run</small>
            <strong>{runs.length}</strong>
          </div>
        </div>
        {index?.errors.map((item) => (
          <p className="notice notice-warning" key={item.path}>
            {item.path}: {item.message}
          </p>
        ))}
        <h4>就绪检查 {readiness?.ready ? '· 已通过' : '· 尚未通过'}</h4>
        {readinessError && <p className="notice notice-warning">{readinessError}</p>}
        <div className="project-checks">
          {readiness?.checks.map((check) => (
            <div key={check.id}>
              <strong>{CHECK_LABELS[check.id] ?? check.id}</strong>
              <span>{CHECK_STATUSES[check.status] ?? check.status}</span>
              <p>{check.message}</p>
            </div>
          ))}
        </div>
        <small>检查时间：{readiness?.checkedAt ?? '尚未检查'}</small>
      </section>
      <section className="panel">
        <h3>项目设置</h3>
        <p>先保存非生产环境、测试策略和执行镜像说明。保存成功不代表连通性通过。</p>
        <form
          className="project-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action('保存项目配置', () =>
              requestJson(`${base}/configuration`, { method: 'PUT', body: JSON.stringify(draft) }),
            );
          }}
        >
          <label className="field">
            生成语言
            <input
              value={draft.language}
              onChange={(event) => setDraft({ ...draft, language: event.target.value })}
            />
          </label>
          <label className="field">
            场景分支
            <input
              value={draft.scenarioBranch}
              onChange={(event) => setDraft({ ...draft, scenarioBranch: event.target.value })}
            />
          </label>
          <label className="field">
            场景维护
            <select
              value={draft.scenarioMode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  scenarioMode: event.target.value as ProjectConfig['scenarioMode'],
                })
              }
            >
              <option value="autonomous">自动维护</option>
              <option value="add-only">仅自动新增</option>
              <option value="review-all">全部人工审核</option>
            </select>
          </label>
          <label className="field">
            固定包含的标签（逗号分隔）
            <input
              value={draft.scenarioLabels.join(', ')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  scenarioLabels: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="field">
            非生产环境 URL
            <input
              type="url"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label className="field">
            环境说明
            <textarea
              value={draft.environmentDescription}
              onChange={(event) =>
                setDraft({ ...draft, environmentDescription: event.target.value })
              }
            />
          </label>
          <label className="field">
            外部数据库说明
            <input
              value={draft.externalDatabase}
              onChange={(event) => setDraft({ ...draft, externalDatabase: event.target.value })}
            />
          </label>
          <label className="field">
            清理服务 URL
            <input
              type="url"
              value={draft.testDataCleanupUrl}
              onChange={(event) => setDraft({ ...draft, testDataCleanupUrl: event.target.value })}
            />
          </label>
          <label className="field">
            仓库中的执行 Dockerfile（留空使用内置基础镜像）
            <input
              value={draft.executionDockerfile}
              onChange={(event) => setDraft({ ...draft, executionDockerfile: event.target.value })}
            />
          </label>
          <label className="field">
            Git 轮询间隔（秒）
            <input
              type="number"
              min="0"
              value={draft.pollIntervalSeconds}
              onChange={(event) =>
                setDraft({ ...draft, pollIntervalSeconds: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            定时表达式
            <input
              value={draft.cron}
              onChange={(event) => setDraft({ ...draft, cron: event.target.value })}
            />
          </label>
          <label className="field project-checkbox">
            <input
              type="checkbox"
              checked={draft.triggerOnCommit}
              onChange={(event) => setDraft({ ...draft, triggerOnCommit: event.target.checked })}
            />
            提交变化时自动触发
          </label>
          <button className="button" type="submit" disabled={Boolean(busy)}>
            保存项目配置
          </button>
        </form>
      </section>
      <section className="panel">
        <h3>项目凭据</h3>
        <p>凭据只保存在此项目，页面不会回显原文。</p>
        <div className="project-secrets">
          {SECRET_LABELS.map(([key, label]) => (
            <form
              key={key}
              onSubmit={(event) => {
                event.preventDefault();
                const value = secretValues[key];
                if (!value) return;
                void action(`保存${label}`, async () => {
                  await requestJson(`${base}/secrets/${key}`, {
                    method: 'PUT',
                    body: JSON.stringify({ value }),
                  });
                  setSecretValues((current) => ({ ...current, [key]: '' }));
                });
              }}
            >
              <label className="field">
                {label} · {detail.secrets[key]?.configured ? '已配置' : '未配置'}
                <input
                  type="password"
                  autoComplete="off"
                  value={secretValues[key] ?? ''}
                  onChange={(event) =>
                    setSecretValues((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
              </label>
              <button
                className="button button-secondary"
                type="submit"
                disabled={Boolean(busy) || !secretValues[key]}
              >
                保存
              </button>
            </form>
          ))}
        </div>
      </section>
      <section className="panel">
        <h3>执行镜像与同步</h3>
        <p>镜像按固定提交准备；Run 使用不可变镜像，不会临时回退到服务容器。</p>
        <div className="project-actions">
          <button
            className="button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void action('准备镜像', async () => {
                const result = await requestJson<{
                  image: { targetCommit: string; imageId: string; reused: boolean };
                }>(`${base}/image/prepare`, { method: 'POST', body: '{}' });
                setImage(result.image);
              })
            }
          >
            准备或重建镜像
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void action('同步仓库', () =>
                requestJson(`${base}/repository/sync`, { method: 'POST' }),
              )
            }
          >
            同步场景与报告
          </button>
        </div>
        {image && (
          <p>
            提交 {image.targetCommit.slice(0, 12)} · 镜像 {image.imageId.slice(0, 24)} ·{' '}
            {image.reused ? '已复用' : '新构建'}
          </p>
        )}
      </section>
      <section className="panel">
        <h3>测试与历史</h3>
        <p>
          首次测试且场景分支尚不存在时，从可信的来源分支、tag
          或提交创建，并勾选“首次初始化”。已有场景分支时，也可先纳入来源再测试；普通重测使用下方的“提交
          Run”。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!sourceConfirmed || !sourceRef.trim()) return;
            void action('提交来源并测试', async () => {
              await requestJson(`${base}/merge`, {
                method: 'POST',
                body: JSON.stringify({
                  sourceRef: sourceRef.trim(),
                  confirmed: true,
                  initialization: initializeFromSource,
                }),
              });
              setSourceRef('');
              setSourceConfirmed(false);
              setInitializeFromSource(false);
            });
          }}
        >
          <label className="field">
            来源分支、tag 或提交
            <input
              value={sourceRef}
              onChange={(event) => setSourceRef(event.target.value)}
              placeholder="main"
              required
            />
          </label>
          <label className="field project-checkbox">
            <input
              type="checkbox"
              checked={initializeFromSource}
              onChange={(event) => setInitializeFromSource(event.target.checked)}
            />
            首次初始化（场景分支尚不存在时必须勾选）
          </label>
          <label className="field project-checkbox">
            <input
              type="checkbox"
              checked={sourceConfirmed}
              onChange={(event) => setSourceConfirmed(event.target.checked)}
            />
            我确认要把此来源纳入当前项目的场景测试分支
          </label>
          <button
            className="button button-secondary"
            type="submit"
            disabled={
              Boolean(busy) || project.status !== 'active' || !sourceRef.trim() || !sourceConfirmed
            }
          >
            提交来源并测试
          </button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action('提交测试', async () => {
              await requestJson(`${base}/runs`, {
                method: 'POST',
                body: JSON.stringify({ request: runRequest }),
              });
              setRunRequest('');
            });
          }}
        >
          <label className="field">
            测试请求
            <textarea
              required
              value={runRequest}
              onChange={(event) => setRunRequest(event.target.value)}
            />
          </label>
          <button
            className="button"
            type="submit"
            disabled={Boolean(busy) || project.status !== 'active'}
          >
            提交 Run
          </button>
        </form>
        <div className="project-history">
          <div>
            <h4>队列</h4>
            {queue
              .slice(-10)
              .reverse()
              .map((item) => (
                <p key={item.queueId}>
                  #{item.queueId} · {item.status} · {item.request.slice(0, 80)}{' '}
                  {item.errorMessage && `· ${item.errorMessage}`}
                </p>
              ))}
          </div>
          <div>
            <h4>Run</h4>
            {runs.slice(0, 10).map((run) => (
              <p key={run.runId}>
                {run.runId} · {run.phase} · {run.result ?? run.status}
                {run.errorMessage && ` · ${run.errorMessage}`}
              </p>
            ))}
          </div>
          <div>
            <h4>场景 / 报告</h4>
            <p>
              {scenarios.length} 个场景 · {reports.length} 份报告
            </p>
            {scenarios.slice(0, 8).map((item) => (
              <p key={item.id}>
                {item.id} · {item.name}
              </p>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function DeploymentView() {
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const [secrets, setSecrets] = useState<Record<string, SecretMetadata>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void requestJson<{ configuration: HarnessConfig; secrets: Record<string, SecretMetadata> }>(
      '/api/deployment',
    )
      .then((value) => {
        setConfig(value.configuration);
        setSecrets(value.secrets);
      })
      .catch((cause) => setError(toUserMessage(cause, '部署设置读取失败')));
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config) return;
    setError('');
    try {
      const result = await requestJson<{ configuration: HarnessConfig }>('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify({
          provider: config.provider,
          providerBaseUrl: config.providerBaseUrl,
          agents: config.agents,
          mcp: config.mcp,
          oss: config.oss,
          local: { retentionDays: config.local.retentionDays },
        }),
      });
      setConfig(result.configuration);
      setMessage('部署设置已保存');
    } catch (cause) {
      setError(toUserMessage(cause, '部署设置保存失败'));
    }
  }
  if (!config) return <section className="panel">{error || '正在读取部署设置…'}</section>;
  return (
    <section className="panel">
      <h3>部署设置</h3>
      <p>模型、浏览器与 OSS 在整个部署中共用；项目仓库与测试账号在项目页配置。</p>
      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      <form className="project-form" onSubmit={(event) => void save(event)}>
        <label className="field">
          Provider
          <input
            value={config.provider}
            onChange={(event) => setConfig({ ...config, provider: event.target.value })}
          />
        </label>
        <label className="field">
          Provider Base URL
          <input
            value={config.providerBaseUrl}
            onChange={(event) => setConfig({ ...config, providerBaseUrl: event.target.value })}
          />
        </label>
        {(['main', 'runner', 'reviewer'] as const).map((role) => (
          <label className="field" key={role}>
            {role} 模型
            <input
              value={config.agents[role].model}
              onChange={(event) =>
                setConfig({
                  ...config,
                  agents: {
                    ...config.agents,
                    [role]: { ...config.agents[role], model: event.target.value },
                  },
                })
              }
            />
          </label>
        ))}
        <label className="field">
          浏览器
          <select
            value={config.mcp.browser}
            onChange={(event) =>
              setConfig({
                ...config,
                mcp: {
                  ...config.mcp,
                  browser: event.target.value as HarnessConfig['mcp']['browser'],
                },
              })
            }
          >
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </select>
        </label>
        <label className="field">
          OSS Endpoint
          <input
            value={config.oss.endpoint}
            onChange={(event) =>
              setConfig({ ...config, oss: { ...config.oss, endpoint: event.target.value } })
            }
          />
        </label>
        <label className="field">
          OSS Bucket
          <input
            value={config.oss.bucket}
            onChange={(event) =>
              setConfig({ ...config, oss: { ...config.oss, bucket: event.target.value } })
            }
          />
        </label>
        <label className="field">
          OSS Public URL
          <input
            value={config.oss.publicBaseUrl}
            onChange={(event) =>
              setConfig({ ...config, oss: { ...config.oss, publicBaseUrl: event.target.value } })
            }
          />
        </label>
        <label className="field">
          保留天数
          <input
            type="number"
            min="1"
            value={config.local.retentionDays}
            onChange={(event) =>
              setConfig({
                ...config,
                local: { ...config.local, retentionDays: Number(event.target.value) },
              })
            }
          />
        </label>
        <button className="button" type="submit">
          保存部署设置
        </button>
      </form>
      <h4>部署凭据</h4>
      {(['providerApiKey', 'ossAccessKeyId', 'ossAccessKeySecret'] as const).map((key) => (
        <form
          className="project-secret-row"
          key={key}
          onSubmit={(event) => {
            event.preventDefault();
            const value = values[key];
            if (!value) return;
            void requestJson(`/api/deployment/secrets/${key}`, {
              method: 'PUT',
              body: JSON.stringify({ value }),
            })
              .then(() => {
                setValues((current) => ({ ...current, [key]: '' }));
                setSecrets((current) => ({
                  ...current,
                  [key]: { configured: true, masked: '••••••••' },
                }));
                setMessage(`${key} 已保存`);
              })
              .catch((cause) => setError(toUserMessage(cause, '凭据保存失败')));
          }}
        >
          <label className="field">
            {key} · {secrets[key]?.configured ? '已配置' : '未配置'}
            <input
              type="password"
              autoComplete="off"
              value={values[key] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [key]: event.target.value }))
              }
            />
          </label>
          <button className="button button-secondary" type="submit" disabled={!values[key]}>
            保存
          </button>
        </form>
      ))}
    </section>
  );
}

function AccountView({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void requestJson<{ profile: { displayName: string } }>('/api/account')
      .then((value) => setDisplayName(value.profile.displayName))
      .catch((cause) => setError(toUserMessage(cause, '账号资料读取失败')));
  }, []);
  return (
    <section className="panel">
      <h3>管理员账号</h3>
      <p>当前部署只有一名管理员，显示名称不参与授权。</p>
      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void requestJson('/api/account', { method: 'PUT', body: JSON.stringify({ displayName }) })
            .then(() => setMessage('显示名称已保存'))
            .catch((cause) => setError(toUserMessage(cause, '保存失败')));
        }}
      >
        <label className="field">
          显示名称
          <input
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          保存显示名称
        </button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void requestJson('/api/auth/password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword }),
          })
            .then(() => {
              setCurrentPassword('');
              setNewPassword('');
              onSessionEnded();
            })
            .catch((cause) => setError(toUserMessage(cause, '修改密码失败')));
        }}
      >
        <h4>修改密码</h4>
        <label className="field">
          当前密码
          <input
            type="password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="field">
          新密码
          <input
            type="password"
            required
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          修改密码并退出当前会话
        </button>
      </form>
    </section>
  );
}
