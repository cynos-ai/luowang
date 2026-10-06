import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type {
  HarnessConfig,
  ModelProviderSource,
  ProviderInfo,
  SecretMetadata,
  ThinkingLevel,
} from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { AppLink, useNavigationBlocker } from '../app/navigation';
import type { GlobalSettingSection } from '../app/route';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { useAppDialog } from '../components/AppDialogProvider';
import { useAppMessage } from '../components/AppMessageProvider';
import {
  ComboBox,
  Field,
  HelpLabel,
  ModelCapabilities,
  NumberInput,
  SelectBox,
} from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';
import {
  globalSettingSectionPatch,
  globalSettingSectionValue,
  withoutModelProviderSource,
} from './global-settings-section';
import { ConnectionResourcesSettings } from './ConnectionResourcesSettings';
import { SystemSettingsPage } from './SystemSettingsPage';

const sections: Array<[GlobalSettingSection, string]> = [
  ['models', '模型与角色'],
  ['system', '系统设置'],
  ['github', 'GitHub'],
  ['servers', '执行服务器'],
  ['browser', '浏览器工具'],
  ['object-storage', '对象存储'],
  ['local-data', '本地数据'],
];
type DeploymentSecret = 'providerApiKey' | 'ossAccessKeyId' | 'ossAccessKeySecret';
type DeploymentResponse = {
  configuration: HarnessConfig;
  secrets: Record<DeploymentSecret, SecretMetadata>;
  providerSecrets: Record<string, SecretMetadata>;
};
type WorkspaceLock = {
  activeRuns: Array<{ runId: string | null; queueId: number }>;
};

export function GlobalSettingsPage({
  section,
  onPasswordChanged,
}: {
  section: GlobalSettingSection;
  onPasswordChanged: () => void;
}) {
  if (section === 'system') {
    return (
      <GlobalSettingsLayout section={section}>
        <SystemSettingsPage onPasswordChanged={onPasswordChanged} />
      </GlobalSettingsLayout>
    );
  }
  if (section === 'github' || section === 'servers') {
    return (
      <GlobalSettingsLayout section={section}>
        <ConnectionResourcesSettings kind={section} />
      </GlobalSettingsLayout>
    );
  }
  return <DeploymentSettingsPage section={section} />;
}

function DeploymentSettingsPage({
  section,
}: {
  section: Exclude<GlobalSettingSection, 'system' | 'github' | 'servers'>;
}) {
  const { confirm } = useAppDialog();
  const notify = useAppMessage();
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
  const [providerSecretDraft, setProviderSecretDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const source = resource.value?.deployment.configuration;
  const configuration = draft ?? source ?? null;
  const dirty = Boolean(
    source &&
    ((draft &&
      JSON.stringify(globalSettingSectionValue(section, draft)) !==
        JSON.stringify(globalSettingSectionValue(section, source))) ||
      Object.values(secretDraft).some(Boolean) ||
      Object.values(providerSecretDraft).some(Boolean)),
  );
  const blocker = useCallback(() => {
    if (busy) return false;
    if (!dirty) return null;
    return {
      title: '放弃未保存修改？',
      message: '当前分组的修改尚未保存。离开后，这些修改将丢失。',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      danger: true,
    };
  }, [busy, dirty]);
  useNavigationBlocker(dirty || Boolean(busy) ? blocker : null);

  useEffect(() => {
    setDraft(null);
    setSecretDraft({});
    setProviderSecretDraft({});
  }, [section]);
  const lockRuns =
    resource.value?.workspace.activeRuns.map((item) => item.runId ?? `准备请求 ${item.queueId}`) ??
    [];
  const locked = lockRuns.length > 0;

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault();
    if (!configuration || locked) return;
    setBusy('save');
    try {
      const preparedConfiguration =
        section === 'object-storage' ? normalizeOssConfiguration(configuration) : configuration;
      const response = await requestJson<{ configuration: HarnessConfig }>('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify(globalSettingSectionPatch(section, preparedConfiguration)),
      });
      setDraft(response.configuration);
      if (section === 'models') {
        for (const [sourceId, apiKey] of Object.entries(providerSecretDraft)) {
          if (!apiKey) continue;
          await requestJson(`/api/provider/sources/${encodeURIComponent(sourceId)}/secret`, {
            method: 'PUT',
            body: JSON.stringify({ value: apiKey }),
          });
        }
        setProviderSecretDraft({});
      }
      resource.reload();
      notify.success('配置已保存');
    } catch (cause) {
      notify.error(toUserMessage(cause, '全局设置保存失败'));
    } finally {
      setBusy('');
    }
  }

  async function saveSecret(key: DeploymentSecret) {
    const value = secretDraft[key];
    if (!value) return;
    setBusy(key);
    try {
      await requestJson(`/api/deployment/secrets/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setSecretDraft((current) => ({ ...current, [key]: '' }));
      resource.reload();
      notify.success('凭据已更新');
    } catch (cause) {
      notify.error(toUserMessage(cause, '凭据更新失败'));
    } finally {
      setBusy('');
    }
  }

  async function clearSecret(key: DeploymentSecret) {
    if (
      !(await confirm({
        title: '清除凭据？',
        message: '受影响的项目可能无法运行或归档，原值无法恢复。',
        confirmLabel: '确认清除',
        cancelLabel: '取消',
        danger: true,
      }))
    )
      return;
    setBusy(key);
    try {
      await requestJson(`/api/deployment/secrets/${key}`, { method: 'DELETE' });
      resource.reload();
      notify.success('凭据已清除');
    } catch (cause) {
      notify.error(toUserMessage(cause, '凭据清除失败'));
    } finally {
      setBusy('');
    }
  }

  async function verifyProviderSource(sourceId: string) {
    if (!configuration || locked) return;
    setBusy(`verify:${sourceId}`);
    try {
      await requestJson('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify(globalSettingSectionPatch('models', configuration)),
      });
      const apiKey = providerSecretDraft[sourceId];
      if (apiKey) {
        await requestJson(`/api/provider/sources/${encodeURIComponent(sourceId)}/secret`, {
          method: 'PUT',
          body: JSON.stringify({ value: apiKey }),
        });
        setProviderSecretDraft((current) => ({ ...current, [sourceId]: '' }));
      }
      const response = await requestJson<{ configuration: HarnessConfig }>(
        `/api/provider/sources/${encodeURIComponent(sourceId)}/verify`,
        { method: 'POST' },
      );
      setDraft(response.configuration);
      resource.reload();
      notify.success('模型来源验证通过，模型目录已更新');
    } catch (cause) {
      notify.error(toUserMessage(cause, '模型来源验证失败'));
    } finally {
      setBusy('');
    }
  }

  async function removeProviderSource(sourceId: string, sourceLabel: string) {
    if (!configuration || locked) return;
    if (
      !(await confirm({
        title: `删除“${sourceLabel}”？`,
        message:
          '将同时删除该来源的 API Key，并清空使用它的角色模型。已保存来源会立即保存当前模型与角色配置，此操作无法恢复。',
        confirmLabel: '确认删除',
        cancelLabel: '取消',
        danger: true,
      }))
    )
      return;

    const next = withoutModelProviderSource(configuration, sourceId);
    setProviderSecretDraft((current) => {
      const copy = { ...current };
      delete copy[sourceId];
      return copy;
    });
    const persisted = source?.modelProviders.some((item) => item.id === sourceId);
    if (!persisted) {
      setDraft(next);
      notify.info('未保存的模型来源已移除');
      return;
    }

    setBusy(`delete:${sourceId}`);
    try {
      const response = await requestJson<{ configuration: HarnessConfig }>('/api/deployment', {
        method: 'PUT',
        body: JSON.stringify(globalSettingSectionPatch('models', next)),
      });
      setDraft(response.configuration);
      resource.reload();
      notify.success(`模型来源“${sourceLabel}”已删除`);
    } catch (cause) {
      notify.error(toUserMessage(cause, '模型来源删除失败'));
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
              <form
                className={`settings-form${section === 'models' ? ' model-settings-form' : ''}`}
                onSubmit={saveConfiguration}
              >
                <GlobalSection
                  section={section}
                  value={configuration}
                  disabled={Boolean(busy) || locked}
                  secretBusy={busy}
                  secretDraft={secretDraft}
                  secretMetadata={resource.value.deployment.secrets}
                  providerSecretDraft={providerSecretDraft}
                  providerSecretMetadata={resource.value.deployment.providerSecrets ?? {}}
                  onChange={setDraft}
                  onSecretValue={(key, value) =>
                    setSecretDraft((current) => ({ ...current, [key]: value }))
                  }
                  onSaveSecret={(key) => void saveSecret(key)}
                  onClearSecret={(key) => void clearSecret(key)}
                  onProviderSecretValue={(sourceId, value) =>
                    setProviderSecretDraft((current) => ({ ...current, [sourceId]: value }))
                  }
                  onVerifyProviderSource={(sourceId) => void verifyProviderSource(sourceId)}
                  onRemoveProviderSource={(sourceId, sourceLabel) =>
                    void removeProviderSource(sourceId, sourceLabel)
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
                </div>
              </form>
            )}
          </AsyncRegion>
        </div>
      </div>
    </section>
  );
}

function GlobalSettingsLayout({
  section,
  children,
}: {
  section: GlobalSettingSection;
  children: ReactNode;
}) {
  return (
    <section className="page-content global-settings-page">
      <PageHeading title="全局设置" />
      <div className="page-body settings-layout">
        <nav className="settings-tabs" aria-label="全局设置分组">
          {sections.map(([key, label]) => (
            <AppLink
              key={key}
              to={{ name: 'global-settings', section: key }}
              current={section === key}
            >
              {label}
            </AppLink>
          ))}
        </nav>
        <div className="settings-main">{children}</div>
      </div>
    </section>
  );
}

function ModelSettings({
  value,
  disabled,
  busy,
  providerSecretDraft,
  providerSecretMetadata,
  onChange,
  onProviderSecretValue,
  onVerifyProviderSource,
  onRemoveProviderSource,
}: {
  value: HarnessConfig;
  disabled: boolean;
  busy: string;
  providerSecretDraft: Record<string, string>;
  providerSecretMetadata: Record<string, SecretMetadata>;
  onChange: (value: HarnessConfig) => void;
  onProviderSecretValue: (sourceId: string, value: string) => void;
  onVerifyProviderSource: (sourceId: string) => void;
  onRemoveProviderSource: (sourceId: string, sourceLabel: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerError, setProviderError] = useState('');
  const set = (patch: Partial<HarnessConfig>) => onChange({ ...value, ...patch });
  const sources =
    value.modelProviders ??
    (value.provider
      ? [
          {
            id: 'default',
            name: value.provider,
            provider: value.provider,
            baseUrl: value.providerBaseUrl,
            verifiedAt: null,
            models: [],
          },
        ]
      : []);

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<{ providers: ProviderInfo[] }>('/api/provider/providers', {
      signal: controller.signal,
    })
      .then((response) => setProviders(response.providers))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setProviderError(toUserMessage(cause, 'Provider 目录加载失败'));
      });
    return () => controller.abort();
  }, []);

  const providerOptions = providers.map((item) => ({
    value: item.id,
    label: item.name,
    detail: item.id === item.name ? undefined : item.id,
  }));
  const verifiedModels = sources.flatMap((source) =>
    source.verifiedAt
      ? source.models.map((model) => ({ source, model, value: modelValue(source.id, model.id) }))
      : [],
  );

  function updateSource(sourceId: string, patch: Partial<ModelProviderSource>) {
    const nextSources = sources.map((source) => {
      if (source.id !== sourceId) return source;
      const connectionChanged =
        (patch.provider !== undefined && patch.provider !== source.provider) ||
        (patch.baseUrl !== undefined && patch.baseUrl !== source.baseUrl);
      return {
        ...source,
        ...patch,
        ...(connectionChanged ? { verifiedAt: null, models: [] } : {}),
      };
    });
    set({
      modelProviders: nextSources,
      provider: nextSources[0]?.provider ?? '',
      providerBaseUrl: nextSources[0]?.baseUrl ?? '',
    });
  }

  function addSource() {
    const id = `source-${Date.now().toString(36)}`;
    const firstProvider = providers[0];
    set({
      modelProviders: [
        ...sources,
        {
          id,
          name: firstProvider?.name ?? firstProvider?.id ?? '',
          provider: firstProvider?.id ?? '',
          baseUrl: firstProvider?.baseUrl ?? '',
          verifiedAt: null,
          models: [],
        },
      ],
    });
  }

  const roleNames = {
    main: '测试组长',
    runner: '测试工程师',
    reviewer: '质量审核员',
  } as const;

  return (
    <div className="model-settings-sections">
      <section className="content-block" aria-labelledby="provider-settings-title">
        <div className="content-block-heading">
          <h2 id="provider-settings-title">模型配置</h2>
          <button
            className="button button-secondary button-compact"
            type="button"
            disabled={disabled}
            onClick={addSource}
          >
            模型注册
          </button>
        </div>
        <div className="provider-source-list">
          {sources.map((source) => {
            const metadata = providerSecretMetadata[source.id];
            const sourceBusy = busy.endsWith(`:${source.id}`);
            const sourceLabel = providerSourceLabel(source, providers);
            return (
              <article className="provider-source-card" key={source.id}>
                <div className="provider-source-card-heading">
                  <strong>{sourceLabel}</strong>
                  <span
                    className={`source-status ${source.verifiedAt ? 'is-verified' : ''}`}
                    role="status"
                  >
                    {source.verifiedAt ? '已验证' : '待验证'}
                  </span>
                </div>
                {metadata?.configured ? (
                  <dl className="provider-source-summary">
                    <div>
                      <dt>Provider</dt>
                      <dd>{source.provider}</dd>
                    </div>
                    <div>
                      <dt>Base URL</dt>
                      <dd>{source.baseUrl || '默认地址'}</dd>
                    </div>
                  </dl>
                ) : (
                  <div className="model-service-fields">
                    <Field label="Provider">
                      <ComboBox
                        ariaLabel={`${sourceLabel} Provider`}
                        disabled={disabled}
                        value={source.provider}
                        options={providerOptions}
                        onChange={(next) => {
                          const selected = providers.find((item) => item.id === next.trim());
                          updateSource(source.id, {
                            provider: next,
                            name: selected?.name ?? next,
                            baseUrl: selected?.baseUrl ?? '',
                          });
                        }}
                      />
                    </Field>
                    <Field label="Base URL">
                      <input
                        aria-label={`${sourceLabel} Base URL`}
                        disabled={disabled}
                        value={source.baseUrl}
                        onChange={(event) =>
                          updateSource(source.id, { baseUrl: event.target.value })
                        }
                      />
                    </Field>
                    <div className="secret-inline-field">
                      <Field label="API Key">
                        <input
                          aria-label={`${sourceLabel} API Key`}
                          type="password"
                          autoComplete="new-password"
                          disabled={disabled}
                          placeholder="输入凭据"
                          value={providerSecretDraft[source.id] ?? ''}
                          onChange={(event) => onProviderSecretValue(source.id, event.target.value)}
                        />
                      </Field>
                    </div>
                  </div>
                )}
                <div className="provider-source-actions">
                  {!source.verifiedAt && (
                    <button
                      className="button button-secondary button-compact"
                      type="button"
                      disabled={disabled || !source.provider || sourceBusy}
                      onClick={() => onVerifyProviderSource(source.id)}
                    >
                      {sourceBusy ? '验证中…' : '验证并读取模型'}
                    </button>
                  )}
                  <button
                    className="button button-ghost button-compact"
                    type="button"
                    disabled={disabled}
                    onClick={() => onRemoveProviderSource(source.id, sourceLabel)}
                  >
                    删除来源
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {sources.length === 0 && (
          <button className="button button-secondary" type="button" onClick={addSource}>
            注册第一个模型
          </button>
        )}
        {providerError && <p className="notice notice-warning">{providerError}</p>}
      </section>
      <section className="content-block" aria-labelledby="agent-settings-title">
        <div className="content-block-heading">
          <h2 id="agent-settings-title">角色配置</h2>
        </div>
        <div className="agent-config-grid">
          {(['main', 'runner', 'reviewer'] as const).map((role) => {
            const sourceId = effectiveSourceId(value, role);
            const selected = verifiedModels.find(
              (item) => item.source.id === sourceId && item.model.id === value.agents[role].model,
            );
            const reviewerWarning =
              role === 'reviewer' && value.agents.reviewer.model.trim()
                ? selected
                  ? selected.model.input.some((item) => item.toLowerCase() === 'image')
                    ? undefined
                    : '该模型不支持图像输入，视觉场景将被阻塞。'
                  : '当前模型来源尚未验证，无法确认截图审核能力。'
                : undefined;
            const thinkingLevels = selected?.model.thinkingLevels.length
              ? selected.model.thinkingLevels
              : [value.agents[role].thinking];
            const modelOptions = verifiedModels
              .filter(
                (item) =>
                  role !== 'reviewer' ||
                  item.model.input.some((input) => input.toLowerCase() === 'image'),
              )
              .map((item) => ({
                value: item.value,
                label: item.model.name,
                detail: `${providerSourceLabel(item.source, providers)} · ${item.model.input.includes('image') ? '视觉' : '文本'}${item.model.reasoning ? ' · 推理' : ''}`,
              }));
            return (
              <div className="agent-config" key={role}>
                <h3>
                  {roleNames[role]}
                  {role === 'reviewer' && (
                    <span
                      className="field-help"
                      tabIndex={0}
                      role="img"
                      aria-label="质量审核员模型要求：需要支持图像输入，用于审核截图证据。"
                      title="需要支持图像输入，用于审核截图证据。"
                    >
                      ?
                    </span>
                  )}
                </h3>
                <Field label="模型" error={reviewerWarning}>
                  <ComboBox
                    ariaLabel={`${roleNames[role]}模型`}
                    disabled={disabled || modelOptions.length === 0}
                    value={modelValue(sourceId, value.agents[role].model)}
                    displayValue={selected?.model.name ?? value.agents[role].model}
                    allowCustom={false}
                    options={modelOptions}
                    onChange={(next) => {
                      const parsed = parseModelValue(next);
                      const item = verifiedModels.find(
                        (candidate) =>
                          candidate.source.id === parsed.sourceId &&
                          candidate.model.id === parsed.modelId,
                      );
                      if (!item) return;
                      const thinking = item.model.thinkingLevels.length
                        ? relativeThinkingLevel(
                            item.model.thinkingLevels,
                            role === 'runner' ? 0 : 1,
                          )
                        : value.agents[role].thinking;
                      set({
                        agents: {
                          ...value.agents,
                          [role]: {
                            providerSourceId: item.source.id,
                            model: item.model.id,
                            thinking,
                          },
                        },
                      });
                    }}
                  />
                </Field>
                {selected && (
                  <div className="model-meta">
                    <ModelCapabilities model={selected.model} />
                  </div>
                )}
                <Field label="思考等级">
                  <SelectBox
                    ariaLabel={`${roleNames[role]}思考等级`}
                    disabled={disabled || !selected}
                    value={
                      thinkingLevels.includes(value.agents[role].thinking)
                        ? value.agents[role].thinking
                        : thinkingLevels[
                            role === 'runner' ? 0 : Math.min(1, thinkingLevels.length - 1)
                          ]
                    }
                    options={thinkingLevels.map((level) => ({ value: level, label: level }))}
                    onChange={(thinking) =>
                      set({
                        agents: {
                          ...value.agents,
                          [role]: {
                            ...value.agents[role],
                            providerSourceId: sourceId,
                            thinking: thinking as ThinkingLevel,
                          },
                        },
                      })
                    }
                  />
                </Field>
              </div>
            );
          })}
        </div>
        {verifiedModels.length === 0 && (
          <p className="catalog-state" role="status">
            验证模型来源后即可为角色选择模型。
          </p>
        )}
      </section>
    </div>
  );
}

function modelValue(sourceId: string, modelId: string): string {
  return sourceId && modelId ? `${sourceId}::${modelId}` : '';
}

function parseModelValue(value: string): { sourceId: string; modelId: string } {
  const split = value.indexOf('::');
  return split < 0
    ? { sourceId: '', modelId: value }
    : { sourceId: value.slice(0, split), modelId: value.slice(split + 2) };
}

function effectiveSourceId(value: HarnessConfig, role: 'main' | 'runner' | 'reviewer'): string {
  return value.agents[role].providerSourceId || value.modelProviders?.[0]?.id || 'default';
}

function providerSourceLabel(source: ModelProviderSource, providers: ProviderInfo[]): string {
  const provider = providers.find((item) => item.id === source.provider);
  const providerName = provider?.name || source.provider || '未选择 Provider';
  if (!source.baseUrl) return providerName;
  try {
    const host = new URL(source.baseUrl).host;
    return host ? `${providerName} · ${host}` : providerName;
  } catch {
    return providerName;
  }
}

function GlobalSection({
  section,
  value,
  disabled,
  secretBusy,
  secretDraft,
  secretMetadata,
  providerSecretDraft,
  providerSecretMetadata,
  onChange,
  onSecretValue,
  onSaveSecret,
  onClearSecret,
  onProviderSecretValue,
  onVerifyProviderSource,
  onRemoveProviderSource,
}: {
  section: GlobalSettingSection;
  value: HarnessConfig;
  disabled: boolean;
  secretBusy: string;
  secretDraft: Partial<Record<DeploymentSecret, string>>;
  secretMetadata: Record<DeploymentSecret, SecretMetadata>;
  providerSecretDraft: Record<string, string>;
  providerSecretMetadata: Record<string, SecretMetadata>;
  onChange: (value: HarnessConfig) => void;
  onSecretValue: (key: DeploymentSecret, value: string) => void;
  onSaveSecret: (key: DeploymentSecret) => void;
  onClearSecret: (key: DeploymentSecret) => void;
  onProviderSecretValue: (sourceId: string, value: string) => void;
  onVerifyProviderSource: (sourceId: string) => void;
  onRemoveProviderSource: (sourceId: string, sourceLabel: string) => void;
}) {
  const set = (patch: Partial<HarnessConfig>) => onChange({ ...value, ...patch });
  if (section === 'models')
    return (
      <ModelSettings
        value={value}
        disabled={disabled}
        busy={secretBusy}
        providerSecretDraft={providerSecretDraft}
        providerSecretMetadata={providerSecretMetadata}
        onChange={onChange}
        onProviderSecretValue={onProviderSecretValue}
        onVerifyProviderSource={onVerifyProviderSource}
        onRemoveProviderSource={onRemoveProviderSource}
      />
    );
  if (section === 'browser')
    return (
      <>
        <SectionTitle title="浏览器工具" />
        <div className="form-grid">
          <Check
            label="启用浏览器工具"
            checked={value.mcp.enabled}
            disabled={disabled}
            onChange={(checked) => set({ mcp: { ...value.mcp, enabled: checked } })}
          />
          <div className="browser-runtime-fact">
            <span>运行方式</span>
            <strong>Chromium · 无界面</strong>
          </div>
          <Field label="操作超时（毫秒）">
            <NumberInput
              ariaLabel="操作超时（毫秒）"
              min={5000}
              max={120000}
              step={1000}
              disabled={disabled}
              value={value.mcp.timeoutMs}
              onChange={(timeoutMs) => set({ mcp: { ...value.mcp, timeoutMs } })}
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
            <SelectBox
              ariaLabel="访问模式"
              disabled={disabled}
              value={value.oss.accessMode}
              options={[
                { value: 'private', label: 'private' },
                { value: 'public', label: 'public' },
              ]}
              onChange={(accessMode) =>
                set({
                  oss: { ...value.oss, accessMode: accessMode as 'public' | 'private' },
                })
              }
            />
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
        <NumberInput
          ariaLabel="保留天数"
          min={1}
          max={36500}
          step={1}
          disabled={disabled}
          value={value.local.retentionDays}
          onChange={(retentionDays) => set({ local: { ...value.local, retentionDays } })}
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
          <article className="secret-row" data-configured={metadata[key]?.configured} key={key}>
            <h3>{labels[key]}</h3>
            <div className="secret-input-wrap">
              <input
                className="secret-input"
                type="password"
                aria-label={`${metadata[key]?.configured ? '轮换' : '设置'}${labels[key]}`}
                autoComplete="new-password"
                placeholder={metadata[key]?.configured ? '已配置 · 输入新值可轮换' : '输入凭据'}
                value={values[key] ?? ''}
                onChange={(event) => onValue(key, event.target.value)}
              />
              {metadata[key]?.configured && (
                <span className="secret-configured-mark" aria-hidden="true">
                  ✓
                </span>
              )}
            </div>
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
