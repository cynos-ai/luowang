import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { requestJson, toUserMessage } from '../../api';
import { AppLink, useNavigationBlocker } from '../../app/navigation';
import { useResource } from '../../app/resource';
import { AsyncRegion } from '../../components/AsyncRegion';
import { AppMessageFeedback } from '../../components/AppMessageProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, Field, HelpLabel, NumberInput, SelectBox } from '../../components/ui';
import { PageHeading } from '../../components/PageHeading';
import { StatusLabel } from '../../components/StatusLabel';
import type {
  ProjectConfiguration,
  ProjectDetailResponse,
  ProjectSecret,
  ConnectionResourcesResponse,
  ProjectResourceBindings,
} from '../../project-types';

const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
];
import type { ProjectSettingSection } from '../../app/route';
import { ProjectManagedFilesSettings } from './ProjectManagedFilesSettings';
import { ProjectEnvironmentEditor } from './ProjectEnvironmentEditor';
import { ProjectTriggerSettings } from './ProjectTriggerSettings';

type PendingItem = { queueId: number; status: string; runId: string | null; request: string };
type SettingsData = {
  detail: ProjectDetailResponse;
  pending: PendingItem[];
  resources: ConnectionResourcesResponse;
};

const sections: Array<[ProjectSettingSection, string]> = [
  ['general', '基本资料'],
  ['testing', '测试规则'],
  ['execution', '运行环境'],
  ['credentials', '测试数据'],
  ['automation', '触发规则'],
  ['files', '配置文件'],
];
const secretLabels: Record<ProjectSecret, string> = {
  gitToken: 'GitHub Token',
  testUsername: '测试账号',
  testPassword: '测试密码',
  testDataCleanupToken: '清理接口 Token',
};

export function ProjectSettingsPage({
  projectId,
  section: requestedSection,
  onProjectChanged,
}: {
  projectId: string;
  section: ProjectSettingSection;
  onProjectChanged: () => Promise<void>;
}) {
  const section = requestedSection === 'environment' ? 'execution' : requestedSection;
  const load = useCallback(
    async (signal: AbortSignal): Promise<SettingsData> => {
      const [detail, queue, current, resources] = await Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ queue: PendingItem[] }>(`/api/projects/${projectId}/queue`, { signal }),
        requestJson<{ run: { runId: string; request: string } | null }>(
          `/api/projects/${projectId}/runs/current`,
          { signal },
        ),
        requestJson<ConnectionResourcesResponse>('/api/connection-resources', { signal }),
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
      return { detail, pending, resources };
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
  const navigationState = useRef({ busy: false, dirty: false });
  navigationState.current = { busy: Boolean(busy), dirty };
  const blocker = useCallback(() => {
    if (navigationState.current.busy) return false;
    if (!navigationState.current.dirty) return null;
    return {
      title: '放弃未保存修改？',
      message: '当前页面的修改尚未保存。离开后，这些修改将丢失。',
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
      danger: true,
    };
  }, []);
  useNavigationBlocker(dirty || Boolean(busy) ? blocker : null);

  useEffect(() => {
    setDraft(null);
    setDisplayName(null);
    setSecrets({});
    setMessage('');
    setError('');
  }, [projectId, section]);

  async function action(label: string, operation: () => Promise<unknown>, clear: () => void) {
    navigationState.current.busy = true;
    setBusy(label);
    setMessage('');
    setError('');
    try {
      await operation();
      clear();
      resource.reload();
      navigationState.current = { busy: false, dirty: false };
      setBusy('');
      setMessage(label);
      return true;
    } catch (cause) {
      navigationState.current.busy = false;
      setError(toUserMessage(cause, `${label}失败`));
      return false;
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
          <AppMessageFeedback success={message} error={error} />
          <AsyncRegion
            loading={resource.loading && !data}
            error={!data ? resource.error : ''}
            onRetry={resource.reload}
          >
            {data && configuration && (
              <>
                {locked && <LockNotice items={data.pending} />}
                {section === 'files' ? (
                  <ProjectManagedFilesSettings
                    projectId={projectId}
                    files={data.detail.managedFiles.filter((file) => file.purpose !== 'data')}
                    disabled={locked || Boolean(busy)}
                    onChanged={resource.reload}
                  />
                ) : (
                  <SettingsSection
                    section={section}
                    data={data}
                    configuration={configuration}
                    displayName={currentName}
                    secrets={secrets}
                    busy={Boolean(busy)}
                    locked={locked}
                    onConfiguration={setDraft}
                    onFilesChanged={resource.reload}
                    onDisplayName={setDisplayName}
                    onSecret={(key, value) =>
                      setSecrets((current) => ({ ...current, [key]: value }))
                    }
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
                    onSaveConfiguration={(patch, taskId) =>
                      action(
                        '项目配置已保存',
                        () =>
                          requestJson(
                            taskId
                              ? `/api/projects/${projectId}/environment-generation/${taskId}/apply`
                              : `/api/projects/${projectId}/configuration`,
                            {
                              method: 'PUT',
                              body: JSON.stringify(patch),
                            },
                          ),
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
                    onSaveTestAccount={() => {
                      if (!secrets.testUsername && !secrets.testPassword) return;
                      void action(
                        '测试账号已保存',
                        () =>
                          requestJson(`/api/projects/${projectId}/test-account`, {
                            method: 'PUT',
                            body: JSON.stringify({
                              testUsername: secrets.testUsername ?? '',
                              testPassword: secrets.testPassword ?? '',
                            }),
                          }),
                        () =>
                          setSecrets((current) => ({
                            ...current,
                            testUsername: '',
                            testPassword: '',
                          })),
                      );
                    }}
                    onDeleteSecret={setDeleteSecret}
                    onResourceBinding={(patch) =>
                      void action(
                        '连接资源已绑定',
                        () =>
                          requestJson(`/api/projects/${projectId}/resources`, {
                            method: 'PUT',
                            body: JSON.stringify(patch),
                          }),
                        () => {},
                      )
                    }
                  />
                )}
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
  onFilesChanged,
  onDisplayName,
  onSecret,
  onSaveProfile,
  onSaveConfiguration,
  onSaveSecret,
  onSaveTestAccount,
  onDeleteSecret,
  onResourceBinding,
}: {
  section: ProjectSettingSection;
  data: SettingsData;
  configuration: ProjectConfiguration;
  displayName: string;
  secrets: Partial<Record<ProjectSecret, string>>;
  busy: boolean;
  locked: boolean;
  onConfiguration: (value: ProjectConfiguration) => void;
  onFilesChanged: () => void;
  onDisplayName: (value: string) => void;
  onSecret: (key: ProjectSecret, value: string) => void;
  onSaveProfile: (event: FormEvent<HTMLFormElement>) => void;
  onSaveConfiguration: (patch: Partial<ProjectConfiguration>, taskId?: string) => Promise<boolean>;
  onSaveSecret: (key: ProjectSecret) => void;
  onSaveTestAccount: () => void;
  onDeleteSecret: (key: ProjectSecret) => void;
  onResourceBinding: (patch: Partial<ProjectResourceBindings>) => void;
}) {
  const disabled = busy || locked;
  if (section === 'general') {
    return (
      <SettingsPanel title="基本资料">
        <form className="form-grid profile-grid" onSubmit={onSaveProfile}>
          <Field
            label="项目显示名称"
            status={displayName === data.detail.project.displayName ? 'success' : undefined}
          >
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
            status="success"
          />
          <ReadOnly label="创建时间" value={formatDate(data.detail.project.createdAt ?? null)} />
          <SaveButton disabled={disabled}>保存基本资料</SaveButton>
        </form>
        <Field label="GitHub Token">
          <SelectBox
            ariaLabel="GitHub Token"
            disabled={disabled}
            value={data.detail.resources.githubCredentialId ?? 'legacy'}
            options={[
              {
                value: 'legacy',
                label: data.detail.secrets.gitToken.configured ? '项目专属旧凭据' : '不使用 Token',
              },
              ...data.resources.githubCredentials.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
            onChange={(value) =>
              onResourceBinding({ githubCredentialId: value === 'legacy' ? null : value })
            }
          />
        </Field>
      </SettingsPanel>
    );
  }
  if (section === 'testing') {
    return (
      <SettingsPanel title="测试策略">
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
          <Field label="场景维护">
            <SelectBox
              ariaLabel="场景维护"
              value={configuration.scenarioMode}
              disabled={disabled}
              options={[
                { value: 'autonomous', label: '自动维护' },
                { value: 'add-only', label: '仅自动新增' },
                { value: 'review-all', label: '全部人工审核' },
              ]}
              onChange={(scenarioMode) =>
                onConfiguration({
                  ...configuration,
                  scenarioMode: scenarioMode as ProjectConfiguration['scenarioMode'],
                })
              }
            />
          </Field>
          <Field
            label={
              <HelpLabel
                label="新场景必加标签（可选）"
                help="罗网创建或更新测试场景时，会确保包含这些标签，便于分类和筛选。多个标签用逗号分隔，例如：核心流程, 冒烟。"
              />
            }
          >
            <input
              placeholder="例如：核心流程, 冒烟"
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
          <Field label="语言">
            <SelectBox
              ariaLabel="语言"
              value={configuration.language}
              disabled={disabled}
              options={
                languageOptions.some((option) => option.value === configuration.language)
                  ? languageOptions
                  : [
                      ...languageOptions,
                      { value: configuration.language, label: configuration.language },
                    ]
              }
              onChange={(language) => onConfiguration({ ...configuration, language })}
            />
          </Field>
          <SaveButton disabled={disabled}>保存测试策略</SaveButton>
        </form>
      </SettingsPanel>
    );
  }
  if (section === 'execution') {
    return (
      <SettingsPanel title="运行环境">
        <div className="settings-stack">
          <form
            className="settings-fields"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveConfiguration({ runtimeMode: configuration.runtimeMode });
            }}
          >
            <Field label="执行服务器">
              <SelectBox
                ariaLabel="执行服务器"
                disabled={disabled}
                value={data.detail.resources.executionServerId ?? 'local'}
                options={[
                  { value: 'local', label: '罗网本机' },
                  ...data.resources.executionServers.map((item) => ({
                    value: item.id,
                    label: item.name,
                    detail: `${item.username}@${item.host}:${item.port}`,
                  })),
                ]}
                onChange={(value) =>
                  onResourceBinding({ executionServerId: value === 'local' ? null : value })
                }
              />
            </Field>
            <Field label="运行模式">
              <SelectBox
                ariaLabel="运行模式"
                disabled={disabled}
                value={configuration.runtimeMode}
                options={[
                  { value: 'managed', label: '罗网启动项目' },
                  { value: 'external', label: '已有测试环境' },
                  { value: 'repository-only', label: '仅仓库测试' },
                ]}
                onChange={(runtimeMode) =>
                  onConfiguration({
                    ...configuration,
                    runtimeMode: runtimeMode as ProjectConfiguration['runtimeMode'],
                  })
                }
              />
            </Field>
            <div className="form-actions">
              {data.detail.resources.executionServerId &&
                (() => {
                  const server = data.resources.executionServers.find(
                    (item) => item.id === data.detail.resources.executionServerId,
                  );
                  return (
                    <StatusLabel tone={server?.remoteExecutionEnabled ? 'success' : 'warning'}>
                      {server?.remoteExecutionEnabled
                        ? `服务器已验证 · 容量 ${server.capacity}`
                        : '服务器待验证'}
                    </StatusLabel>
                  );
                })()}
              <Button variant="secondary" type="submit" disabled={disabled}>
                保存运行方式
              </Button>
            </div>
          </form>
          {configuration.runtimeMode === 'managed' && (
            <ProjectEnvironmentEditor
              projectId={data.detail.project.projectId}
              recommendation={data.detail.environmentRecommendation}
              configuration={data.detail.configuration}
              hasUnsavedConfiguration={
                JSON.stringify(configuration) !== JSON.stringify(data.detail.configuration)
              }
              managedFiles={data.detail.managedFiles}
              disabled={disabled}
              onSave={onSaveConfiguration}
            />
          )}
          {configuration.runtimeMode === 'external' && (
            <form
              className="settings-fields"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveConfiguration(sectionValue('environment', configuration));
              }}
            >
              <Field label="测试网址">
                <input
                  type="url"
                  required
                  value={configuration.baseUrl}
                  disabled={disabled}
                  placeholder="https://test.example.com"
                  onChange={(event) =>
                    onConfiguration({ ...configuration, baseUrl: event.target.value })
                  }
                />
              </Field>
              <Field label="环境备注（可选）">
                <textarea
                  value={configuration.environmentDescription}
                  disabled={disabled}
                  onChange={(event) =>
                    onConfiguration({
                      ...configuration,
                      environmentDescription: event.target.value,
                    })
                  }
                />
              </Field>
              <div className="form-actions">
                <SaveButton disabled={disabled}>保存测试网址</SaveButton>
              </div>
            </form>
          )}
          <details className="settings-details">
            <summary>运行参数（高级）</summary>
            <form
              className="settings-fields"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveConfiguration(sectionValue('execution', configuration));
              }}
            >
              {configuration.runtimeMode === 'managed' && (
                <Field label="启动方式">
                  <SelectBox
                    ariaLabel="启动方式"
                    disabled={disabled}
                    value={configuration.startType}
                    options={[
                      { value: 'single-container', label: '单容器' },
                      { value: 'compose', label: 'Docker Compose' },
                    ]}
                    onChange={(startType) =>
                      onConfiguration({
                        ...configuration,
                        startType: startType as ProjectConfiguration['startType'],
                      })
                    }
                  />
                </Field>
              )}
              <Field
                label={
                  <HelpLabel
                    label="执行 Dockerfile"
                    help="填写仓库内路径。留空使用罗网内置执行镜像。"
                  />
                }
              >
                <input
                  aria-label="执行 Dockerfile"
                  value={configuration.executionDockerfile}
                  disabled={disabled}
                  onChange={(event) =>
                    onConfiguration({ ...configuration, executionDockerfile: event.target.value })
                  }
                />
              </Field>
              {configuration.runtimeMode !== 'external' && (
                <Field label="环境备注（可选）">
                  <textarea
                    value={configuration.environmentDescription}
                    disabled={disabled}
                    onChange={(event) =>
                      onConfiguration({
                        ...configuration,
                        environmentDescription: event.target.value,
                      })
                    }
                  />
                </Field>
              )}
              {configuration.runtimeMode === 'managed' &&
                configuration.startType === 'single-container' && (
                  <>
                    <Field label="准备命令（每行一个参数）">
                      <textarea
                        value={configuration.runtime.prepareCommand.join('\n')}
                        disabled={disabled}
                        onChange={(event) =>
                          onConfiguration({
                            ...configuration,
                            runtime: {
                              ...configuration.runtime,
                              prepareCommand: event.target.value.split('\n').filter(Boolean),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field label="启动命令（每行一个参数）">
                      <textarea
                        value={configuration.runtime.startCommand.join('\n')}
                        disabled={disabled}
                        onChange={(event) =>
                          onConfiguration({
                            ...configuration,
                            runtime: {
                              ...configuration.runtime,
                              startCommand: event.target.value.split('\n').filter(Boolean),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field label="服务端口">
                      <NumberInput
                        ariaLabel="服务端口"
                        width="full"
                        min={1}
                        max={65535}
                        step={1}
                        value={configuration.runtime.servicePort ?? 3000}
                        disabled={disabled}
                        onChange={(servicePort) =>
                          onConfiguration({
                            ...configuration,
                            runtime: { ...configuration.runtime, servicePort },
                          })
                        }
                      />
                    </Field>
                  </>
                )}
              {configuration.runtimeMode === 'managed' && configuration.startType === 'compose' && (
                <>
                  <Field label="Compose 文件">
                    <input
                      value={configuration.runtime.composeFile}
                      disabled={disabled}
                      onChange={(event) =>
                        onConfiguration({
                          ...configuration,
                          runtime: { ...configuration.runtime, composeFile: event.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="启用服务（逗号分隔）">
                    <input
                      value={configuration.runtime.composeServices.join(', ')}
                      disabled={disabled}
                      onChange={(event) =>
                        onConfiguration({
                          ...configuration,
                          runtime: {
                            ...configuration.runtime,
                            composeServices: event.target.value
                              .split(',')
                              .map((item) => item.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="应用服务">
                    <input
                      value={configuration.runtime.applicationService}
                      disabled={disabled}
                      onChange={(event) =>
                        onConfiguration({
                          ...configuration,
                          runtime: {
                            ...configuration.runtime,
                            applicationService: event.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="测试命令服务">
                    <input
                      value={configuration.runtime.commandService}
                      disabled={disabled}
                      onChange={(event) =>
                        onConfiguration({
                          ...configuration,
                          runtime: { ...configuration.runtime, commandService: event.target.value },
                        })
                      }
                    />
                  </Field>
                </>
              )}
              {configuration.runtimeMode === 'managed' && (
                <>
                  <Field label="健康检查路径">
                    <input
                      value={configuration.runtime.healthPath}
                      disabled={disabled}
                      onChange={(event) =>
                        onConfiguration({
                          ...configuration,
                          runtime: { ...configuration.runtime, healthPath: event.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="健康检查超时（秒）">
                    <NumberInput
                      ariaLabel="健康检查超时"
                      width="full"
                      min={5}
                      max={600}
                      step={5}
                      value={configuration.runtime.healthTimeoutSeconds}
                      disabled={disabled}
                      onChange={(healthTimeoutSeconds) =>
                        onConfiguration({
                          ...configuration,
                          runtime: { ...configuration.runtime, healthTimeoutSeconds },
                        })
                      }
                    />
                  </Field>
                </>
              )}
              <div className="form-actions">
                <AppLink
                  className="text-link"
                  to={{ name: 'project-readiness', projectId: data.detail.project.projectId }}
                >
                  查看运行准备
                </AppLink>
                <SaveButton disabled={disabled}>保存执行环境</SaveButton>
              </div>
            </form>
          </details>
          <details className="settings-details">
            <summary>浏览器额外来源</summary>
            <form
              className="settings-stack"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveConfiguration({ browserAllowedOrigins: configuration.browserAllowedOrigins });
              }}
            >
              <Field label="浏览器额外来源">
                <textarea
                  value={configuration.browserAllowedOrigins.join('\n')}
                  disabled={disabled}
                  onChange={(event) =>
                    onConfiguration({
                      ...configuration,
                      browserAllowedOrigins: event.target.value
                        .split(/[\n,]/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <div className="form-actions">
                <SaveButton disabled={disabled}>保存额外来源</SaveButton>
              </div>
            </form>
          </details>
        </div>
      </SettingsPanel>
    );
  }
  if (section === 'automation')
    return (
      <SettingsPanel title="触发规则">
        <ProjectTriggerSettings
          configuration={configuration}
          disabled={disabled}
          onChange={onConfiguration}
          onSave={onSaveConfiguration}
        />
      </SettingsPanel>
    );
  return (
    <SettingsPanel title="测试数据">
      <div className="settings-stack">
        <ProjectManagedFilesSettings
          projectId={data.detail.project.projectId}
          files={data.detail.managedFiles.filter((file) => file.purpose === 'data')}
          disabled={disabled}
          onChanged={onFilesChanged}
          title="初始数据文件"
          defaultPurpose="data"
          embedded
        />
        <section className="settings-group" aria-labelledby="test-account-title">
          <header>
            <h3 id="test-account-title">测试账号</h3>
          </header>
          <form
            className="settings-stack"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveTestAccount();
            }}
          >
            <div className="settings-fields">
              {(['testUsername', 'testPassword'] as const).map((key) => (
                <ProjectSecretEditor
                  key={key}
                  secretKey={key}
                  label={key === 'testUsername' ? '账号' : '密码'}
                  metadata={data.detail.secrets[key]}
                  value={secrets[key] ?? ''}
                  disabled={disabled}
                  onChange={(value) => onSecret(key, value)}
                  onDelete={() => onDeleteSecret(key)}
                />
              ))}
            </div>
            <div className="form-actions">
              <Button
                type="submit"
                disabled={disabled || (!secrets.testUsername && !secrets.testPassword)}
              >
                保存测试账号
              </Button>
            </div>
          </form>
        </section>
        <details className="settings-details">
          <summary>测试后清理（可选）</summary>
          <div className="settings-fields">
            <form
              className="settings-stack"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveConfiguration({ testDataCleanupUrl: configuration.testDataCleanupUrl });
              }}
            >
              <Field
                label={
                  <HelpLabel
                    label="清理接口地址"
                    help="已有测试环境提供的清理接口，用于测试后删除本次产生的数据。罗网启动的临时容器和数据卷会自动清理，无需填写。"
                  />
                }
              >
                <input
                  type="url"
                  aria-label="清理接口地址"
                  placeholder="https://test.example.com/test-data"
                  value={configuration.testDataCleanupUrl}
                  disabled={disabled}
                  onChange={(event) =>
                    onConfiguration({ ...configuration, testDataCleanupUrl: event.target.value })
                  }
                />
              </Field>
              <div className="form-actions">
                <Button type="submit" variant="secondary" disabled={disabled}>
                  保存清理地址
                </Button>
              </div>
            </form>
            <ProjectSecretEditor
              secretKey="testDataCleanupToken"
              label={
                <HelpLabel
                  label="清理接口 Token"
                  help="罗网调用清理接口时使用的授权值，由该接口提供。没有清理接口时无需配置。"
                />
              }
              metadata={data.detail.secrets.testDataCleanupToken}
              value={secrets.testDataCleanupToken ?? ''}
              disabled={disabled}
              onChange={(value) => onSecret('testDataCleanupToken', value)}
              onSave={() => onSaveSecret('testDataCleanupToken')}
              onDelete={() => onDeleteSecret('testDataCleanupToken')}
            />
          </div>
        </details>
      </div>
    </SettingsPanel>
  );
}

function ProjectSecretEditor({
  secretKey,
  label,
  metadata,
  value,
  disabled,
  onChange,
  onSave,
  onDelete,
}: {
  secretKey: ProjectSecret;
  label: ReactNode;
  metadata: ProjectDetailResponse['secrets'][ProjectSecret];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="settings-stack credential-editor">
      <Field
        label={
          <span className="credential-field-label">
            {label}
            <StatusLabel tone={metadata.configured ? 'success' : 'warning'}>
              {metadata.configured ? '已配置' : '未配置'}
            </StatusLabel>
          </span>
        }
      >
        <input
          type="password"
          aria-label={secretLabels[secretKey]}
          autoComplete="new-password"
          placeholder={metadata.configured ? '输入新值' : ''}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      {(metadata.configured || onSave) && (
        <div className="form-actions">
          {metadata.configured && (
            <Button
              type="button"
              variant="secondary"
              aria-label={`清除${secretLabels[secretKey]}`}
              disabled={disabled}
              onClick={onDelete}
            >
              清除
            </Button>
          )}
          {onSave && (
            <Button
              type="button"
              variant="secondary"
              aria-label={`保存${secretLabels[secretKey]}`}
              disabled={disabled || !value}
              onClick={onSave}
            >
              保存
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-panel">
      <header>
        <span className="scope-label">项目设置</span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}
function SaveButton({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return (
    <Button type="submit" disabled={disabled}>
      {children}
    </Button>
  );
}
function ReadOnly({ label, value, status }: { label: string; value: string; status?: 'success' }) {
  return (
    <div className="read-only-field" data-status={status}>
      <span>
        {label}
        {status === 'success' && (
          <span className="field-status" role="img" aria-label="已核验">
            ✓
          </span>
        )}
      </span>
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
        browserAllowedOrigins: config.browserAllowedOrigins,
      };
    case 'execution':
      return {
        executionDockerfile: config.executionDockerfile,
        runtimeMode: config.runtimeMode,
        startType: config.startType,
        runtime: config.runtime,
        generatedDefinition: config.generatedDefinition,
        ...sectionValue('environment', config),
      };
    case 'automation':
      return {
        pollIntervalSeconds: config.pollIntervalSeconds,
        cron: config.cron,
        scheduleIntervalSeconds: config.scheduleIntervalSeconds ?? 0,
        triggerOnCommit: config.triggerOnCommit,
      };
    default:
      return {};
  }
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '未知';
}
