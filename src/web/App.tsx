import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type {
  AuthStatusResponse,
  ConfigResponse,
  ConnectivityCheck,
  HarnessConfig,
  HealthResponse,
  RepositoryConfig,
  SecretKey,
} from '../shared/types';

const DEFAULT_HARNESS: HarnessConfig = {
  language: 'zh-CN',
  provider: '',
  agents: {
    main: { model: '', thinking: 'medium' },
    runner: { model: '', thinking: 'medium' },
    reviewer: { model: '', thinking: 'medium' },
  },
  local: { repoDir: '', reportDir: '', retentionDays: 30 },
  mcp: { enabled: false, browser: 'chromium', headless: true, timeoutMs: 30_000 },
  oss: {
    endpoint: '',
    region: '',
    bucket: '',
    publicBaseUrl: '',
    accessMode: 'private',
    objectPrefix: '',
  },
};

const DEFAULT_REPOSITORY: RepositoryConfig = {
  repository: '',
  scenarioBranch: 'scenario-testing',
  scenarioMode: 'pr-required',
  scenarioLabels: [],
  pollIntervalSeconds: 300,
  cron: '',
  triggerOnCommit: false,
  environmentDescription: '',
  baseUrl: '',
};

const SECRET_FIELDS: Array<{ key: SecretKey; label: string }> = [
  { key: 'providerApiKey', label: 'Provider API Key' },
  { key: 'ossAccessKeyId', label: 'OSS Access Key ID' },
  { key: 'ossAccessKeySecret', label: 'OSS Access Key Secret' },
  { key: 'gitToken', label: 'Git Token' },
  { key: 'testUsername', label: '测试环境账号' },
  { key: 'testPassword', label: '测试环境密码' },
];

type BusyAction = 'login' | 'harness' | 'repository' | 'check' | 'password' | null;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [harness, setHarness] = useState<HarnessConfig>(DEFAULT_HARNESS);
  const [repository, setRepository] = useState<RepositoryConfig>(DEFAULT_REPOSITORY);
  const [checks, setChecks] = useState<ConnectivityCheck[]>([]);
  const [secretDraft, setSecretDraft] = useState<Record<SecretKey, string>>(emptySecretDraft());
  const [loginPassword, setLoginPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState<BusyAction>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const applyConfig = (next: ConfigResponse) => {
    setConfig(next);
    setHarness(next.harness);
    setRepository(next.repository);
  };

  const loadAuthenticatedData = async () => {
    const [nextConfig, nextChecks] = await Promise.all([
      requestJson<ConfigResponse>('/api/config'),
      requestJson<{ checks: ConnectivityCheck[] }>('/api/connectivity/checks'),
    ]);
    applyConfig(nextConfig);
    setChecks(nextChecks.checks);
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
    setChecks([]);
    setMessage('已退出登录');
  };

  const saveGroup = async (group: 'harness' | 'repository') => {
    setBusy(group);
    setError('');
    setMessage('');
    try {
      const payload =
        group === 'harness'
          ? { ...harness, secrets: pickSecretDraft('harness', secretDraft) }
          : { ...repository, secrets: pickSecretDraft('repository', secretDraft) };
      const next = await requestJson<ConfigResponse>(`/api/config/${group}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      applyConfig(next);
      setSecretDraft(emptySecretDraft());
      setMessage(group === 'harness' ? 'Harness 配置已保存' : '仓库与测试环境配置已保存');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '配置保存失败'));
    } finally {
      setBusy(null);
    }
  };

  const deleteSecret = async (secretKey: SecretKey) => {
    const field = SECRET_FIELDS.find((item) => item.key === secretKey);
    if (!window.confirm(`确定删除“${field?.label ?? secretKey}”吗？`)) {
      return;
    }
    setError('');
    try {
      const next = await requestJson<ConfigResponse>(
        `/api/secrets/${encodeURIComponent(secretKey)}`,
        { method: 'DELETE' },
      );
      applyConfig(next);
      setMessage('Secret 已删除');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, 'Secret 删除失败'));
    }
  };

  const runCheck = async () => {
    setBusy('check');
    setError('');
    try {
      const next = await requestJson<ConnectivityCheck>(
        '/api/connectivity/checks/test-environment-url',
        { method: 'POST' },
      );
      setChecks((current) => [...current.filter((item) => item.id !== next.id), next]);
      setMessage(next.result.message);
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '连通性检查失败'));
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('password');
    setError('');
    try {
      await requestJson('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfig(null);
      setChecks([]);
      setAuth({ configured: true, authenticated: false });
      setMessage('密码已修改，请使用新密码重新登录');
    } catch (cause: unknown) {
      setError(toUserMessage(cause, '密码修改失败'));
    } finally {
      setBusy(null);
    }
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
          <h2>安全配置</h2>
        </div>
        <button className="button button-ghost" type="button" onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>

      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      {!config.secretStore.available && (
        <p className="notice notice-warning">
          Secret Store 尚未配置主密钥。普通配置可保存，但保存 Secret 前请设置 LUOWANG_MASTER_KEY
          并重启服务。
        </p>
      )}

      <section className="panel" aria-labelledby="harness-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">HARNESS</p>
            <h2 id="harness-title">Harness 配置</h2>
          </div>
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void saveGroup('harness')}
          >
            {busy === 'harness' ? '保存中…' : '保存 Harness'}
          </button>
        </div>

        <div className="form-grid">
          <Field label="界面语言">
            <input
              value={harness.language}
              onChange={(event) =>
                setHarness((current) => ({ ...current, language: event.target.value }))
              }
            />
          </Field>
          <Field label="模型 Provider">
            <input
              value={harness.provider}
              onChange={(event) =>
                setHarness((current) => ({ ...current, provider: event.target.value }))
              }
              placeholder="例如 openai / deepseek"
            />
          </Field>
        </div>

        <h3>Agent 模型</h3>
        <div className="agent-grid">
          {(['main', 'runner', 'reviewer'] as const).map((role) => (
            <div className="subpanel" key={role}>
              <h4>{role === 'main' ? 'Main' : role === 'runner' ? 'Runner' : 'Reviewer'}</h4>
              <Field label="模型">
                <input
                  value={harness.agents[role].model}
                  onChange={(event) =>
                    setHarness((current) => ({
                      ...current,
                      agents: {
                        ...current.agents,
                        [role]: { ...current.agents[role], model: event.target.value },
                      },
                    }))
                  }
                />
              </Field>
              <Field label="Thinking">
                <select
                  value={harness.agents[role].thinking}
                  onChange={(event) =>
                    setHarness((current) => ({
                      ...current,
                      agents: {
                        ...current.agents,
                        [role]: {
                          ...current.agents[role],
                          thinking: event.target
                            .value as HarnessConfig['agents']['main']['thinking'],
                        },
                      },
                    }))
                  }
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </Field>
            </div>
          ))}
        </div>

        <h3>本地目录与 MCP</h3>
        <div className="form-grid">
          <Field label="Repository 目录">
            <input
              value={harness.local.repoDir}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  local: { ...current.local, repoDir: event.target.value },
                }))
              }
            />
          </Field>
          <Field label="Report 目录">
            <input
              value={harness.local.reportDir}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  local: { ...current.local, reportDir: event.target.value },
                }))
              }
            />
          </Field>
          <Field label="保留天数">
            <input
              type="number"
              min="0"
              value={harness.local.retentionDays}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  local: { ...current.local, retentionDays: Number(event.target.value) },
                }))
              }
            />
          </Field>
          <Field label="MCP 超时（毫秒）">
            <input
              type="number"
              min="100"
              value={harness.mcp.timeoutMs}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  mcp: { ...current.mcp, timeoutMs: Number(event.target.value) },
                }))
              }
            />
          </Field>
        </div>
        <div className="toggle-row">
          <label>
            <input
              type="checkbox"
              checked={harness.mcp.enabled}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  mcp: { ...current.mcp, enabled: event.target.checked },
                }))
              }
            />
            启用 Playwright MCP
          </label>
          <label>
            <input
              type="checkbox"
              checked={harness.mcp.headless}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  mcp: { ...current.mcp, headless: event.target.checked },
                }))
              }
            />
            Headless
          </label>
          <Field label="浏览器">
            <select
              value={harness.mcp.browser}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  mcp: {
                    ...current.mcp,
                    browser: event.target.value as HarnessConfig['mcp']['browser'],
                  },
                }))
              }
            >
              <option value="chromium">Chromium</option>
              <option value="firefox">Firefox</option>
              <option value="webkit">WebKit</option>
            </select>
          </Field>
        </div>

        <h3>OSS（S3-compatible）</h3>
        <div className="form-grid">
          <Field label="Endpoint">
            <input
              value={harness.oss.endpoint}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: { ...current.oss, endpoint: event.target.value },
                }))
              }
              placeholder="https://..."
            />
          </Field>
          <Field label="Region">
            <input
              value={harness.oss.region}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: { ...current.oss, region: event.target.value },
                }))
              }
            />
          </Field>
          <Field label="Bucket">
            <input
              value={harness.oss.bucket}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: { ...current.oss, bucket: event.target.value },
                }))
              }
            />
          </Field>
          <Field label="访问模式">
            <select
              value={harness.oss.accessMode}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: {
                    ...current.oss,
                    accessMode: event.target.value as HarnessConfig['oss']['accessMode'],
                  },
                }))
              }
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </Field>
          <Field label="Public Base URL">
            <input
              value={harness.oss.publicBaseUrl}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: { ...current.oss, publicBaseUrl: event.target.value },
                }))
              }
            />
          </Field>
          <Field label="Object Prefix">
            <input
              value={harness.oss.objectPrefix}
              onChange={(event) =>
                setHarness((current) => ({
                  ...current,
                  oss: { ...current.oss, objectPrefix: event.target.value },
                }))
              }
            />
          </Field>
        </div>
        <div className="secret-grid">
          <SecretField
            field={SECRET_FIELDS[0]}
            metadata={config.secrets.providerApiKey}
            value={secretDraft.providerApiKey}
            onChange={(value) =>
              setSecretDraft((current) => ({ ...current, providerApiKey: value }))
            }
            onDelete={() => void deleteSecret('providerApiKey')}
          />
          <SecretField
            field={SECRET_FIELDS[1]}
            metadata={config.secrets.ossAccessKeyId}
            value={secretDraft.ossAccessKeyId}
            onChange={(value) =>
              setSecretDraft((current) => ({ ...current, ossAccessKeyId: value }))
            }
            onDelete={() => void deleteSecret('ossAccessKeyId')}
          />
          <SecretField
            field={SECRET_FIELDS[2]}
            metadata={config.secrets.ossAccessKeySecret}
            value={secretDraft.ossAccessKeySecret}
            onChange={(value) =>
              setSecretDraft((current) => ({ ...current, ossAccessKeySecret: value }))
            }
            onDelete={() => void deleteSecret('ossAccessKeySecret')}
          />
        </div>
      </section>

      <section className="panel" aria-labelledby="repository-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">REPOSITORY & TEST ENVIRONMENT</p>
            <h2 id="repository-title">仓库与测试环境</h2>
          </div>
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void saveGroup('repository')}
          >
            {busy === 'repository' ? '保存中…' : '保存仓库配置'}
          </button>
        </div>
        <div className="form-grid">
          <Field label="目标仓库">
            <input
              value={repository.repository}
              onChange={(event) =>
                setRepository((current) => ({ ...current, repository: event.target.value }))
              }
              placeholder="https://github.com/org/repository"
            />
          </Field>
          <Field label="场景测试分支">
            <input
              value={repository.scenarioBranch}
              onChange={(event) =>
                setRepository((current) => ({ ...current, scenarioBranch: event.target.value }))
              }
            />
          </Field>
          <Field label="场景修改模式">
            <select
              value={repository.scenarioMode}
              onChange={(event) =>
                setRepository((current) => ({
                  ...current,
                  scenarioMode: event.target.value as RepositoryConfig['scenarioMode'],
                }))
              }
            >
              <option value="pr-required">PR required</option>
              <option value="add-only">Add only</option>
              <option value="autonomous">Autonomous</option>
            </select>
          </Field>
          <Field label="场景标签（逗号分隔）">
            <input
              value={repository.scenarioLabels.join(', ')}
              onChange={(event) =>
                setRepository((current) => ({
                  ...current,
                  scenarioLabels: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                }))
              }
            />
          </Field>
          <Field label="Poll 间隔（秒）">
            <input
              type="number"
              min="0"
              value={repository.pollIntervalSeconds}
              onChange={(event) =>
                setRepository((current) => ({
                  ...current,
                  pollIntervalSeconds: Number(event.target.value),
                }))
              }
            />
          </Field>
          <Field label="Cron">
            <input
              value={repository.cron}
              onChange={(event) =>
                setRepository((current) => ({ ...current, cron: event.target.value }))
              }
              placeholder="留空表示不启用"
            />
          </Field>
          <Field label="测试环境基础 URL">
            <input
              type="url"
              value={repository.baseUrl}
              onChange={(event) =>
                setRepository((current) => ({ ...current, baseUrl: event.target.value }))
              }
              placeholder="https://staging.example.test"
            />
          </Field>
        </div>
        <Field label="环境说明">
          <textarea
            rows={3}
            value={repository.environmentDescription}
            onChange={(event) =>
              setRepository((current) => ({
                ...current,
                environmentDescription: event.target.value,
              }))
            }
          />
        </Field>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={repository.triggerOnCommit}
            onChange={(event) =>
              setRepository((current) => ({ ...current, triggerOnCommit: event.target.checked }))
            }
          />
          启用 commit 触发
        </label>
        <div className="secret-grid">
          {SECRET_FIELDS.slice(3).map((field) => (
            <SecretField
              field={field}
              key={field.key}
              metadata={config.secrets[field.key]}
              value={secretDraft[field.key]}
              onChange={(value) =>
                setSecretDraft((current) => ({ ...current, [field.key]: value }))
              }
              onDelete={() => void deleteSecret(field.key)}
            />
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="checks-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CONNECTIVITY</p>
            <h2 id="checks-title">连通性检查</h2>
          </div>
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void runCheck()}
          >
            {busy === 'check' ? '检查中…' : '检查测试环境'}
          </button>
        </div>
        <CheckList checks={checks} />
      </section>

      <section className="panel" aria-labelledby="password-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ADMINISTRATOR</p>
            <h2 id="password-title">修改管理员密码</h2>
          </div>
        </div>
        <form className="password-form" onSubmit={(event) => void changePassword(event)}>
          <Field label="当前密码">
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="新密码（至少 12 个字符）">
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <button className="button" type="submit" disabled={busy !== null}>
            {busy === 'password' ? '修改中…' : '修改密码'}
          </button>
        </form>
      </section>
    </Shell>
  );
}

function Shell({ health, children }: { health: HealthResponse | null; children: ReactNode }) {
  const serviceStatus = health?.status === 'ok' ? 'ok' : health ? 'error' : 'loading';
  const databaseStatus = health?.database === 'ok' ? 'ok' : health ? 'error' : 'loading';
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
      {children}
      {health && (
        <section className="footer-meta">
          <span>版本 {health.version}</span>
          <span>最近检查 {formatDate(health.timestamp)}</span>
        </section>
      )}
    </main>
  );
}

function LoginPanel({
  configured,
  password,
  busy,
  message,
  error,
  onPasswordChange,
  onSubmit,
}: {
  configured: boolean;
  password: string;
  busy: boolean;
  message: string;
  error: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="panel login-panel" aria-labelledby="login-title">
      <p className="eyebrow">AUTHENTICATION</p>
      <h2 id="login-title">管理员登录</h2>
      {!configured && (
        <p className="notice notice-warning">
          尚未配置管理员初始密码。请通过 LUOWANG_ADMIN_PASSWORD
          设置长随机密码后重启服务；不会提供匿名设密入口。
        </p>
      )}
      {message && <p className="notice notice-success">{message}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      <form onSubmit={onSubmit}>
        <Field label="管理员密码">
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
        </Field>
        <button className="button" type="submit" disabled={busy || !configured}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SecretField({
  field,
  metadata,
  value,
  onChange,
  onDelete,
}: {
  field: { key: SecretKey; label: string };
  metadata: ConfigResponse['secrets'][SecretKey];
  value: string;
  onChange: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="secret-field">
      <Field label={field.label}>
        <input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={metadata.configured ? '已配置，留空保持不变' : '未配置'}
        />
      </Field>
      <div className="secret-status">
        <span>{metadata.configured ? metadata.masked : '未配置'}</span>
        {metadata.configured && (
          <button className="button-link danger" type="button" onClick={onDelete}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function CheckList({ checks }: { checks: ConnectivityCheck[] }) {
  return (
    <div className="check-list">
      {checks.map((check) => (
        <div className="check-item" key={check.id}>
          <div>
            <strong>{check.label}</strong>
            <p>{check.result.message}</p>
          </div>
          <div className={`check-status check-${check.result.status}`}>
            {checkStatusLabel(check.result.status)}
            {check.result.latencyMs !== null && <small>{check.result.latencyMs} ms</small>}
          </div>
        </div>
      ))}
      {checks.length === 0 && <p className="muted">暂无检查项</p>}
    </div>
  );
}

function StatusPill({ status }: { status: 'ok' | 'error' | 'loading' }) {
  const label = status === 'ok' ? '正常' : status === 'error' ? '异常' : '检查中';
  return <span className={`status-pill status-${status}`}>{label}</span>;
}

async function loadHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health');
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let payload: unknown = undefined;
  if (text !== '') {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const message =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : '请求失败';
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function emptySecretDraft(): Record<SecretKey, string> {
  return {
    providerApiKey: '',
    gitToken: '',
    testUsername: '',
    testPassword: '',
    ossAccessKeyId: '',
    ossAccessKeySecret: '',
  };
}

function pickSecretDraft(
  group: 'harness' | 'repository',
  draft: Record<SecretKey, string>,
): Partial<Record<SecretKey, string>> {
  const names =
    group === 'harness'
      ? ['providerApiKey', 'ossAccessKeyId', 'ossAccessKeySecret']
      : ['gitToken', 'testUsername', 'testPassword'];
  return Object.fromEntries(
    names
      .map((name) => [name, draft[name as SecretKey]])
      .filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Partial<Record<SecretKey, string>>;
}

function checkStatusLabel(status: ConnectivityCheck['result']['status']): string {
  switch (status) {
    case 'ok':
      return '可访问';
    case 'failed':
      return '服务错误';
    case 'timeout':
      return '超时';
    case 'unreachable':
      return '不可达';
    case 'not_checked':
      return '未检查';
    case 'not_configured':
      return '未配置';
    case 'not_available':
      return '尚未提供';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toUserMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }
  return cause instanceof Error ? cause.message : fallback;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
