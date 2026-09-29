import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  HarnessConfig,
  ProviderInfo,
  ProviderModelInfo,
  SecretMetadata,
} from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { AppLink, useNavigationBlocker } from '../app/navigation';
import type { GlobalSettingSection } from '../app/route';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { Field, ModelCapabilities } from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';

const sections: Array<[GlobalSettingSection, string]> = [
  ['models', '模型与角色'],
  ['browser', '浏览器'],
  ['object-storage', '对象存储'],
  ['local-data', '本地数据'],
  ['credentials', '全局凭据'],
];
type DeploymentSecret = 'providerApiKey' | 'ossAccessKeyId' | 'ossAccessKeySecret';
type DeploymentResponse = {
  configuration: HarnessConfig;
  secrets: Record<DeploymentSecret, SecretMetadata>;
};
type WorkspaceLock = {
  activeRun: { runId: string } | null;
  queue: Array<{ runId: string | null; status: string }>;
};

export function GlobalSettingsPage({ section }: { section: GlobalSettingSection }) {
  const load = useCallback(async (signal: AbortSignal) => {
    const [deployment, workspace] = await Promise.all([
      requestJson<DeploymentResponse>('/api/deployment', { signal }),
      requestJson<WorkspaceLock>('/api/workspace', { signal }),
    ]);
    return { deployment, workspace };
  }, []);
  const resource = useResource('global-settings', load, (cause) =>
    toUserMessage(cause, '全局设置读取失败'),
  );
  const [draft, setDraft] = useState<HarnessConfig | null>(null);
  const [secretDraft, setSecretDraft] = useState<Partial<Record<DeploymentSecret, string>>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const source = resource.value?.deployment.configuration;
  const configuration = draft ?? source ?? null;
  const dirty = Boolean(
    source &&
    ((draft &&
      JSON.stringify(sectionValue(section, draft)) !==
        JSON.stringify(sectionValue(section, source))) ||
      Object.values(secretDraft).some(Boolean)),
  );
  const blocker = useCallback(() => {
    if (busy) return false;
    return !dirty || window.confirm('当前分组有未保存修改。要放弃修改并离开吗？');
  }, [busy, dirty]);
  useNavigationBlocker(dirty || Boolean(busy) ? blocker : null);

  useEffect(() => {
    setDraft(null);
    setSecretDraft({});
    setMessage('');
    setError('');
  }, [section]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);

  const lockRuns = [
    ...(resource.value?.workspace.activeRun ? [resource.value.workspace.activeRun.runId] : []),
    ...(resource.value?.workspace.queue
      .filter((item) => ['running', 'waiting_archive'].includes(item.status))
      .map((item) => item.runId)
      .filter((value): value is string => Boolean(value)) ?? []),
  ];
  const locked = lockRuns.length > 0 && section !== 'credentials';

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    if (!configuration || locked || section === 'credentials') return;
    setBusy('save');
    setMessage('');
    setError('');
    try {
      const response = await requestJson<{ configuration: HarnessConfig }>('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify(sectionPatch(section, configuration)),
      });
      setDraft(response.configuration);
      const apiKey = section === 'models' ? secretDraft.providerApiKey : undefined;
      if (apiKey) {
        try {
          await requestJson('/api/deployment/secrets/providerApiKey', {
            method: 'PUT',
            body: JSON.stringify({ value: apiKey }),
          });
          setSecretDraft((current) => ({ ...current, providerApiKey: '' }));
          resource.reload();
          setMessage('配置与 Provider API Key 已保存。保存不等于连接检查通过。');
        } catch (cause) {
          resource.reload();
          setError(`配置已保存；${toUserMessage(cause, 'Provider API Key 保存失败')}`);
        }
        return;
      }
      resource.reload();
      setMessage('配置已保存。保存不等于连接检查通过。');
    } catch (cause) {
      setError(toUserMessage(cause, '全局设置保存失败'));
    } finally {
      setBusy('');
    }
  }

  async function saveSecret(key: DeploymentSecret) {
    const value = secretDraft[key];
    if (!value) return;
    setBusy(key);
    setMessage('');
    setError('');
    try {
      await requestJson(`/api/deployment/secrets/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setSecretDraft((current) => ({ ...current, [key]: '' }));
      resource.reload();
      setMessage('凭据已更新。凭据不会回显；请另行执行连接检查。');
    } catch (cause) {
      setError(toUserMessage(cause, '凭据更新失败'));
    } finally {
      setBusy('');
    }
  }

  async function clearSecret(key: DeploymentSecret) {
    if (!window.confirm('确定清除该全局凭据吗？受影响的项目可能无法运行。')) return;
    setBusy(key);
    setMessage('');
    setError('');
    try {
      await requestJson(`/api/deployment/secrets/${key}`, { method: 'DELETE' });
      resource.reload();
      setMessage('凭据已清除。');
    } catch (cause) {
      setError(toUserMessage(cause, '凭据清除失败'));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="page-content global-settings-page">
      <PageHeading title="全局设置" scope="全局设置 · 影响全部项目" />
      <div className="page-body settings-layout">
        <nav className="settings-tabs" aria-label="全局设置分组">
          {sections.map(([key, label]) => (
            <AppLink
              key={key}
              to={{ name: 'global-settings', section: key }}
              current={key === section}
            >
              {label}
            </AppLink>
          ))}
        </nav>
        <div className="settings-main">
          {message && <p className="notice notice-success">{message}</p>}
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          {locked && (
            <p className="notice notice-warning">
              全局执行配置已锁定，相关测试记录：{[...new Set(lockRuns)].join('、')}
            </p>
          )}
          <AsyncRegion
            loading={resource.loading && !resource.value}
            error={!resource.value ? resource.error : ''}
            onRetry={resource.reload}
          >
            {resource.value &&
              configuration &&
              (section === 'credentials' ? (
                <CredentialsSection
                  metadata={resource.value.deployment.secrets}
                  values={secretDraft}
                  busy={busy}
                  onValue={(key, value) =>
                    setSecretDraft((current) => ({ ...current, [key]: value }))
                  }
                  onSave={(key) => void saveSecret(key)}
                  onClear={(key) => void clearSecret(key)}
                />
              ) : (
                <form className="settings-form" onSubmit={saveConfiguration}>
                  <GlobalSection
                    section={section}
                    value={configuration}
                    disabled={Boolean(busy) || locked}
                    providerApiKey={secretDraft.providerApiKey ?? ''}
                    providerApiKeyMetadata={resource.value.deployment.secrets.providerApiKey}
                    onChange={setDraft}
                    onProviderApiKey={(value) =>
                      setSecretDraft((current) => ({ ...current, providerApiKey: value }))
                    }
                  />
                  <div className="settings-actions">
                    <button
                      className="button button-primary"
                      type="submit"
                      disabled={Boolean(busy) || locked}
                    >
                      {busy ? '保存中…' : '保存本分组'}
                    </button>
                    {section !== 'local-data' && (
                      <AppLink className="text-link" to={{ name: 'system' }}>
                        查看最近连接状态
                      </AppLink>
                    )}
                  </div>
                </form>
              ))}
          </AsyncRegion>
        </div>
      </div>
    </section>
  );
}

function ModelSettings({
  value,
  disabled,
  providerApiKey,
  providerApiKeyMetadata,
  onChange,
  onProviderApiKey,
}: {
  value: HarnessConfig;
  disabled: boolean;
  providerApiKey: string;
  providerApiKeyMetadata: SecretMetadata | undefined;
  onChange: (value: HarnessConfig) => void;
  onProviderApiKey: (value: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerError, setProviderError] = useState('');
  const [catalog, setCatalog] = useState<{
    provider: string;
    models: ProviderModelInfo[];
    loading: boolean;
    error: string;
  }>({ provider: '', models: [], loading: false, error: '' });
  const provider = value.provider.trim();
  const models = catalog.provider === provider ? catalog.models : [];
  const loading = catalog.provider !== provider || catalog.loading;
  const set = (patch: Partial<HarnessConfig>) => onChange({ ...value, ...patch });
  const latestValue = useRef(value);
  latestValue.current = value;
  const latestChange = useRef(onChange);
  latestChange.current = onChange;

  // Switching providers replaces the base URL with the Pi catalog default (or empty).
  function applyProvider(next: string) {
    const selected = providers.find((item) => item.id === next.trim());
    set({ provider: next, providerBaseUrl: selected?.baseUrl ?? '' });
  }

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<{ providers: ProviderInfo[] }>('/api/provider/providers', {
      signal: controller.signal,
    })
      .then((response) => {
        setProviders(response.providers);
        const current = latestValue.current;
        const selected = response.providers.find((item) => item.id === current.provider.trim());
        if (selected?.baseUrl && current.providerBaseUrl === '') {
          latestChange.current({ ...current, providerBaseUrl: selected.baseUrl });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setProviderError(toUserMessage(cause, 'Provider 目录加载失败'));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!provider) {
      setCatalog({ provider, models: [], loading: false, error: '' });
      return;
    }
    const controller = new AbortController();
    setCatalog({ provider, models: [], loading: true, error: '' });
    const timer = window.setTimeout(() => {
      void requestJson<{ models: ProviderModelInfo[] }>(
        `/api/provider/models?provider=${encodeURIComponent(provider)}`,
        { signal: controller.signal },
      )
        .then((response) =>
          setCatalog({ provider, models: response.models, loading: false, error: '' }),
        )
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setCatalog({
              provider,
              models: [],
              loading: false,
              error: toUserMessage(cause, '模型目录加载失败'),
            });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [provider]);

  const catalogStatus = loading
    ? '正在加载已知模型目录…'
    : catalog.error
      ? `目录加载失败：${catalog.error}`
      : models.length > 0
        ? `已载入 ${models.length} 个已知模型`
        : provider
          ? '暂无已知模型'
          : '';

  return (
    <>
      <SectionTitle title="模型与角色" />
      <div className="form-grid">
        <div className="model-service-fields">
          <Field label="Provider">
            <input
              list="global-provider-catalog"
              disabled={disabled}
              value={value.provider}
              onChange={(event) => applyProvider(event.target.value)}
            />
          </Field>
          <datalist id="global-provider-catalog">
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
          <Field label="Provider Base URL">
            <input
              disabled={disabled}
              value={value.providerBaseUrl}
              onChange={(event) => set({ providerBaseUrl: event.target.value })}
            />
          </Field>
          <Field
            label="Provider API Key"
            hint={
              providerApiKeyMetadata?.configured
                ? `已配置 ${providerApiKeyMetadata.masked ?? ''}`
                : '未配置'
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              disabled={disabled}
              value={providerApiKey}
              onChange={(event) => onProviderApiKey(event.target.value)}
            />
          </Field>
        </div>
        {providerError && <p className="notice notice-warning">{providerError}</p>}
        {catalogStatus && (
          <p className="catalog-summary" role="status">
            {catalogStatus}
          </p>
        )}
        {(['main', 'runner', 'reviewer'] as const).map((role) => {
          const selected = models.find((item) => item.id === value.agents[role].model);
          const reviewerWarning =
            role === 'reviewer' && value.agents.reviewer.model.trim() && !loading
              ? selected
                ? selected.input.some((item) => item.toLowerCase() === 'image')
                  ? undefined
                  : '该模型不支持图像输入，视觉场景将被阻塞。'
                : '未匹配到当前 Provider 的视觉模型，无法确认截图审核能力。'
              : undefined;
          const listId = `global-model-catalog-${role}`;
          return (
            <div className="agent-config" key={role}>
              <h3>
                {role === 'main'
                  ? 'Main（含 Final Main）'
                  : role === 'runner'
                    ? 'Runner'
                    : 'Reviewer（需要视觉）'}
              </h3>
              <Field label="模型" error={reviewerWarning}>
                <input
                  type="search"
                  list={listId}
                  disabled={disabled}
                  value={value.agents[role].model}
                  onChange={(event) =>
                    set({
                      agents: {
                        ...value.agents,
                        [role]: { ...value.agents[role], model: event.target.value },
                      },
                    })
                  }
                />
              </Field>
              <datalist id={listId}>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.input.includes('image') ? '视觉' : '文本'}
                    {item.reasoning ? ' · 推理' : ''}
                  </option>
                ))}
              </datalist>
              {selected && (
                <div className="model-meta">
                  <ModelCapabilities model={selected} />
                  <small>{selected.name}</small>
                </div>
              )}
              <Field label="Thinking">
                <select
                  disabled={disabled}
                  value={value.agents[role].thinking}
                  onChange={(event) =>
                    set({
                      agents: {
                        ...value.agents,
                        [role]: {
                          ...value.agents[role],
                          thinking: event.target
                            .value as HarnessConfig['agents'][typeof role]['thinking'],
                        },
                      },
                    })
                  }
                >
                  {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </Field>
            </div>
          );
        })}
      </div>
    </>
  );
}

function GlobalSection({
  section,
  value,
  disabled,
  providerApiKey,
  providerApiKeyMetadata,
  onChange,
  onProviderApiKey,
}: {
  section: Exclude<GlobalSettingSection, 'credentials'>;
  value: HarnessConfig;
  disabled: boolean;
  providerApiKey: string;
  providerApiKeyMetadata: SecretMetadata | undefined;
  onChange: (value: HarnessConfig) => void;
  onProviderApiKey: (value: string) => void;
}) {
  const set = (patch: Partial<HarnessConfig>) => onChange({ ...value, ...patch });
  if (section === 'models')
    return (
      <ModelSettings
        value={value}
        disabled={disabled}
        providerApiKey={providerApiKey}
        providerApiKeyMetadata={providerApiKeyMetadata}
        onChange={onChange}
        onProviderApiKey={onProviderApiKey}
      />
    );
  if (section === 'browser')
    return (
      <>
        <SectionTitle title="浏览器" text="保存配置不会自动启动浏览器或执行检查。" />
        <div className="form-grid">
          <Check
            label="启用浏览器 MCP"
            checked={value.mcp.enabled}
            disabled={disabled}
            onChange={(checked) => set({ mcp: { ...value.mcp, enabled: checked } })}
          />
          <Field label="浏览器">
            <select
              disabled={disabled}
              value={value.mcp.browser}
              onChange={(event) =>
                set({
                  mcp: {
                    ...value.mcp,
                    browser: event.target.value as HarnessConfig['mcp']['browser'],
                  },
                })
              }
            >
              <option>chromium</option>
              <option>firefox</option>
              <option>webkit</option>
            </select>
          </Field>
          <Check
            label="Headless"
            checked={value.mcp.headless}
            disabled={disabled}
            onChange={(checked) => set({ mcp: { ...value.mcp, headless: checked } })}
          />
          <Field label="超时（毫秒）">
            <input
              type="number"
              min="100"
              max="300000"
              disabled={disabled}
              value={value.mcp.timeoutMs}
              onChange={(event) =>
                set({ mcp: { ...value.mcp, timeoutMs: Number(event.target.value) } })
              }
            />
          </Field>
        </div>
      </>
    );
  if (section === 'object-storage')
    return (
      <>
        <SectionTitle
          title="对象存储"
          text="已有历史证据时，后端会阻止破坏旧证据地址的原位修改。"
        />
        <div className="form-grid">
          {(
            [
              ['endpoint', 'Endpoint'],
              ['region', 'Region'],
              ['bucket', 'Bucket'],
              ['publicBaseUrl', 'Public URL'],
              ['objectPrefix', 'Object prefix'],
            ] as const
          ).map(([key, label]) => (
            <Field label={label} key={key}>
              <input
                disabled={disabled}
                value={value.oss[key]}
                onChange={(event) => set({ oss: { ...value.oss, [key]: event.target.value } })}
              />
            </Field>
          ))}
          <Field label="访问模式">
            <select
              disabled={disabled}
              value={value.oss.accessMode}
              onChange={(event) =>
                set({
                  oss: { ...value.oss, accessMode: event.target.value as 'public' | 'private' },
                })
              }
            >
              <option value="public">public</option>
              <option value="private">private</option>
            </select>
          </Field>
        </div>
      </>
    );
  return (
    <>
      <SectionTitle title="本地数据" text="受控根目录只读，不能在网页中输入任意本机路径。" />
      <dl className="fact-list">
        <Fact label="受控仓库目录" value={value.local.repoDir} />
        <Fact label="报告目录" value={value.local.reportDir} />
      </dl>
      <Field label="保留天数">
        <input
          type="number"
          min="0"
          max="36500"
          disabled={disabled}
          value={value.local.retentionDays}
          onChange={(event) =>
            set({ local: { ...value.local, retentionDays: Number(event.target.value) } })
          }
        />
      </Field>
      <p className="muted-copy">清理与占用只展示可确认事实；保存保留天数不会立即执行清理。</p>
    </>
  );
}

function CredentialsSection({
  metadata,
  values,
  busy,
  onValue,
  onSave,
  onClear,
}: {
  metadata: Record<DeploymentSecret, SecretMetadata>;
  values: Partial<Record<DeploymentSecret, string>>;
  busy: string;
  onValue: (key: DeploymentSecret, value: string) => void;
  onSave: (key: DeploymentSecret) => void;
  onClear: (key: DeploymentSecret) => void;
}) {
  const labels: Record<DeploymentSecret, string> = {
    providerApiKey: 'Provider API Key',
    ossAccessKeyId: 'OSS Access Key ID',
    ossAccessKeySecret: 'OSS Access Key Secret',
  };
  return (
    <section>
      <SectionTitle
        title="全局凭据"
        text="只包含部署级 Provider 与 OSS 凭据；项目级凭据不在这里。"
      />
      <div className="secret-list">
        {(Object.keys(labels) as DeploymentSecret[]).map((key) => (
          <article className="secret-row" key={key}>
            <div>
              <h3>{labels[key]}</h3>
              <StatusLabel tone={metadata[key]?.configured ? 'success' : 'warning'}>
                {metadata[key]?.configured ? `已配置 ${metadata[key].masked ?? ''}` : '未配置'}
              </StatusLabel>
            </div>
            <Field label="新值（不会回显）">
              <input
                type="password"
                autoComplete="new-password"
                value={values[key] ?? ''}
                onChange={(event) => onValue(key, event.target.value)}
              />
            </Field>
            <div className="inline-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={Boolean(busy) || !values[key]}
                onClick={() => onSave(key)}
              >
                {metadata[key]?.configured ? '轮换' : '保存'}
              </button>
              {metadata[key]?.configured && (
                <button
                  className="button"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => onClear(key)}
                >
                  清除
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function SectionTitle({ title, text }: { title: string; text?: string }) {
  return (
    <div className="settings-section-heading">
      <h2>{title}</h2>
      {text && <p>{text}</p>}
    </div>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="mono-value">{value}</dd>
    </div>
  );
}
function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
function sectionValue(section: GlobalSettingSection, value: HarnessConfig) {
  if (section === 'models')
    return {
      provider: value.provider,
      providerBaseUrl: value.providerBaseUrl,
      agents: value.agents,
    };
  if (section === 'browser') return value.mcp;
  if (section === 'object-storage') return value.oss;
  if (section === 'local-data') return value.local.retentionDays;
  return null;
}
function sectionPatch(section: Exclude<GlobalSettingSection, 'credentials'>, value: HarnessConfig) {
  if (section === 'models')
    return {
      provider: value.provider,
      providerBaseUrl: value.providerBaseUrl,
      agents: value.agents,
    };
  if (section === 'browser') return { mcp: value.mcp };
  if (section === 'object-storage') return { oss: value.oss };
  return { local: { retentionDays: value.local.retentionDays } };
}
