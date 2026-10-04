import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type {
  HarnessConfig,
  ProviderInfo,
  ProviderModelInfo,
  SecretMetadata,
  ThinkingLevel,
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
];
type DeploymentSecret = 'providerApiKey' | 'ossAccessKeyId' | 'ossAccessKeySecret';
type DeploymentResponse = {
  configuration: HarnessConfig;
  secrets: Record<DeploymentSecret, SecretMetadata>;
};
type WorkspaceLock = {
  activeRuns: Array<{ runId: string | null; queueId: number }>;
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

  const lockRuns =
    resource.value?.workspace.activeRuns.map((item) => item.runId ?? `准备请求 ${item.queueId}`) ??
    [];
  const locked = lockRuns.length > 0;

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    if (!configuration || locked) return;
    setBusy('save');
    setMessage('');
    setError('');
    try {
      const preparedConfiguration =
        section === 'object-storage' ? normalizeOssConfiguration(configuration) : configuration;
      const response = await requestJson<{ configuration: HarnessConfig }>('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify(sectionPatch(section, preparedConfiguration)),
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
          setMessage('配置与 Provider API Key 已保存。');
        } catch (cause) {
          resource.reload();
          setError(`配置已保存；${toUserMessage(cause, 'Provider API Key 保存失败')}`);
        }
        return;
      }
      resource.reload();
      setMessage('配置已保存。');
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
      setMessage('凭据已更新。');
    } catch (cause) {
      setError(toUserMessage(cause, '凭据更新失败'));
    } finally {
      setBusy('');
    }
  }

  async function clearSecret(key: DeploymentSecret) {
    if (!window.confirm('确定清除该凭据吗？受影响的项目可能无法运行或归档。')) return;
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
            {resource.value && configuration && (
              <form className="settings-form" onSubmit={saveConfiguration}>
                <GlobalSection
                  section={section}
                  value={configuration}
                  disabled={Boolean(busy) || locked}
                  secretBusy={busy}
                  secretDraft={secretDraft}
                  secretMetadata={resource.value.deployment.secrets}
                  onChange={setDraft}
                  onSecretValue={(key, value) =>
                    setSecretDraft((current) => ({ ...current, [key]: value }))
                  }
                  onSaveSecret={(key) => void saveSecret(key)}
                  onClearSecret={(key) => void clearSecret(key)}
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
            )}
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
  onClearProviderApiKey,
}: {
  value: HarnessConfig;
  disabled: boolean;
  providerApiKey: string;
  providerApiKeyMetadata: SecretMetadata | undefined;
  onChange: (value: HarnessConfig) => void;
  onProviderApiKey: (value: string) => void;
  onClearProviderApiKey: () => void;
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
              aria-label="Provider Base URL"
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
              aria-label="Provider API Key"
              type="password"
              autoComplete="new-password"
              disabled={disabled}
              value={providerApiKey}
              onChange={(event) => onProviderApiKey(event.target.value)}
            />
          </Field>
          {providerApiKeyMetadata?.configured && (
            <div className="inline-actions">
              <button
                className="button"
                type="button"
                disabled={disabled}
                onClick={onClearProviderApiKey}
              >
                清除 Provider API Key
              </button>
            </div>
          )}
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
          const automaticThinking = selected
            ? role === 'main'
              ? `规划 ${relativeThinkingLevel(selected.thinkingLevels, 1)} · 收尾 ${relativeThinkingLevel(selected.thinkingLevels, 0)}`
              : relativeThinkingLevel(selected.thinkingLevels, role === 'runner' ? 0 : 1)
            : '选择目录中的模型后显示';
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
              <div className="adaptive-thinking">
                <span>Thinking 自动选择</span>
                <strong>{automaticThinking}</strong>
                <small>按模型实际支持的档位从低到高选择。</small>
              </div>
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
  secretBusy,
  secretDraft,
  secretMetadata,
  onChange,
  onSecretValue,
  onSaveSecret,
  onClearSecret,
}: {
  section: GlobalSettingSection;
  value: HarnessConfig;
  disabled: boolean;
  secretBusy: string;
  secretDraft: Partial<Record<DeploymentSecret, string>>;
  secretMetadata: Record<DeploymentSecret, SecretMetadata>;
  onChange: (value: HarnessConfig) => void;
  onSecretValue: (key: DeploymentSecret, value: string) => void;
  onSaveSecret: (key: DeploymentSecret) => void;
  onClearSecret: (key: DeploymentSecret) => void;
}) {
  const set = (patch: Partial<HarnessConfig>) => onChange({ ...value, ...patch });
  if (section === 'models')
    return (
      <ModelSettings
        value={value}
        disabled={disabled}
        providerApiKey={secretDraft.providerApiKey ?? ''}
        providerApiKeyMetadata={secretMetadata.providerApiKey}
        onChange={onChange}
        onProviderApiKey={(value) => onSecretValue('providerApiKey', value)}
        onClearProviderApiKey={() => onClearSecret('providerApiKey')}
      />
    );
  if (section === 'browser')
    return (
      <>
        <SectionTitle title="浏览器" />
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
        <SectionTitle title="对象存储" text="配置所有项目共用的 S3 兼容存储。" />
        <SettingsSubsection title="连接信息" text="完成连接所需的必填项。" />
        <div className="form-grid">
          <Field
            label={
              <HelpLabel
                label="Endpoint"
                help="对象存储服务地址，例如 https://s3.cn-east-1.jdcloud-oss.com；省略协议时自动使用 HTTPS。"
              />
            }
          >
            <input
              aria-label="Endpoint"
              disabled={disabled}
              placeholder="https://s3.example.com"
              value={value.oss.endpoint}
              onBlur={(event) =>
                set({
                  oss: { ...value.oss, endpoint: normalizeWebUrl(event.currentTarget.value) },
                })
              }
              onChange={(event) => set({ oss: { ...value.oss, endpoint: event.target.value } })}
            />
          </Field>
          <Field
            label={
              <HelpLabel label="Bucket" help="存放测试证据的 Bucket 名，例如 luowang-files。" />
            }
          >
            <input
              aria-label="Bucket"
              disabled={disabled}
              placeholder="luowang-files"
              value={value.oss.bucket}
              onChange={(event) => set({ oss: { ...value.oss, bucket: event.target.value } })}
            />
          </Field>
          <Field
            label={
              <HelpLabel label="Region" help="Bucket 所在区域，例如 cn-east-1 或 us-east-1。" />
            }
          >
            <input
              aria-label="Region"
              disabled={disabled}
              placeholder="cn-east-1"
              value={value.oss.region}
              onChange={(event) => set({ oss: { ...value.oss, region: event.target.value } })}
            />
          </Field>
          <Field
            label={
              <HelpLabel
                label="访问模式"
                help="private 由罗网鉴权读取证据；public 使用下方 Public URL 生成公开地址。"
              />
            }
          >
            <select
              aria-label="访问模式"
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
        <DeploymentSecrets
          title="访问凭据"
          keys={['ossAccessKeyId', 'ossAccessKeySecret']}
          metadata={secretMetadata}
          values={secretDraft}
          busy={secretBusy}
          onValue={onSecretValue}
          onSave={onSaveSecret}
          onClear={onClearSecret}
        />
        <SettingsSubsection
          title="高级选项"
          text="选填；只有公开访问或需要统一目录前缀时才配置。"
        />
        <div className="form-grid">
          <Field
            label={
              <HelpLabel
                label="Public URL"
                help="公开访问时的 Bucket 基础地址，例如 https://luowang-files.s3.cn-east-1.jdcloud-oss.com。"
              />
            }
          >
            <input
              aria-label="Public URL"
              disabled={disabled || value.oss.accessMode === 'private'}
              placeholder="https://bucket.s3.example.com"
              value={value.oss.publicBaseUrl}
              onBlur={(event) =>
                set({
                  oss: {
                    ...value.oss,
                    publicBaseUrl: normalizeWebUrl(event.currentTarget.value),
                  },
                })
              }
              onChange={(event) =>
                set({ oss: { ...value.oss, publicBaseUrl: event.target.value } })
              }
            />
          </Field>
          <Field
            label={
              <HelpLabel
                label="Object prefix"
                help="所有对象共享的可选目录前缀，例如 luowang；不要以斜杠开头。"
              />
            }
          >
            <input
              aria-label="Object prefix"
              disabled={disabled}
              placeholder="luowang"
              value={value.oss.objectPrefix}
              onChange={(event) => set({ oss: { ...value.oss, objectPrefix: event.target.value } })}
            />
          </Field>
        </div>
      </>
    );
  return (
    <>
      <SectionTitle title="本地数据" />
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

function DeploymentSecrets({
  title,
  keys,
  metadata,
  values,
  busy,
  onValue,
  onSave,
  onClear,
}: {
  title: string;
  keys: DeploymentSecret[];
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
      <SectionTitle title={title} text="凭据加密保存，不会回显或进入普通配置导出。" />
      <div className="secret-list">
        {keys.map((key) => (
          <article className="secret-row" key={key}>
            <div>
              <h3>{labels[key]}</h3>
              <StatusLabel tone={metadata[key]?.configured ? 'success' : 'warning'}>
                {metadata[key]?.configured ? `已配置 ${metadata[key].masked ?? ''}` : '未配置'}
              </StatusLabel>
            </div>
            <input
              className="secret-input"
              type="password"
              aria-label={`${metadata[key]?.configured ? '轮换' : '设置'}${labels[key]}`}
              autoComplete="new-password"
              placeholder={metadata[key]?.configured ? '输入新值以轮换' : '输入凭据'}
              value={values[key] ?? ''}
              onChange={(event) => onValue(key, event.target.value)}
            />
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
function SettingsSubsection({ title, text }: { title: string; text: string }) {
  return (
    <div className="settings-subsection-heading">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function HelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="field-label-with-help">
      {label}
      <span
        className="field-help"
        tabIndex={0}
        role="img"
        aria-label={`${label}说明：${help}`}
        title={help}
      >
        ?
      </span>
    </span>
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
function sectionPatch(section: GlobalSettingSection, value: HarnessConfig) {
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

function normalizeOssConfiguration(value: HarnessConfig): HarnessConfig {
  return {
    ...value,
    oss: {
      ...value.oss,
      endpoint: normalizeWebUrl(value.oss.endpoint),
      publicBaseUrl: normalizeWebUrl(value.oss.publicBaseUrl),
    },
  };
}

function normalizeWebUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function relativeThinkingLevel(levels: ThinkingLevel[], index: number): ThinkingLevel {
  return levels[Math.min(index, levels.length - 1)] ?? 'off';
}
