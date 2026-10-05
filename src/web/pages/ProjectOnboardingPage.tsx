import { useCallback, useMemo, useState, type FormEvent } from 'react';

import type { ConsoleReadinessSnapshot } from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { useNavigation } from '../app/navigation';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { AppMessageFeedback, useAppMessage } from '../components/AppMessageProvider';
import { Field, SelectBox } from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';
import type {
  ProjectConfiguration,
  ProjectDetailResponse,
  ProjectReference,
  ProjectSecret,
  ConnectionResourcesResponse,
} from '../project-types';

type OnboardingData = {
  detail: ProjectDetailResponse;
  readiness: ConsoleReadinessSnapshot | null;
};

const onboardingError = (cause: unknown) => toUserMessage(cause, '项目接入状态读取失败');
const languageOptions = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
];

const secretFields: Array<{
  key: ProjectSecret;
  label: string;
  help: string;
  placeholder: string;
}> = [
  {
    key: 'gitToken',
    label: '仓库访问 Token',
    help: '访问私有仓库或提高 GitHub API 限额时使用。创建项目时选择的共享 Token 已自动配置。',
    placeholder: '粘贴新的 GitHub Token',
  },
  {
    key: 'testUsername',
    label: '测试账号（可选）',
    help: '被测系统需要登录时填写专用的非生产账号，并同时配置测试密码。',
    placeholder: '输入测试环境登录账号',
  },
  {
    key: 'testPassword',
    label: '测试密码（可选）',
    help: '被测系统需要登录时填写测试账号对应的密码。',
    placeholder: '输入测试环境登录密码',
  },
  {
    key: 'testDataCleanupToken',
    label: '测试数据清理 Token（可选）',
    help: '仅在被测项目提供按 Run 清理测试数据的接口时填写专用 Token。',
    placeholder: '输入清理接口的 Token',
  },
];

export function ProjectOnboardingPage({
  projects,
  onProjectsChanged,
}: {
  projects: ProjectReference[];
  onProjectsChanged: () => Promise<void>;
}) {
  const navigation = useNavigation();
  const notify = useAppMessage();
  const requestedProjectId = new URLSearchParams(window.location.search).get('projectId');
  const projectId =
    requestedProjectId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestedProjectId,
    )
      ? requestedProjectId
      : null;
  const load = useCallback(
    async (signal: AbortSignal): Promise<OnboardingData | null> => {
      if (!projectId) return null;
      const [detail, status] = await Promise.all([
        requestJson<ProjectDetailResponse>(`/api/projects/${projectId}`, { signal }),
        requestJson<{ readiness: ConsoleReadinessSnapshot | null }>(
          `/api/projects/${projectId}/readiness/status`,
          { signal },
        ),
      ]);
      return { detail, readiness: status.readiness };
    },
    [projectId],
  );
  const resource = useResource(`onboarding:${projectId ?? 'new'}`, load, onboardingError);
  const connectionResource = useResource(
    'onboarding-connections',
    useCallback(
      (signal: AbortSignal) =>
        requestJson<ConnectionResourcesResponse>('/api/connection-resources', { signal }),
      [],
    ),
    (cause) => toUserMessage(cause, '连接资源读取失败'),
  );
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [credentialChoice, setCredentialChoice] = useState('none');
  const [serverChoice, setServerChoice] = useState('local');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [configurationDraft, setConfigurationDraft] = useState<ProjectConfiguration | null>(null);
  const [secretValues, setSecretValues] = useState<Partial<Record<ProjectSecret, string>>>({});
  const data = resource.value;
  const configuration = configurationDraft ?? data?.detail.configuration ?? null;
  const resumable = projects.filter(
    (project) => project.status === 'paused' && project.projectId !== projectId,
  );
  const checks = useMemo(
    () => new Map(data?.readiness?.checks.map((check) => [check.id, check]) ?? []),
    [data],
  );
  const stepDone = [
    Boolean(projectId),
    Boolean(data?.detail),
    checkOk(checks.get('environment')) && checkOk(checks.get('credentials')),
    data?.detail.project.status === 'active',
  ];
  const currentStep = Math.max(
    0,
    stepDone.findIndex((done) => !done),
  );

  function stepStatus(index: number): StepStatus {
    if (stepDone[index]) return 'completed';
    return index === currentStep ? 'current' : 'upcoming';
  }

  function goToStep(index: number) {
    document
      .getElementById(`onboarding-step-${index + 1}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('create');
    setActionError('');
    try {
      const response = await requestJson<{ project: ProjectReference }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          displayName: name,
          repositoryUrl,
          ...(credentialChoice !== 'none' ? { githubCredentialId: credentialChoice } : {}),
          ...(serverChoice !== 'local' ? { executionServerId: serverChoice } : {}),
        }),
      });
      await onProjectsChanged();
      notify.success('项目已连接');
      navigation.navigate(
        `/projects/new?projectId=${encodeURIComponent(response.project.projectId)}`,
        {
          replace: true,
        },
      );
    } catch (cause) {
      setActionError(toUserMessage(cause, '连接项目失败'));
    } finally {
      setBusy('');
    }
  }

  async function action(label: string, operation: () => Promise<unknown>) {
    setBusy(label);
    setMessage('');
    setActionError('');
    try {
      await operation();
      await onProjectsChanged();
      resource.reload();
      setMessage(`${label}完成`);
    } catch (cause) {
      setActionError(toUserMessage(cause, `${label}失败`));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="page-content onboarding-page">
      <PageHeading title="接入项目" scope="全局" />
      <div className="page-body onboarding-layout">
        <AppMessageFeedback success={message} error={actionError} />
        <ol className="onboarding-steps" aria-label="项目接入步骤">
          {['连接仓库', '配置测试', '配置环境', '准备并启用'].map((title, index) => (
            <Step
              key={title}
              number={String(index + 1).padStart(2, '0')}
              title={title}
              status={stepStatus(index)}
              onSelect={stepDone[index] ? () => goToStep(index) : undefined}
            />
          ))}
        </ol>
        {!projectId ? (
          <ConnectRepository
            name={name}
            repositoryUrl={repositoryUrl}
            credentialChoice={credentialChoice}
            serverChoice={serverChoice}
            resources={connectionResource.value ?? { githubCredentials: [], executionServers: [] }}
            busy={busy === 'create'}
            resumable={resumable}
            onName={setName}
            onRepositoryUrl={setRepositoryUrl}
            onCredentialChoice={setCredentialChoice}
            onServerChoice={setServerChoice}
            onAddCredential={() => navigation.navigate('/settings/github')}
            onAddServer={() => navigation.navigate('/settings/servers')}
            onSubmit={createProject}
            onResume={(id) =>
              navigation.navigate(`/projects/new?projectId=${encodeURIComponent(id)}`)
            }
          />
        ) : (
          <AsyncRegion
            loading={resource.loading && !data}
            error={!data ? resource.error : ''}
            onRetry={resource.reload}
          >
            {data && configuration && (
              <div className="onboarding-sections">
                <RepositoryStep data={data} />
                <TestingStep
                  configuration={configuration}
                  busy={Boolean(busy)}
                  onChange={setConfigurationDraft}
                  onSave={() =>
                    void action('保存测试配置', () =>
                      requestJson(`/api/projects/${projectId}/configuration`, {
                        method: 'PUT',
                        body: JSON.stringify(configuration),
                      }),
                    )
                  }
                />
                <EnvironmentStep
                  data={data}
                  configuration={configuration}
                  secretValues={secretValues}
                  busy={Boolean(busy)}
                  onChange={setConfigurationDraft}
                  onSecretChange={(key, value) =>
                    setSecretValues((current) => ({ ...current, [key]: value }))
                  }
                  onSaveConfiguration={() =>
                    void action('保存环境配置', () =>
                      requestJson(`/api/projects/${projectId}/configuration`, {
                        method: 'PUT',
                        body: JSON.stringify(configuration),
                      }),
                    )
                  }
                  onSaveSecret={(key) => {
                    const value = secretValues[key];
                    if (!value) return;
                    void action(
                      `保存${secretFields.find((field) => field.key === key)?.label ?? '凭据'}`,
                      async () => {
                        await requestJson(`/api/projects/${projectId}/secrets/${key}`, {
                          method: 'PUT',
                          body: JSON.stringify({ value }),
                        });
                        setSecretValues((current) => ({ ...current, [key]: '' }));
                      },
                    );
                  }}
                />
                <EnableStep
                  data={data}
                  busy={Boolean(busy)}
                  onPrepareImage={() =>
                    void action('准备执行镜像', () =>
                      requestJson(`/api/projects/${projectId}/image/prepare`, {
                        method: 'POST',
                        body: '{}',
                      }),
                    )
                  }
                  onCheck={() =>
                    void action('运行准备检查', () =>
                      requestJson(`/api/projects/${projectId}/readiness/check`, { method: 'POST' }),
                    )
                  }
                  onEnable={() =>
                    void action('启用项目', () =>
                      requestJson(`/api/projects/${projectId}/resume`, { method: 'POST' }),
                    )
                  }
                />
              </div>
            )}
          </AsyncRegion>
        )}
      </div>
    </section>
  );
}

type StepStatus = 'completed' | 'current' | 'upcoming';

function Step({
  number,
  title,
  status,
  onSelect,
}: {
  number: string;
  title: string;
  status: StepStatus;
  onSelect?: () => void;
}) {
  const statusLabel = {
    completed: '已完成',
    current: '当前步骤',
    upcoming: '未开始',
  }[status];
  return (
    <li className={`step-${status}`}>
      <button
        type="button"
        disabled={!onSelect}
        aria-current={status === 'current' ? 'step' : undefined}
        aria-label={`${number} ${title}，${statusLabel}${onSelect ? '，点击返回' : ''}`}
        onClick={onSelect}
      >
        <span>{number}</span>
        <strong>{title}</strong>
        <small>{statusLabel}</small>
      </button>
    </li>
  );
}

function ConnectRepository({
  name,
  repositoryUrl,
  credentialChoice,
  serverChoice,
  resources,
  busy,
  resumable,
  onName,
  onRepositoryUrl,
  onCredentialChoice,
  onServerChoice,
  onAddCredential,
  onAddServer,
  onSubmit,
  onResume,
}: {
  name: string;
  repositoryUrl: string;
  credentialChoice: string;
  serverChoice: string;
  resources: ConnectionResourcesResponse;
  busy: boolean;
  resumable: ProjectReference[];
  onName: (value: string) => void;
  onRepositoryUrl: (value: string) => void;
  onCredentialChoice: (value: string) => void;
  onServerChoice: (value: string) => void;
  onAddCredential: () => void;
  onAddServer: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onResume: (projectId: string) => void;
}) {
  return (
    <section id="onboarding-step-1" className="onboarding-section" aria-labelledby="connect-title">
      <div className="section-number">01</div>
      <div>
        <h2 id="connect-title">连接仓库</h2>
        <p>罗网会核验 GitHub 仓库身份。完成后继续配置；启用前不会运行测试。</p>
        <form className="form-grid" onSubmit={onSubmit}>
          <Field label="项目名称">
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => onName(event.target.value)}
            />
          </Field>
          <Field label="GitHub 仓库地址">
            <input
              required
              type="url"
              placeholder="https://github.com/owner/repository"
              value={repositoryUrl}
              onChange={(event) => onRepositoryUrl(event.target.value)}
            />
          </Field>
          <div className="field resource-picker-field">
            <span>GitHub Token</span>
            <div className="resource-picker-row">
              <SelectBox
                ariaLabel="GitHub Token"
                value={credentialChoice}
                options={[
                  { value: 'none', label: '不使用 Token（公开仓库）' },
                  ...resources.githubCredentials.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ]}
                onChange={onCredentialChoice}
              />
              <button
                className="button button-secondary resource-add-button"
                type="button"
                onClick={onAddCredential}
              >
                新增
              </button>
            </div>
          </div>
          <div className="field resource-picker-field">
            <span>执行服务器</span>
            <div className="resource-picker-row">
              <SelectBox
                ariaLabel="执行服务器"
                value={serverChoice}
                options={[
                  { value: 'local', label: '罗网本机' },
                  ...resources.executionServers.map((item) => ({
                    value: item.id,
                    label: item.name,
                    detail: `${item.username}@${item.host}`,
                  })),
                ]}
                onChange={onServerChoice}
              />
              <button
                className="button button-secondary resource-add-button"
                type="button"
                onClick={onAddServer}
              >
                新增
              </button>
            </div>
          </div>
          <button className="button" type="submit" disabled={busy}>
            {busy ? '正在验证…' : '验证仓库并继续'}
          </button>
        </form>
        {resumable.length > 0 && (
          <div className="resume-list">
            <h3>继续未启用的项目</h3>
            {resumable.map((project) => (
              <button
                type="button"
                key={project.projectId}
                onClick={() => onResume(project.projectId)}
              >
                <strong>{project.displayName}</strong>
                <span>
                  {project.repositoryOwner}/{project.repositoryName}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RepositoryStep({ data }: { data: OnboardingData }) {
  return (
    <section
      id="onboarding-step-1"
      className="onboarding-section completed"
      aria-labelledby="repository-title"
    >
      <div className="section-number">01</div>
      <div>
        <h2 id="repository-title">连接仓库</h2>
        <StatusLabel tone="success">已核验</StatusLabel>
        <p>
          {data.detail.project.displayName} · {data.detail.project.repositoryOwner}/
          {data.detail.project.repositoryName}
        </p>
      </div>
    </section>
  );
}

function TestingStep({
  configuration,
  busy,
  onChange,
  onSave,
}: {
  configuration: ProjectConfiguration;
  busy: boolean;
  onChange: (value: ProjectConfiguration) => void;
  onSave: () => void;
}) {
  const languages = languageOptions.some((option) => option.value === configuration.language)
    ? languageOptions
    : [...languageOptions, { value: configuration.language, label: configuration.language }];
  return (
    <section id="onboarding-step-2" className="onboarding-section" aria-labelledby="testing-title">
      <div className="section-number">02</div>
      <div>
        <h2 id="testing-title">配置测试</h2>
        <div className="form-grid compact-form">
          <Field label="语言">
            <SelectBox
              ariaLabel="语言"
              value={configuration.language}
              options={languages}
              onChange={(language) => onChange({ ...configuration, language })}
            />
          </Field>
          <Field label="场景维护">
            <SelectBox
              ariaLabel="场景维护"
              value={configuration.scenarioMode}
              options={[
                { value: 'autonomous', label: '自动维护' },
                { value: 'add-only', label: '仅自动新增' },
                { value: 'review-all', label: '全部人工审核' },
              ]}
              onChange={(scenarioMode) =>
                onChange({
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
              onChange={(event) =>
                onChange({
                  ...configuration,
                  scenarioLabels: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <button className="button" type="button" disabled={busy} onClick={onSave}>
            保存测试配置
          </button>
        </div>
      </div>
    </section>
  );
}

function EnvironmentStep({
  data,
  configuration,
  secretValues,
  busy,
  onChange,
  onSecretChange,
  onSaveConfiguration,
  onSaveSecret,
}: {
  data: OnboardingData;
  configuration: ProjectConfiguration;
  secretValues: Partial<Record<ProjectSecret, string>>;
  busy: boolean;
  onChange: (value: ProjectConfiguration) => void;
  onSecretChange: (key: ProjectSecret, value: string) => void;
  onSaveConfiguration: () => void;
  onSaveSecret: (key: ProjectSecret) => void;
}) {
  return (
    <section
      id="onboarding-step-3"
      className="onboarding-section"
      aria-labelledby="environment-title"
    >
      <div className="section-number">03</div>
      <div>
        <h2 id="environment-title">配置环境</h2>
        <div className="form-grid compact-form">
          <Field
            label={
              <HelpLabel
                label="测试环境地址"
                help="被测系统的非生产网址，罗网会从这个地址开始浏览器测试。"
              />
            }
          >
            <input
              type="url"
              placeholder="https://staging.example.com"
              value={configuration.baseUrl}
              onChange={(event) => onChange({ ...configuration, baseUrl: event.target.value })}
            />
          </Field>
          <Field
            label={
              <HelpLabel
                label="测试环境备注（可选）"
                help="写给测试组长的环境规则，例如可用数据、功能限制或禁止操作；不要填写密码和 Token。"
              />
            }
          >
            <textarea
              placeholder="例如：使用合成数据；禁止发送真实短信"
              value={configuration.environmentDescription}
              onChange={(event) =>
                onChange({ ...configuration, environmentDescription: event.target.value })
              }
            />
          </Field>
          <button className="button" type="button" disabled={busy} onClick={onSaveConfiguration}>
            保存环境配置
          </button>
        </div>
        <div className="secret-grid">
          {secretFields.map(({ key, label, help, placeholder }) => {
            const configured = data.detail.secrets[key]?.configured;
            return (
              <div className="secret-editor" data-configured={configured} key={key}>
                <Field label={<HelpLabel label={label} help={help} />}>
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={configured ? '已配置 · 输入新值可替换' : placeholder}
                    value={secretValues[key] ?? ''}
                    onChange={(event) => onSecretChange(key, event.target.value)}
                  />
                </Field>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy || !secretValues[key]}
                  onClick={() => onSaveSecret(key)}
                >
                  保存
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function EnableStep({
  data,
  busy,
  onPrepareImage,
  onCheck,
  onEnable,
}: {
  data: OnboardingData;
  busy: boolean;
  onPrepareImage: () => void;
  onCheck: () => void;
  onEnable: () => void;
}) {
  const readiness = data.readiness;
  const readinessStatus = readiness?.status ?? 'not_checked';
  return (
    <section id="onboarding-step-4" className="onboarding-section" aria-labelledby="enable-title">
      <div className="section-number">04</div>
      <div>
        <h2 id="enable-title">准备并启用</h2>
        <div className="readiness-summary">
          <StatusLabel tone={readinessStatus === 'ready' ? 'success' : 'warning'}>
            {readinessLabel(readinessStatus)}
          </StatusLabel>
          <small>
            {readiness?.checkedAt ? `检查于 ${formatDate(readiness.checkedAt)}` : '尚未检查'}
          </small>
        </div>
        <ul className="check-list">
          {(readiness?.checks ?? []).map((check) => (
            <li key={check.id}>
              <strong>{check.label}</strong>
              <span>{check.message}</span>
              <StatusLabel tone={check.status === 'ok' ? 'success' : 'warning'}>
                {check.status}
              </StatusLabel>
            </li>
          ))}
        </ul>
        <div className="page-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={onPrepareImage}
          >
            准备执行镜像
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={onCheck}
          >
            运行全部检查
          </button>
          <button
            className="button"
            type="button"
            disabled={
              busy || readinessStatus !== 'ready' || data.detail.project.status === 'active'
            }
            onClick={onEnable}
          >
            {data.detail.project.status === 'active' ? '项目已启用' : '明确启用项目'}
          </button>
        </div>
      </div>
    </section>
  );
}

function checkOk(check: { status: string } | undefined): boolean {
  return check?.status === 'ok';
}

function readinessLabel(status: ConsoleReadinessSnapshot['status']): string {
  return {
    ready: '准备完成',
    not_ready: '尚未就绪',
    stale: '需要重检',
    not_checked: '尚未检查',
    error: '检查异常',
  }[status];
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

function HelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="field-label-with-help">
      {label}
      <span className="field-help" tabIndex={0} role="img" aria-label={help} title={help}>
        ?
      </span>
    </span>
  );
}
