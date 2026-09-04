import { useEffect, useState } from 'react';

import type {
  AgentConfig,
  ConfigResponse,
  ConnectivityCheck,
  HarnessConfig,
  ProviderInfo,
  ProviderModelInfo,
  RepositoryConfig,
  SecretKey,
  ThinkingLevel,
} from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import {
  checkStatusLabel,
  ConnectivityResult,
  Field,
  ModelCapabilities,
  SecretField,
  SectionCard,
} from '../components/FormControls';
import { ConfigurationTransferSection } from './ConfigurationTransferSection';

const SECRET_FIELDS: Record<SecretKey, { key: SecretKey; label: string }> = {
  providerApiKey: { key: 'providerApiKey', label: 'Provider API Key' },
  ossAccessKeyId: { key: 'ossAccessKeyId', label: 'OSS Access Key ID' },
  ossAccessKeySecret: { key: 'ossAccessKeySecret', label: 'OSS Access Key Secret' },
  gitToken: { key: 'gitToken', label: 'GitHub Token' },
  testUsername: { key: 'testUsername', label: '测试环境账号' },
  testPassword: { key: 'testPassword', label: '测试环境密码' },
};

const GITHUB_CHECK_IDS = [
  'github-repository-read',
  'github-scenario-branch-write',
  'github-pull-request',
  'github-issue',
] as const;

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

interface SettingsPageProps {
  config: ConfigResponse;
  onConfigChange: (config: ConfigResponse) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  onSessionEnded: (message: string) => void;
}

export function SettingsPage({
  config,
  onConfigChange,
  onMessage,
  onError,
  onSessionEnded,
}: SettingsPageProps) {
  const [harness, setHarness] = useState(config.harness);
  const [repository, setRepository] = useState(config.repository);
  const [secretDraft, setSecretDraft] = useState(emptySecretDraft);
  const [checks, setChecks] = useState<ConnectivityCheck[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelCatalogMessage, setModelCatalogMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      requestJson<{ checks: ConnectivityCheck[] }>('/api/connectivity/checks'),
      requestJson<{ providers: ProviderInfo[] }>('/api/provider/providers'),
    ])
      .then(([checkResponse, providerResponse]) => {
        if (!active) return;
        setChecks(checkResponse.checks);
        setProviders(providerResponse.providers);
      })
      .catch((cause: unknown) => {
        if (active) onError(toUserMessage(cause, '无法读取配置目录'));
      });
    return () => {
      active = false;
    };
  }, [onError]);

  useEffect(() => {
    const provider = harness.provider.trim();
    if (!provider) {
      setModels([]);
      setModelCatalogMessage('请先选择模型 Provider');
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setModelsLoading(true);
      setModelCatalogMessage('');
      void requestJson<{ provider: string; models: ProviderModelInfo[] }>(
        `/api/provider/models?provider=${encodeURIComponent(provider)}`,
      )
        .then((response) => {
          if (!active) return;
          setModels(response.models);
          setModelCatalogMessage(
            response.models.length > 0
              ? `已载入 ${response.models.length} 个 ${response.provider} 模型`
              : `Provider “${response.provider}”没有可选择的已知模型`,
          );
        })
        .catch((cause: unknown) => {
          if (active) {
            setModels([]);
            setModelCatalogMessage(toUserMessage(cause, '模型目录加载失败'));
          }
        })
        .finally(() => {
          if (active) setModelsLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [harness.provider]);

  const execute = async (action: string, task: () => Promise<void>) => {
    setBusy(action);
    onError('');
    onMessage('');
    try {
      await task();
    } catch (cause: unknown) {
      onError(toUserMessage(cause, '配置操作失败'));
    } finally {
      setBusy(null);
    }
  };

  const applyConfig = (next: ConfigResponse, clearedSecrets: SecretKey[] = []) => {
    onConfigChange(next);
    if (clearedSecrets.length > 0) {
      setSecretDraft((current) => ({
        ...current,
        ...Object.fromEntries(clearedSecrets.map((key) => [key, ''])),
      }));
    }
  };

  const markChecksPending = (checkIds: readonly string[]) => {
    const ids = new Set(checkIds);
    setChecks((current) =>
      current.map((check) =>
        ids.has(check.id)
          ? {
              ...check,
              result: {
                status: 'not_checked',
                message: '配置已更新，等待检查',
                checkedAt: null,
                latencyMs: null,
              },
            }
          : check,
      ),
    );
  };

  const saveHarness = async (
    patch: Partial<HarnessConfig>,
    secretKeys: SecretKey[] = [],
  ): Promise<ConfigResponse> => {
    const next = await requestJson<ConfigResponse>('/api/config/harness', {
      method: 'PUT',
      body: JSON.stringify({ ...patch, secrets: pickSecrets(secretDraft, secretKeys) }),
    });
    applyConfig(next, secretKeys);
    setHarness((current) => mergeConfirmedPatch(current, next.harness, patch));
    markChecksPending(harnessCheckIds(patch, secretKeys));
    return next;
  };

  const saveRepository = async (
    patch: Partial<RepositoryConfig>,
    secretKeys: SecretKey[] = [],
  ): Promise<ConfigResponse> => {
    const next = await requestJson<ConfigResponse>('/api/config/repository', {
      method: 'PUT',
      body: JSON.stringify({ ...patch, secrets: pickSecrets(secretDraft, secretKeys) }),
    });
    applyConfig(next, secretKeys);
    setRepository((current) => mergeConfirmedPatch(current, next.repository, patch));
    markChecksPending(repositoryCheckIds(patch, secretKeys));
    return next;
  };

  const runCheck = async (checkId: string) => {
    const next = await requestJson<ConnectivityCheck>(
      `/api/connectivity/checks/${encodeURIComponent(checkId)}`,
      { method: 'POST' },
    );
    setChecks((current) => replaceChecks(current, [next]));
    onMessage(`${next.label}：${next.result.message}`);
  };

  const runChecks = async (checkIds: readonly string[]) => {
    const results: ConnectivityCheck[] = [];
    for (const checkId of checkIds) {
      results.push(
        await requestJson<ConnectivityCheck>(
          `/api/connectivity/checks/${encodeURIComponent(checkId)}`,
          { method: 'POST' },
        ),
      );
    }
    setChecks((current) => replaceChecks(current, results));
    return results;
  };

  const runAllChecks = async () => {
    const response = await requestJson<{ checks: ConnectivityCheck[] }>(
      '/api/connectivity/checks',
      { method: 'POST' },
    );
    setChecks(response.checks);
    const passed = response.checks.filter((check) => check.result.status === 'ok').length;
    onMessage(`全部配置检查完成：${passed}/${response.checks.length} 项通过`);
  };

  const deleteSecret = async (secretKey: SecretKey) => {
    const field = SECRET_FIELDS[secretKey];
    if (!window.confirm(`确定删除“${field.label}”吗？`)) return;
    await execute(`delete-${secretKey}`, async () => {
      const next = await requestJson<ConfigResponse>(
        `/api/secrets/${encodeURIComponent(secretKey)}`,
        { method: 'DELETE' },
      );
      applyConfig(next, [secretKey]);
      markChecksPending(secretCheckIds(secretKey));
      onMessage(`${field.label} 已删除`);
    });
  };

  const providerCheck = findCheck(checks, 'provider-model');
  const browserCheck = findCheck(checks, 'playwright-mcp');
  const ossCheck = findCheck(checks, 'oss');
  const environmentCheck = findCheck(checks, 'test-environment-url');

  return (
    <div className="settings-page">
      {!config.secretStore.available && (
        <p className="notice notice-warning">
          Secret Store 尚未配置主密钥。普通配置可保存，但保存 Secret 前请设置 LUOWANG_MASTER_KEY
          并重启服务。
        </p>
      )}

      <ConfigurationTransferSection
        busy={busy}
        onExport={() =>
          void execute('config-export', async () => {
            const response = await requestJson<{ fileName: string; yaml: string }>(
              '/api/config/export',
            );
            downloadTextFile(response.fileName, response.yaml);
            onMessage('普通配置 YAML 已导出；Secret 未包含在文件中');
          })
        }
        onImport={(file) => {
          if (
            !window.confirm(
              '导入会替换当前普通配置并清除旧连接结果，但不会覆盖或删除任何 Secret。是否继续？',
            )
          ) {
            return;
          }
          void execute('config-import', async () => {
            const yaml = await file.text();
            const next = await requestJson<ConfigResponse>('/api/config/import', {
              method: 'POST',
              body: JSON.stringify({ yaml }),
            });
            const checkResponse = await requestJson<{ checks: ConnectivityCheck[] }>(
              '/api/connectivity/checks',
            );
            applyConfig(next);
            setHarness(next.harness);
            setRepository(next.repository);
            setChecks(checkResponse.checks);
            onMessage('普通配置已从 YAML 原子导入；请点击“测试全部”重新验证');
          });
        }}
      />

      <ProviderSection
        harness={harness}
        secretDraft={secretDraft}
        secretMetadata={config.secrets.providerApiKey}
        providers={providers}
        models={models}
        modelsLoading={modelsLoading}
        catalogMessage={modelCatalogMessage}
        check={providerCheck}
        busy={busy}
        onHarnessChange={setHarness}
        onSecretChange={(value) =>
          setSecretDraft((current) => ({ ...current, providerApiKey: value }))
        }
        onDeleteSecret={() => void deleteSecret('providerApiKey')}
        onSave={() =>
          void execute('provider-save', async () => {
            await saveHarness(
              {
                provider: harness.provider,
                providerBaseUrl: harness.providerBaseUrl,
              },
              ['providerApiKey'],
            );
            onMessage('模型服务配置已保存');
          })
        }
        onSaveAndCheck={() =>
          void execute('provider-check', async () => {
            await saveHarness(
              {
                provider: harness.provider,
                providerBaseUrl: harness.providerBaseUrl,
                agents: harness.agents,
              },
              ['providerApiKey'],
            );
            await runCheck('provider-model');
          })
        }
      />

      <AgentModelsSection
        agents={harness.agents}
        models={models}
        busy={busy}
        onChange={(agents) => setHarness((current) => ({ ...current, agents }))}
        onSaveAndCheck={() =>
          void execute('agents-check', async () => {
            await saveHarness({ agents: harness.agents });
            await runCheck('provider-model');
          })
        }
      />

      <div className="settings-columns">
        <BrowserSection
          harness={harness}
          check={browserCheck}
          busy={busy}
          onChange={setHarness}
          onSaveAndCheck={() =>
            void execute('browser-check', async () => {
              await saveHarness({ mcp: harness.mcp });
              await runCheck('playwright-mcp');
            })
          }
        />
        <LocalSection
          harness={harness}
          busy={busy}
          onChange={setHarness}
          onSave={() =>
            void execute('local-save', async () => {
              await saveHarness({ language: harness.language, local: harness.local });
              onMessage('本地运行配置已保存');
            })
          }
        />
      </div>

      <OssSection
        harness={harness}
        secretDraft={secretDraft}
        config={config}
        check={ossCheck}
        busy={busy}
        onChange={setHarness}
        onSecretChange={(key, value) => setSecretDraft((current) => ({ ...current, [key]: value }))}
        onDeleteSecret={(key) => void deleteSecret(key)}
        onSaveAndCheck={() =>
          void execute('oss-check', async () => {
            await saveHarness({ oss: harness.oss }, ['ossAccessKeyId', 'ossAccessKeySecret']);
            await runCheck('oss');
          })
        }
      />

      <RepositorySection
        repository={repository}
        secretDraft={secretDraft}
        config={config}
        checks={checks}
        busy={busy}
        onChange={setRepository}
        onSecretChange={(value) => setSecretDraft((current) => ({ ...current, gitToken: value }))}
        onDeleteSecret={() => void deleteSecret('gitToken')}
        onSave={() =>
          void execute('repository-save', async () => {
            await saveRepository(repositoryIdentityPatch(repository), ['gitToken']);
            onMessage('GitHub 仓库配置已保存');
          })
        }
        onSaveAndCheck={() =>
          void execute('repository-check', async () => {
            await saveRepository(repositoryIdentityPatch(repository), ['gitToken']);
            const results = await runChecks(GITHUB_CHECK_IDS);
            const passed = results.filter((check) => check.result.status === 'ok').length;
            onMessage(`GitHub 综合检查完成：${passed}/${results.length} 项通过`);
          })
        }
      />

      <div className="settings-columns">
        <EnvironmentSection
          repository={repository}
          secretDraft={secretDraft}
          config={config}
          check={environmentCheck}
          busy={busy}
          onChange={setRepository}
          onSecretChange={(key, value) =>
            setSecretDraft((current) => ({ ...current, [key]: value }))
          }
          onDeleteSecret={(key) => void deleteSecret(key)}
          onSaveAndCheck={() =>
            void execute('environment-check', async () => {
              await saveRepository(environmentPatch(repository), ['testUsername', 'testPassword']);
              await runCheck('test-environment-url');
            })
          }
        />
        <AutomationSection
          repository={repository}
          busy={busy}
          onChange={setRepository}
          onSave={() =>
            void execute('automation-save', async () => {
              await saveRepository(automationPatch(repository));
              onMessage('自动触发配置已保存');
            })
          }
        />
      </div>

      <ConnectivityOverview
        checks={checks}
        busy={busy}
        onRunAll={() => void execute('checks-all', runAllChecks)}
      />

      <PasswordSection
        busy={busy}
        onSubmit={(currentPassword, newPassword) =>
          void execute('password', async () => {
            await requestJson('/api/auth/password', {
              method: 'POST',
              body: JSON.stringify({ currentPassword, newPassword }),
            });
            onSessionEnded('密码已修改，请使用新密码重新登录');
          })
        }
      />
    </div>
  );
}

function ProviderSection({
  harness,
  secretDraft,
  secretMetadata,
  providers,
  models,
  modelsLoading,
  catalogMessage,
  check,
  busy,
  onHarnessChange,
  onSecretChange,
  onDeleteSecret,
  onSave,
  onSaveAndCheck,
}: {
  harness: HarnessConfig;
  secretDraft: Record<SecretKey, string>;
  secretMetadata: ConfigResponse['secrets']['providerApiKey'];
  providers: ProviderInfo[];
  models: ProviderModelInfo[];
  modelsLoading: boolean;
  catalogMessage: string;
  check: ConnectivityCheck | undefined;
  busy: string | null;
  onHarnessChange: (harness: HarnessConfig) => void;
  onSecretChange: (value: string) => void;
  onDeleteSecret: () => void;
  onSave: () => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="provider-title"
      eyebrow="MODEL SERVICE"
      title="模型服务"
      description="Provider、地址与凭据在这里统一配置。测试连接会真实调用当前 Main 模型。"
      actions={
        <>
          <button className="button button-secondary" disabled={busy !== null} onClick={onSave}>
            {busy === 'provider-save' ? '保存中…' : '保存'}
          </button>
          <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
            {busy === 'provider-check' ? '测试中…' : '保存并测试'}
          </button>
        </>
      }
    >
      <div className="form-grid form-grid-3">
        <Field label="模型 Provider" hint="可输入或从 Pi Runtime 已知 Provider 中选择">
          <input
            list="provider-catalog"
            value={harness.provider}
            onChange={(event) => onHarnessChange({ ...harness, provider: event.target.value })}
            placeholder="例如 deepseek / openai"
          />
        </Field>
        <datalist id="provider-catalog">
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </datalist>
        <Field
          label="Provider Base URL（可选）"
          hint="留空使用 Provider 默认地址；可填写可信代理地址"
        >
          <input
            type="url"
            value={harness.providerBaseUrl}
            onChange={(event) =>
              onHarnessChange({ ...harness, providerBaseUrl: event.target.value })
            }
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <SecretField
          field={SECRET_FIELDS.providerApiKey}
          metadata={secretMetadata}
          value={secretDraft.providerApiKey}
          onChange={onSecretChange}
          onDelete={onDeleteSecret}
        />
      </div>
      <div className="catalog-summary" aria-live="polite">
        <strong>模型目录</strong>
        <span>{modelsLoading ? '正在加载…' : catalogMessage}</span>
        {models.some((model) => model.input.includes('image')) && (
          <span className="capability-badge capability-vision">包含视觉模型</span>
        )}
      </div>
      <ConnectivityResult check={check} busy={busy === 'provider-check'} />
    </SectionCard>
  );
}

function AgentModelsSection({
  agents,
  models,
  busy,
  onChange,
  onSaveAndCheck,
}: {
  agents: HarnessConfig['agents'];
  models: ProviderModelInfo[];
  busy: string | null;
  onChange: (agents: HarnessConfig['agents']) => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="agents-title"
      eyebrow="AGENT MODELS"
      title="Agent 模型"
      description="模型候选只来自上方选中的 Provider。Reviewer 负责读取截图证据，视觉场景必须使用支持图像输入的模型。"
      actions={
        <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
          {busy === 'agents-check' ? '验证中…' : '保存并验证三个角色'}
        </button>
      }
    >
      <div className="agent-grid">
        <AgentModelCard
          role="main"
          label="Main"
          purpose="规划与最终汇总"
          agent={agents.main}
          models={models}
          onChange={(agent) => onChange({ ...agents, main: agent })}
        />
        <AgentModelCard
          role="runner"
          label="Runner"
          purpose="执行场景与收集证据"
          agent={agents.runner}
          models={models}
          onChange={(agent) => onChange({ ...agents, runner: agent })}
        />
        <AgentModelCard
          role="reviewer"
          label="Reviewer"
          purpose="独立审核与截图判断"
          requiresVision
          agent={agents.reviewer}
          models={models}
          onChange={(agent) => onChange({ ...agents, reviewer: agent })}
        />
      </div>
    </SectionCard>
  );
}

function AgentModelCard({
  role,
  label,
  purpose,
  requiresVision = false,
  agent,
  models,
  onChange,
}: {
  role: 'main' | 'runner' | 'reviewer';
  label: string;
  purpose: string;
  requiresVision?: boolean;
  agent: AgentConfig;
  models: ProviderModelInfo[];
  onChange: (agent: AgentConfig) => void;
}) {
  const selected = models.find((model) => model.id === agent.model);
  const supportsVision = selected?.input.some((input) => input.toLowerCase() === 'image') ?? false;
  const thinkingLevels = selected?.thinkingLevels.length
    ? selected.thinkingLevels
    : THINKING_LEVELS;
  const modelError =
    requiresVision && agent.model.trim() !== ''
      ? selected
        ? supportsVision
          ? undefined
          : '该模型不支持图像输入，视觉场景会被阻塞。请选择带“视觉”标记的模型。'
        : '该模型未匹配当前 Provider 目录，无法确认视觉能力。请选择目录中的视觉模型。'
      : undefined;
  const listId = `model-catalog-${role}`;

  return (
    <article className={`subpanel agent-card ${requiresVision ? 'agent-card-vision' : ''}`}>
      <div className="agent-card-heading">
        <div>
          <h4>{label}</h4>
          <p>{purpose}</p>
        </div>
        <span className={`role-requirement ${requiresVision ? 'role-requirement-vision' : ''}`}>
          {requiresVision ? '需要视觉' : '文本模型'}
        </span>
      </div>
      <Field label="模型" hint="输入模型 ID 或名称可筛选" error={modelError}>
        <input
          type="search"
          list={listId}
          value={agent.model}
          onChange={(event) => {
            const model = models.find((candidate) => candidate.id === event.target.value);
            const thinking = model
              ? preferredThinkingLevel(model.thinkingLevels, agent.thinking)
              : agent.thinking;
            onChange({ model: event.target.value, thinking });
          }}
          placeholder="搜索 Provider 模型"
        />
      </Field>
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} · {model.input.includes('image') ? '视觉' : '文本'}
            {model.reasoning ? ' · 推理' : ''}
          </option>
        ))}
      </datalist>
      <div className="model-meta">
        <ModelCapabilities model={selected} />
        {selected && <small>{selected.name}</small>}
      </div>
      <Field label="Thinking" hint="高等级通常更慢且消耗更多 Token">
        <select
          value={agent.thinking}
          onChange={(event) =>
            onChange({ ...agent, thinking: event.target.value as ThinkingLevel })
          }
        >
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {thinkingLabel(level)}
            </option>
          ))}
        </select>
      </Field>
    </article>
  );
}

function BrowserSection({
  harness,
  check,
  busy,
  onChange,
  onSaveAndCheck,
}: {
  harness: HarnessConfig;
  check: ConnectivityCheck | undefined;
  busy: string | null;
  onChange: (harness: HarnessConfig) => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="browser-title"
      eyebrow="BROWSER"
      title="浏览器自动化"
      description="配置 Playwright MCP，并启动一次真实 MCP 握手检查。"
      actions={
        <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
          {busy === 'browser-check' ? '测试中…' : '保存并测试'}
        </button>
      }
    >
      <div className="toggle-row toggle-row-top">
        <label>
          <input
            type="checkbox"
            checked={harness.mcp.enabled}
            onChange={(event) =>
              onChange({ ...harness, mcp: { ...harness.mcp, enabled: event.target.checked } })
            }
          />
          启用 Playwright MCP
        </label>
        <label>
          <input
            type="checkbox"
            checked={harness.mcp.headless}
            onChange={(event) =>
              onChange({ ...harness, mcp: { ...harness.mcp, headless: event.target.checked } })
            }
          />
          Headless
        </label>
      </div>
      <div className="form-grid">
        <Field label="浏览器">
          <select
            value={harness.mcp.browser}
            onChange={(event) =>
              onChange({
                ...harness,
                mcp: {
                  ...harness.mcp,
                  browser: event.target.value as HarnessConfig['mcp']['browser'],
                },
              })
            }
          >
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </select>
        </Field>
        <Field label="MCP 超时（毫秒）">
          <input
            type="number"
            min="100"
            max="300000"
            value={harness.mcp.timeoutMs}
            onChange={(event) =>
              onChange({
                ...harness,
                mcp: { ...harness.mcp, timeoutMs: Number(event.target.value) },
              })
            }
          />
        </Field>
      </div>
      <ConnectivityResult check={check} busy={busy === 'browser-check'} />
    </SectionCard>
  );
}

function LocalSection({
  harness,
  busy,
  onChange,
  onSave,
}: {
  harness: HarnessConfig;
  busy: string | null;
  onChange: (harness: HarnessConfig) => void;
  onSave: () => void;
}) {
  return (
    <SectionCard
      id="local-title"
      eyebrow="LOCAL RUNTIME"
      title="本地运行与保留"
      description="容器内工作目录与临时报告保留策略。"
      actions={
        <button className="button button-secondary" disabled={busy !== null} onClick={onSave}>
          {busy === 'local-save' ? '保存中…' : '保存'}
        </button>
      }
    >
      <Field label="界面语言">
        <input
          value={harness.language}
          onChange={(event) => onChange({ ...harness, language: event.target.value })}
        />
      </Field>
      <div className="form-stack">
        <Field label="Repository 目录">
          <input
            value={harness.local.repoDir}
            onChange={(event) =>
              onChange({
                ...harness,
                local: { ...harness.local, repoDir: event.target.value },
              })
            }
          />
        </Field>
        <Field label="Report 目录">
          <input
            value={harness.local.reportDir}
            onChange={(event) =>
              onChange({
                ...harness,
                local: { ...harness.local, reportDir: event.target.value },
              })
            }
          />
        </Field>
        <Field label="保留天数">
          <input
            type="number"
            min="0"
            max="36500"
            value={harness.local.retentionDays}
            onChange={(event) =>
              onChange({
                ...harness,
                local: { ...harness.local, retentionDays: Number(event.target.value) },
              })
            }
          />
        </Field>
      </div>
    </SectionCard>
  );
}

function OssSection({
  harness,
  secretDraft,
  config,
  check,
  busy,
  onChange,
  onSecretChange,
  onDeleteSecret,
  onSaveAndCheck,
}: {
  harness: HarnessConfig;
  secretDraft: Record<SecretKey, string>;
  config: ConfigResponse;
  check: ConnectivityCheck | undefined;
  busy: string | null;
  onChange: (harness: HarnessConfig) => void;
  onSecretChange: (key: 'ossAccessKeyId' | 'ossAccessKeySecret', value: string) => void;
  onDeleteSecret: (key: 'ossAccessKeyId' | 'ossAccessKeySecret') => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="oss-title"
      eyebrow="EVIDENCE STORAGE"
      title="Evidence 存储"
      description="配置 S3-compatible 私有或公开对象存储；测试会写入、读取并删除一个临时对象。"
      actions={
        <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
          {busy === 'oss-check' ? '测试中…' : '保存并测试'}
        </button>
      }
    >
      <div className="form-grid form-grid-3">
        <Field label="Endpoint">
          <input
            type="url"
            value={harness.oss.endpoint}
            onChange={(event) =>
              onChange({ ...harness, oss: { ...harness.oss, endpoint: event.target.value } })
            }
            placeholder="https://..."
          />
        </Field>
        <Field label="Region">
          <input
            value={harness.oss.region}
            onChange={(event) =>
              onChange({ ...harness, oss: { ...harness.oss, region: event.target.value } })
            }
          />
        </Field>
        <Field label="Bucket">
          <input
            value={harness.oss.bucket}
            onChange={(event) =>
              onChange({ ...harness, oss: { ...harness.oss, bucket: event.target.value } })
            }
          />
        </Field>
        <Field label="访问模式">
          <select
            value={harness.oss.accessMode}
            onChange={(event) =>
              onChange({
                ...harness,
                oss: {
                  ...harness.oss,
                  accessMode: event.target.value as HarnessConfig['oss']['accessMode'],
                },
              })
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </Field>
        <Field
          label="Public Base URL"
          hint={
            harness.oss.accessMode === 'private'
              ? 'Private 模式可留空，由 Evidence Gateway 提供访问'
              : undefined
          }
        >
          <input
            type="url"
            value={harness.oss.publicBaseUrl}
            onChange={(event) =>
              onChange({ ...harness, oss: { ...harness.oss, publicBaseUrl: event.target.value } })
            }
            disabled={harness.oss.accessMode === 'private'}
          />
        </Field>
        <Field label="Object Prefix">
          <input
            value={harness.oss.objectPrefix}
            onChange={(event) =>
              onChange({ ...harness, oss: { ...harness.oss, objectPrefix: event.target.value } })
            }
          />
        </Field>
      </div>
      <div className="secret-grid">
        <SecretField
          field={SECRET_FIELDS.ossAccessKeyId}
          metadata={config.secrets.ossAccessKeyId}
          value={secretDraft.ossAccessKeyId}
          onChange={(value) => onSecretChange('ossAccessKeyId', value)}
          onDelete={() => onDeleteSecret('ossAccessKeyId')}
        />
        <SecretField
          field={SECRET_FIELDS.ossAccessKeySecret}
          metadata={config.secrets.ossAccessKeySecret}
          value={secretDraft.ossAccessKeySecret}
          onChange={(value) => onSecretChange('ossAccessKeySecret', value)}
          onDelete={() => onDeleteSecret('ossAccessKeySecret')}
        />
      </div>
      <ConnectivityResult check={check} busy={busy === 'oss-check'} />
    </SectionCard>
  );
}

function RepositorySection({
  repository,
  secretDraft,
  config,
  checks,
  busy,
  onChange,
  onSecretChange,
  onDeleteSecret,
  onSave,
  onSaveAndCheck,
}: {
  repository: RepositoryConfig;
  secretDraft: Record<SecretKey, string>;
  config: ConfigResponse;
  checks: ConnectivityCheck[];
  busy: string | null;
  onChange: (repository: RepositoryConfig) => void;
  onSecretChange: (value: string) => void;
  onDeleteSecret: () => void;
  onSave: () => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="repository-title"
      eyebrow="GITHUB PROJECT"
      title="GitHub 仓库"
      description="一个罗网实例只连接一个可信目标仓库。一次执行四项无副作用检查，不制造测试 PR、Issue 或远端分支。"
      actions={
        <>
          <button className="button button-secondary" disabled={busy !== null} onClick={onSave}>
            {busy === 'repository-save' ? '保存中…' : '保存'}
          </button>
          <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
            {busy === 'repository-check' ? '检查中…' : '保存并测试 GitHub'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="目标仓库" hint="仅支持标准 GitHub HTTPS 仓库地址">
          <input
            type="url"
            value={repository.repository}
            onChange={(event) => onChange({ ...repository, repository: event.target.value })}
            placeholder="https://github.com/org/repository"
          />
        </Field>
        <Field label="场景测试分支">
          <input
            value={repository.scenarioBranch}
            onChange={(event) => onChange({ ...repository, scenarioBranch: event.target.value })}
          />
        </Field>
        <Field label="场景修改模式">
          <select
            value={repository.scenarioMode}
            onChange={(event) =>
              onChange({
                ...repository,
                scenarioMode: event.target.value as RepositoryConfig['scenarioMode'],
              })
            }
          >
            <option value="review-all">全部通过 PR 审核</option>
            <option value="add-only">只允许自动新增</option>
            <option value="autonomous">自动维护</option>
          </select>
        </Field>
        <Field label="场景标签（逗号分隔）">
          <input
            value={repository.scenarioLabels.join(', ')}
            onChange={(event) =>
              onChange({
                ...repository,
                scenarioLabels: event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </div>
      <div className="secret-grid secret-grid-single">
        <SecretField
          field={SECRET_FIELDS.gitToken}
          metadata={config.secrets.gitToken}
          value={secretDraft.gitToken}
          onChange={onSecretChange}
          onDelete={onDeleteSecret}
        />
      </div>
      <GitHubCheckSummary
        checks={GITHUB_CHECK_IDS.map((checkId) => findCheck(checks, checkId)).filter(
          (check): check is ConnectivityCheck => check !== undefined,
        )}
        busy={busy === 'repository-check'}
      />
    </SectionCard>
  );
}

function EnvironmentSection({
  repository,
  secretDraft,
  config,
  check,
  busy,
  onChange,
  onSecretChange,
  onDeleteSecret,
  onSaveAndCheck,
}: {
  repository: RepositoryConfig;
  secretDraft: Record<SecretKey, string>;
  config: ConfigResponse;
  check: ConnectivityCheck | undefined;
  busy: string | null;
  onChange: (repository: RepositoryConfig) => void;
  onSecretChange: (key: 'testUsername' | 'testPassword', value: string) => void;
  onDeleteSecret: (key: 'testUsername' | 'testPassword') => void;
  onSaveAndCheck: () => void;
}) {
  return (
    <SectionCard
      id="environment-title"
      eyebrow="TEST ENVIRONMENT"
      title="非生产测试环境"
      description="只连接可清理的非生产环境；连接检查不会提交测试数据。"
      actions={
        <button className="button" disabled={busy !== null} onClick={onSaveAndCheck}>
          {busy === 'environment-check' ? '测试中…' : '保存并测试'}
        </button>
      }
    >
      <Field label="测试环境基础 URL">
        <input
          type="url"
          value={repository.baseUrl}
          onChange={(event) => onChange({ ...repository, baseUrl: event.target.value })}
          placeholder="https://staging.example.test"
        />
      </Field>
      <Field label="环境说明">
        <textarea
          rows={3}
          value={repository.environmentDescription}
          onChange={(event) =>
            onChange({ ...repository, environmentDescription: event.target.value })
          }
        />
      </Field>
      <Field label="外部数据库说明" hint="只填写说明，不填写密码或 Token">
        <textarea
          rows={2}
          value={repository.externalDatabase}
          onChange={(event) => onChange({ ...repository, externalDatabase: event.target.value })}
        />
      </Field>
      <div className="secret-grid secret-grid-stacked">
        <SecretField
          field={SECRET_FIELDS.testUsername}
          metadata={config.secrets.testUsername}
          value={secretDraft.testUsername}
          onChange={(value) => onSecretChange('testUsername', value)}
          onDelete={() => onDeleteSecret('testUsername')}
        />
        <SecretField
          field={SECRET_FIELDS.testPassword}
          metadata={config.secrets.testPassword}
          value={secretDraft.testPassword}
          onChange={(value) => onSecretChange('testPassword', value)}
          onDelete={() => onDeleteSecret('testPassword')}
        />
      </div>
      <ConnectivityResult check={check} busy={busy === 'environment-check'} />
    </SectionCard>
  );
}

function AutomationSection({
  repository,
  busy,
  onChange,
  onSave,
}: {
  repository: RepositoryConfig;
  busy: string | null;
  onChange: (repository: RepositoryConfig) => void;
  onSave: () => void;
}) {
  return (
    <SectionCard
      id="automation-title"
      eyebrow="AUTOMATION"
      title="自动触发"
      description="自动测试默认关闭。新提交检查只负责发现变化后创建 Run，不会按间隔无条件重复测试。"
      actions={
        <button className="button button-secondary" disabled={busy !== null} onClick={onSave}>
          {busy === 'automation-save' ? '保存中…' : '保存'}
        </button>
      }
    >
      <label className="checkbox-row checkbox-row-leading">
        <input
          type="checkbox"
          checked={repository.triggerOnCommit}
          onChange={(event) =>
            onChange({
              ...repository,
              triggerOnCommit: event.target.checked,
              pollIntervalSeconds:
                event.target.checked && repository.pollIntervalSeconds < 300
                  ? 300
                  : repository.pollIntervalSeconds,
            })
          }
        />
        <span>
          <strong>新 commit 自动测试</strong>
          <small>启用后按下方间隔检查场景测试分支，有可测试提交时才进入顺序队列。</small>
        </span>
      </label>
      <Field
        label="新提交检查间隔（分钟）"
        hint={repository.triggerOnCommit ? '最短 5 分钟' : '启用“新 commit 自动测试”后可编辑'}
      >
        <input
          type="number"
          min="5"
          max="525600"
          step="1"
          disabled={!repository.triggerOnCommit}
          value={secondsToMinutes(repository.pollIntervalSeconds)}
          onChange={(event) =>
            onChange({
              ...repository,
              pollIntervalSeconds: minutesToSeconds(Number(event.target.value)),
            })
          }
        />
      </Field>
      <Field label="Cron 定时测试（UTC）" hint="例如 0 2 * * * 表示每天 UTC 02:00；留空不启用">
        <input
          value={repository.cron}
          onChange={(event) => onChange({ ...repository, cron: event.target.value })}
          placeholder="留空（默认关闭）"
        />
      </Field>
    </SectionCard>
  );
}

function GitHubCheckSummary({ checks, busy }: { checks: ConnectivityCheck[]; busy: boolean }) {
  const passed = checks.filter((check) => check.result.status === 'ok').length;
  const overallStatus =
    checks.length === GITHUB_CHECK_IDS.length && passed === checks.length
      ? 'ok'
      : checks.some((check) => ['failed', 'timeout', 'unreachable'].includes(check.result.status))
        ? 'failed'
        : 'unknown';
  return (
    <div className="github-check-summary" aria-live="polite">
      <div className="github-check-heading">
        <div>
          <span className={`check-dot check-dot-${overallStatus}`} aria-hidden="true" />
          <strong>
            {busy ? '正在执行 GitHub 综合检查…' : `${passed}/${GITHUB_CHECK_IDS.length} 项通过`}
          </strong>
        </div>
        <small>一次操作 · 四项无副作用验证</small>
      </div>
      <ul className="github-check-list">
        {checks.map((check) => (
          <li key={check.id}>
            <span className={`check-dot check-dot-${check.result.status}`} aria-hidden="true" />
            <div>
              <strong>
                {check.label} · {checkStatusLabel(check.result.status)}
              </strong>
              <p>{check.result.message}</p>
              <small>
                {check.result.checkedAt
                  ? `检查于 ${new Date(check.result.checkedAt).toLocaleString('zh-CN')}`
                  : '尚未执行'}
                {check.result.latencyMs !== null ? ` · ${check.result.latencyMs} ms` : ''}
              </small>
            </div>
          </li>
        ))}
        {checks.length === 0 && <li className="muted">GitHub 检查状态载入中…</li>}
      </ul>
    </div>
  );
}

function ConnectivityOverview({
  checks,
  busy,
  onRunAll,
}: {
  checks: ConnectivityCheck[];
  busy: string | null;
  onRunAll: () => void;
}) {
  const passed = checks.filter((check) => check.result.status === 'ok').length;
  return (
    <SectionCard
      id="checks-title"
      eyebrow="CONNECTIVITY OVERVIEW"
      title="配置检查总览"
      description={`最近结果：${passed}/${checks.length} 项通过。点击一次测试所有已保存配置，下面逐项显示问题原因。`}
      actions={
        <button className="button" type="button" disabled={busy !== null} onClick={onRunAll}>
          {busy === 'checks-all' ? '正在测试全部…' : '测试全部'}
        </button>
      }
    >
      <div className="connection-grid">
        {checks.map((check) => (
          <div className="overview-check" key={check.id}>
            <strong>{check.label}</strong>
            <ConnectivityResult check={check} busy={busy === 'checks-all'} compact />
          </div>
        ))}
        {checks.length === 0 && <p className="muted">暂无检查项</p>}
      </div>
    </SectionCard>
  );
}

function PasswordSection({
  busy,
  onSubmit,
}: {
  busy: string | null;
  onSubmit: (currentPassword: string, newPassword: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  return (
    <SectionCard
      id="password-title"
      eyebrow="ADMINISTRATOR"
      title="修改管理员密码"
      description="修改成功后所有管理会话立即失效，需要重新登录。"
    >
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(currentPassword, newPassword);
        }}
      >
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
            minLength={12}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        <button className="button" type="submit" disabled={busy !== null}>
          {busy === 'password' ? '修改中…' : '修改密码'}
        </button>
      </form>
    </SectionCard>
  );
}

function replaceChecks(
  current: ConnectivityCheck[],
  replacements: ConnectivityCheck[],
): ConnectivityCheck[] {
  const byId = new Map(replacements.map((check) => [check.id, check]));
  const existing = new Set(current.map((check) => check.id));
  return [
    ...current.map((check) => byId.get(check.id) ?? check),
    ...replacements.filter((check) => !existing.has(check.id)),
  ];
}

function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/yaml;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function secondsToMinutes(seconds: number): number {
  return seconds <= 0 ? 5 : Math.max(5, Math.round(seconds / 60));
}

function minutesToSeconds(minutes: number): number {
  return Math.max(5, Math.min(525_600, Math.round(minutes))) * 60;
}

function findCheck(checks: ConnectivityCheck[], id: string): ConnectivityCheck | undefined {
  return checks.find((check) => check.id === id);
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

function pickSecrets(
  draft: Record<SecretKey, string>,
  keys: SecretKey[],
): Partial<Record<SecretKey, string>> {
  return Object.fromEntries(
    keys.filter((key) => draft[key].length > 0).map((key) => [key, draft[key]]),
  ) as Partial<Record<SecretKey, string>>;
}

function mergeConfirmedPatch<T extends object>(current: T, confirmed: T, patch: Partial<T>): T {
  const values = Object.fromEntries(
    Object.keys(patch).map((key) => [key, confirmed[key as keyof T]]),
  ) as Partial<T>;
  return { ...current, ...values };
}

function preferredThinkingLevel(levels: ThinkingLevel[], current: ThinkingLevel): ThinkingLevel {
  if (levels.includes(current)) return current;
  if (levels.includes('medium')) return 'medium';
  return levels[0] ?? 'off';
}

function thinkingLabel(level: ThinkingLevel): string {
  const labels: Record<ThinkingLevel, string> = {
    off: '关闭',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '很高',
    max: '最大',
  };
  return `${labels[level]} (${level})`;
}

function harnessCheckIds(patch: Partial<HarnessConfig>, secretKeys: SecretKey[]): string[] {
  const checkIds: string[] = [];
  if (
    patch.provider !== undefined ||
    patch.providerBaseUrl !== undefined ||
    patch.agents !== undefined ||
    secretKeys.includes('providerApiKey')
  ) {
    checkIds.push('provider-model');
  }
  if (patch.mcp !== undefined) checkIds.push('playwright-mcp');
  if (
    patch.oss !== undefined ||
    secretKeys.includes('ossAccessKeyId') ||
    secretKeys.includes('ossAccessKeySecret')
  ) {
    checkIds.push('oss');
  }
  return checkIds;
}

function repositoryCheckIds(patch: Partial<RepositoryConfig>, secretKeys: SecretKey[]): string[] {
  const checkIds: string[] = [];
  if (
    patch.repository !== undefined ||
    patch.scenarioBranch !== undefined ||
    secretKeys.includes('gitToken')
  ) {
    checkIds.push(...GITHUB_CHECK_IDS);
  }
  if (patch.baseUrl !== undefined) checkIds.push('test-environment-url');
  return checkIds;
}

function secretCheckIds(secretKey: SecretKey): string[] {
  if (secretKey === 'providerApiKey') return ['provider-model'];
  if (secretKey === 'ossAccessKeyId' || secretKey === 'ossAccessKeySecret') return ['oss'];
  if (secretKey === 'gitToken') return [...GITHUB_CHECK_IDS];
  return [];
}

function repositoryIdentityPatch(repository: RepositoryConfig): Partial<RepositoryConfig> {
  return {
    repository: repository.repository,
    scenarioBranch: repository.scenarioBranch,
    scenarioMode: repository.scenarioMode,
    scenarioLabels: repository.scenarioLabels,
  };
}

function environmentPatch(repository: RepositoryConfig): Partial<RepositoryConfig> {
  return {
    baseUrl: repository.baseUrl,
    environmentDescription: repository.environmentDescription,
    externalDatabase: repository.externalDatabase,
  };
}

function automationPatch(repository: RepositoryConfig): Partial<RepositoryConfig> {
  return {
    pollIntervalSeconds: repository.pollIntervalSeconds,
    cron: repository.cron,
    triggerOnCommit: repository.triggerOnCommit,
  };
}
