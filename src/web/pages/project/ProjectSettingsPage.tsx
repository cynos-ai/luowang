import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { requestJson, toUserMessage } from '../../api';
import { AppLink, useNavigationBlocker } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field } from '../../components/FormControls';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import type {
  ProjectConfiguration,
  ProjectDetailResponse,
  ProjectSecret,
} from '../../project-types';
import type { ProjectSettingSection } from '../../app/route';

type PendingItem = { queueId: number; status: string; runId: string | null; request: string };
type SettingsData = { detail: ProjectDetailResponse; pending: PendingItem[] };

const sections: Array<[ProjectSettingSection, string]> = [
  ['general', '基本资料'],
  ['testing', '测试策略'],
  ['environment', '测试环境'],
  ['execution', '执行环境'],
  ['automation', '自动化'],
  ['credentials', '凭据'],
];
const secretLabels: Record<ProjectSecret, string> = {
  gitToken: 'GitHub Token',
  testUsername: '测试账号',
  testPassword: '测试密码',
  testDataCleanupToken: '清理 Token',
};

export function ProjectSettingsPage({
  projectId,
  section,
  onProjectChanged,
}: {
  projectId: string;
  section: ProjectSettingSection;
  onProjectChanged: () => Promise<void>;
}) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<SettingsData> => {
      const [detail, queue, current] = await Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ queue: PendingItem[] }>(`/api/projects/${projectId}/queue`, { signal }),
        requestJson<{ run: { runId: string; request: string } | null }>(
          `/api/projects/${projectId}/runs/current`,
          { signal },
        ),
      ]);
      const pending = queue.queue.filter((item) =>
        ['queued', 'running', 'waiting_archive'].includes(item.status),
      );
      if (current.run && !pending.some((item) => item.runId === current.run?.runId)) {
        pending.unshift({
          queueId: 0,
          status: 'running',
          runId: current.run.runId,
          request: current.run.request,
        });
      }
      return { detail, pending };
    },
    [projectId],
  );
  const resource = useResource(`project-settings:${projectId}`, load, (cause) =>
    toUserMessage(cause, '项目设置读取失败'),
  );
  const [draft, setDraft] = useState<ProjectConfiguration | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Partial<Record<ProjectSecret, string>>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleteSecret, setDeleteSecret] = useState<ProjectSecret | null>(null);
  const data = resource.value;
  const configuration = draft ?? data?.detail.configuration ?? null;
  const currentName = displayName ?? data?.detail.project.displayName ?? '';
  const dirty = Boolean(
    data &&
    (displayName !== null ||
      (draft !== null &&
        JSON.stringify(sectionValue(section, draft)) !==
          JSON.stringify(sectionValue(section, data.detail.configuration))) ||
      Object.values(secrets).some(Boolean)),
  );
  const blocker = useCallback(() => {
    if (busy) return false;
    return !dirty || window.confirm('当前页面有未保存修改。要放弃修改并离开吗？');
  }, [busy, dirty]);
  useNavigationBlocker(dirty || Boolean(busy) ? blocker : null);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    setDraft(null);
    setDisplayName(null);
    setSecrets({});
    setMessage('');
    setError('');
  }, [projectId, section]);

  async function action(label: string, operation: () => Promise<unknown>, clear: () => void) {
    setBusy(label);
    setMessage('');
    setError('');
    try {
      await operation();
      clear();
      resource.reload();
      setMessage(`${label}。已保存不代表连通或就绪，请前往运行准备检查。`);
    } catch (cause) {
      setError(toUserMessage(cause, `${label}失败`));
    } finally {
      setBusy('');
    }
  }

  const locked = Boolean(data?.pending.length);
  return (
    <section className="page-content project-settings-page">
      <PageHeading title="项目设置" scope="当前项目" />
      <div className="page-body settings-layout">
        <nav className="settings-tabs" aria-label="项目设置分组">
          {sections.map(([key, label]) => (
            <AppLink
              key={key}
              to={{ name: 'project-settings', projectId, section: key }}
              current={section === key}
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
          <AsyncRegion
            loading={resource.loading && !data}
            error={!data ? resource.error : ''}
            onRetry={resource.reload}
          >
            {data && configuration && (
              <>
                {locked && <LockNotice items={data.pending} />}
                <SettingsSection
                  section={section}
                  data={data}
                  configuration={configuration}
                  displayName={currentName}
                  secrets={secrets}
                  busy={Boolean(busy)}
                  locked={locked}
                  onConfiguration={setDraft}
                  onDisplayName={setDisplayName}
                  onSecret={(key, value) => setSecrets((current) => ({ ...current, [key]: value }))}
                  onSaveProfile={(event) => {
                    event.preventDefault();
                    void action(
                      '基本资料已保存',
                      async () => {
                        await requestJson(`/api/projects/${projectId}/profile`, {
                          method: 'PUT',
                          body: JSON.stringify({ displayName: currentName }),
                        });
                        await onProjectChanged();
                      },
                      () => setDisplayName(null),
                    );
                  }}
                  onSaveConfiguration={(patch) =>
                    void action(
                      '项目配置已保存',
                      () =>
                        requestJson(`/api/projects/${projectId}/configuration`, {
                          method: 'PUT',
                          body: JSON.stringify(patch),
                        }),
                      () => setDraft(null),
                    )
                  }
                  onSaveSecret={(key) => {
                    const value = secrets[key];
                    if (!value) return;
                    void action(
                      `${secretLabels[key]}已保存`,
                      () =>
                        requestJson(`/api/projects/${projectId}/secrets/${key}`, {
                          method: 'PUT',
                          body: JSON.stringify({ value }),
                        }),
                      () => setSecrets((current) => ({ ...current, [key]: '' })),
                    );
                  }}
                  onDeleteSecret={setDeleteSecret}
                />
              </>
            )}
          </AsyncRegion>
        </div>
      </div>
      {deleteSecret && data && (
        <ConfirmDialog
          open
          title={`清除${secretLabels[deleteSecret]}`}
          message={`${data.detail.project.displayName} · ${data.detail.project.repositoryOwner}/${data.detail.project.repositoryName}。清除后相关检查将失效，原值无法恢复。`}
          confirmLabel="确认清除"
          danger
          onConfirm={() => {
            const key = deleteSecret;
            setDeleteSecret(null);
            void action(
              `${secretLabels[key]}已清除`,
              () => requestJson(`/api/projects/${projectId}/secrets/${key}`, { method: 'DELETE' }),
              () => setSecrets((current) => ({ ...current, [key]: '' })),
            );
          }}
          onClose={() => setDeleteSecret(null)}
        />
      )}
    </section>
  );
}

function SettingsSection({
  section,
  data,
  configuration,
  displayName,
  secrets,
  busy,
  locked,
  onConfiguration,
  onDisplayName,
  onSecret,
  onSaveProfile,
  onSaveConfiguration,
  onSaveSecret,
  onDeleteSecret,
}: {
  section: ProjectSettingSection;
  data: SettingsData;
  configuration: ProjectConfiguration;
  displayName: string;
  secrets: Partial<Record<ProjectSecret, string>>;
  busy: boolean;
  locked: boolean;
  onConfiguration: (value: ProjectConfiguration) => void;
  onDisplayName: (value: string) => void;
  onSecret: (key: ProjectSecret, value: string) => void;
  onSaveProfile: (event: FormEvent<HTMLFormElement>) => void;
  onSaveConfiguration: (patch: Partial<ProjectConfiguration>) => void;
  onSaveSecret: (key: ProjectSecret) => void;
  onDeleteSecret: (key: ProjectSecret) => void;
}) {
  const disabled = busy || locked;
  if (section === 'general') {
    return (
      <SettingsPanel title="基本资料" description="仓库身份由接入时核验，不能在这里替换。">
        <form className="form-grid" onSubmit={onSaveProfile}>
          <Field label="项目显示名称">
            <input
              required
              maxLength={120}
              value={displayName}
              disabled={disabled}
              onChange={(event) => onDisplayName(event.target.value)}
            />
          </Field>
          <ReadOnly
            label="GitHub 仓库"
            value={`${data.detail.project.repositoryOwner}/${data.detail.project.repositoryName}`}
          />
          <ReadOnly label="创建时间" value={formatDate(data.detail.project.createdAt ?? null)} />
          <details className="technical-details">
            <summary>技术信息</summary>
            <code>{data.detail.project.projectId}</code>
          </details>
          <SaveButton disabled={disabled}>保存基本资料</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  if (section === 'testing') {
    return (
      <SettingsPanel
        title="测试策略"
        description="修改后运行准备状态失效；保存时不会执行连接检查。"
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveConfiguration(sectionValue('testing', configuration));
          }}
        >
          <Field label="场景分支">
            <input
              value={configuration.scenarioBranch}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, scenarioBranch: event.target.value })
              }
            />
          </Field>
          <Field label="场景维护模式">
            <select
              value={configuration.scenarioMode}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({
                  ...configuration,
                  scenarioMode: event.target.value as ProjectConfiguration['scenarioMode'],
                })
              }
            >
              <option value="autonomous">自动维护</option>
              <option value="add-only">仅自动新增</option>
              <option value="review-all">全部人工审核</option>
            </select>
          </Field>
          <Field label="固定包含标签" hint="多个标签用逗号分隔。">
            <input
              value={configuration.scenarioLabels.join(', ')}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({
                  ...configuration,
                  scenarioLabels: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label="生成语言">
            <input
              value={configuration.language}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, language: event.target.value })
              }
            />
          </Field>
          <SaveButton disabled={disabled}>保存测试策略</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  if (section === 'environment') {
    return (
      <SettingsPanel title="测试环境" description="只允许非生产环境。凭据在凭据分组单独提交。">
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveConfiguration(sectionValue('environment', configuration));
          }}
        >
          <Field label="非生产环境 URL">
            <input
              type="url"
              value={configuration.baseUrl}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, baseUrl: event.target.value })
              }
            />
          </Field>
          <Field label="环境说明">
            <textarea
              value={configuration.environmentDescription}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, environmentDescription: event.target.value })
              }
            />
          </Field>
          <Field label="外部数据库说明">
            <textarea
              value={configuration.externalDatabase}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, externalDatabase: event.target.value })
              }
            />
          </Field>
          <Field label="测试数据清理地址">
            <input
              type="url"
              value={configuration.testDataCleanupUrl}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, testDataCleanupUrl: event.target.value })
              }
            />
          </Field>
          <SaveButton disabled={disabled}>保存测试环境</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  if (section === 'execution') {
    return (
      <SettingsPanel title="执行环境" description="保存后前往运行准备，针对固定提交准备镜像。">
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveConfiguration(sectionValue('execution', configuration));
          }}
        >
          <Field label="执行 Dockerfile" hint="留空使用罗网内置执行镜像。">
            <input
              value={configuration.executionDockerfile}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, executionDockerfile: event.target.value })
              }
            />
          </Field>
          <AppLink
            className="text-link"
            to={{ name: 'project-readiness', projectId: data.detail.project.projectId }}
          >
            查看运行准备
          </AppLink>
          <SaveButton disabled={disabled}>保存执行环境</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  if (section === 'automation') {
    return (
      <SettingsPanel
        title="自动化"
        description={
          data.detail.project.status === 'paused'
            ? '项目已暂停，自动请求不会被认领。'
            : '自动请求仍进入全局顺序队列。'
        }
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveConfiguration(sectionValue('automation', configuration));
          }}
        >
          <Field label="Git 轮询间隔（秒）">
            <input
              type="number"
              min={0}
              value={configuration.pollIntervalSeconds}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({
                  ...configuration,
                  pollIntervalSeconds: Number(event.target.value),
                })
              }
            />
          </Field>
          <Field label="Cron">
            <input
              value={configuration.cron}
              disabled={disabled}
              onChange={(event) => onConfiguration({ ...configuration, cron: event.target.value })}
            />
          </Field>
          <label className="check-control">
            <input
              type="checkbox"
              checked={configuration.triggerOnCommit}
              disabled={disabled}
              onChange={(event) =>
                onConfiguration({ ...configuration, triggerOnCommit: event.target.checked })
              }
            />
            提交变化时触发
          </label>
          <SaveButton disabled={disabled}>保存自动化</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  return (
    <SettingsPanel title="凭据" description="原值永远不返回前端。更新和清除会使运行准备状态失效。">
      <div className="credential-list">
        {(Object.keys(secretLabels) as ProjectSecret[]).map((key) => {
          const metadata = data.detail.secrets[key];
          return (
            <section className="credential-row" key={key} aria-labelledby={`credential-${key}`}>
              <div>
                <h3 id={`credential-${key}`}>{secretLabels[key]}</h3>
                <StatusLabel tone={metadata.configured ? 'success' : 'warning'}>
                  {metadata.configured ? `已配置 ${metadata.masked ?? ''}` : '未配置'}
                </StatusLabel>
              </div>
              <Field label={`新${secretLabels[key]}`} hint="留空保持现有值。">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] ?? ''}
                  disabled={disabled}
                  onChange={(event) => onSecret(key, event.target.value)}
                />
              </Field>
              <div className="row-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={disabled || !secrets[key]}
                  onClick={() => onSaveSecret(key)}
                >
                  更新
                </button>
                {metadata.configured && (
                  <button
                    className="button button-danger"
                    type="button"
                    disabled={disabled}
                    onClick={() => onDeleteSecret(key)}
                  >
                    清除
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </SettingsPanel>
  );
}

function SettingsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-panel">
      <header>
        <span className="scope-label">项目设置</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}
function SaveButton({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return (
    <button className="button" type="submit" disabled={disabled}>
      {children}
    </button>
  );
}
function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="read-only-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function LockNotice({ items }: { items: PendingItem[] }) {
  return (
    <section className="lock-notice" role="status">
      <strong>设置暂时锁定</strong>
      <p>
        {items
          .map((item) => (item.runId ? `测试 ${item.runId}` : `队列请求 #${item.queueId}`))
          .join('、')}{' '}
        仍在处理。完成后才能修改测试语义配置和凭据。
      </p>
    </section>
  );
}

function sectionValue(
  section: ProjectSettingSection,
  config: ProjectConfiguration,
): Partial<ProjectConfiguration> {
  switch (section) {
    case 'testing':
      return {
        scenarioBranch: config.scenarioBranch,
        scenarioMode: config.scenarioMode,
        scenarioLabels: config.scenarioLabels,
        language: config.language,
      };
    case 'environment':
      return {
        environmentDescription: config.environmentDescription,
        baseUrl: config.baseUrl,
        externalDatabase: config.externalDatabase,
        testDataCleanupUrl: config.testDataCleanupUrl,
      };
    case 'execution':
      return { executionDockerfile: config.executionDockerfile };
    case 'automation':
      return {
        pollIntervalSeconds: config.pollIntervalSeconds,
        cron: config.cron,
        triggerOnCommit: config.triggerOnCommit,
      };
    default:
      return {};
  }
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '未知';
}
