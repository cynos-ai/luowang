import { useCallback, useMemo, useState, type FormEvent } from 'react';

import type { ConsoleReadinessSnapshot } from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { useNavigation } from '../app/navigation';
import { useResource } from '../app/resource';
import { AsyncRegion } from '../components/AsyncRegion';
import { Field } from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';
import { StatusLabel } from '../components/StatusLabel';
import type {
  ProjectConfiguration,
  ProjectDetailResponse,
  ProjectReference,
  ProjectSecret,
} from '../project-types';

type OnboardingData = {
  detail: ProjectDetailResponse;
  readiness: ConsoleReadinessSnapshot;
};

const onboardingError = (cause: unknown) => toUserMessage(cause, '项目接入状态读取失败');
const secretFields: Array<[ProjectSecret, string]> = [
  ['gitToken', 'GitHub Token'],
  ['testUsername', '测试账号'],
  ['testPassword', '测试密码'],
  ['testDataCleanupToken', '清理 Token'],
];

export function ProjectOnboardingPage({
  projects,
  onProjectsChanged,
}: {
  projects: ProjectReference[];
  onProjectsChanged: () => Promise<void>;
}) {
  const navigation = useNavigation();
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
        requestJson<{ readiness: ConsoleReadinessSnapshot }>(
          `/api/projects/${projectId}/readiness/status`,
          { signal },
        ),
      ]);
      return { detail, readiness: status.readiness };
    },
    [projectId],
  );
  const resource = useResource(`onboarding:${projectId ?? 'new'}`, load, onboardingError);
  const [name, setName] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [initialToken, setInitialToken] = useState('');
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
    () => new Map(data?.readiness.checks.map((check) => [check.id, check]) ?? []),
    [data],
  );

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
          ...(initialToken ? { gitToken: initialToken } : {}),
        }),
      });
      setInitialToken('');
      await onProjectsChanged();
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
      <PageHeading
        title="接入项目"
        scope="全局"
        description="项目先保持暂停；完成检查后仍需明确启用。"
      />
      <div className="page-body onboarding-layout">
        {message && <p className="notice notice-success">{message}</p>}
        {actionError && <p className="notice notice-error">{actionError}</p>}
        <ol className="onboarding-steps" aria-label="项目接入步骤">
          <Step number="01" title="连接仓库" done={Boolean(projectId)} />
          <Step number="02" title="配置测试" done={Boolean(data?.detail)} />
          <Step
            number="03"
            title="配置环境"
            done={checkOk(checks.get('environment')) && checkOk(checks.get('credentials'))}
          />
          <Step number="04" title="准备并启用" done={data?.detail.project.status === 'active'} />
        </ol>
        {!projectId ? (
          <ConnectRepository
            name={name}
            repositoryUrl={repositoryUrl}
            gitToken={initialToken}
            busy={busy === 'create'}
            resumable={resumable}
            onName={setName}
            onRepositoryUrl={setRepositoryUrl}
            onGitToken={setInitialToken}
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
                      `保存${secretFields.find(([candidate]) => candidate === key)?.[1] ?? '凭据'}`,
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

function Step({ number, title, done }: { number: string; title: string; done: boolean }) {
  return (
    <li className={done ? 'step-done' : ''}>
      <span>{number}</span>
      <strong>{title}</strong>
      <small>{done ? '已完成' : '待处理'}</small>
    </li>
  );
}

function ConnectRepository({
  name,
  repositoryUrl,
  gitToken,
  busy,
  resumable,
  onName,
  onRepositoryUrl,
  onGitToken,
  onSubmit,
  onResume,
}: {
  name: string;
  repositoryUrl: string;
  gitToken: string;
  busy: boolean;
  resumable: ProjectReference[];
  onName: (value: string) => void;
  onRepositoryUrl: (value: string) => void;
  onGitToken: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onResume: (projectId: string) => void;
}) {
  return (
    <section className="onboarding-section" aria-labelledby="connect-title">
      <div className="section-number">01</div>
      <div>
        <h2 id="connect-title">连接仓库</h2>
        <p>罗网会核验 GitHub 仓库身份。新项目创建后保持暂停。</p>
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
          <Field label="GitHub Token（私有仓库必填）" hint="保存后不再回显。">
            <input
              type="password"
              autoComplete="off"
              value={gitToken}
              onChange={(event) => onGitToken(event.target.value)}
            />
          </Field>
          <button className="button" type="submit" disabled={busy}>
            {busy ? '正在核验…' : '核验并创建暂停项目'}
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
    <section className="onboarding-section completed" aria-labelledby="repository-title">
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
  return (
    <section className="onboarding-section" aria-labelledby="testing-title">
      <div className="section-number">02</div>
      <div>
        <h2 id="testing-title">配置测试</h2>
        <div className="form-grid compact-form">
          <Field label="生成语言">
            <input
              value={configuration.language}
              onChange={(event) => onChange({ ...configuration, language: event.target.value })}
            />
          </Field>
          <Field label="场景维护">
            <select
              value={configuration.scenarioMode}
              onChange={(event) =>
                onChange({
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
          <Field label="固定包含的标签" hint="多个标签用逗号分隔。">
            <input
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
    <section className="onboarding-section" aria-labelledby="environment-title">
      <div className="section-number">03</div>
      <div>
        <h2 id="environment-title">配置环境</h2>
        <p className="notice notice-neutral">保存配置不代表环境连通或已经就绪。</p>
        <div className="form-grid compact-form">
          <Field label="非生产环境 URL">
            <input
              type="url"
              value={configuration.baseUrl}
              onChange={(event) => onChange({ ...configuration, baseUrl: event.target.value })}
            />
          </Field>
          <Field label="环境说明">
            <textarea
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
          {secretFields.map(([key, label]) => (
            <div className="secret-editor" key={key}>
              <Field
                label={`${label} · ${data.detail.secrets[key]?.configured ? '已配置' : '未配置'}`}
                hint="留空不会更改已保存值。"
              >
                <input
                  type="password"
                  autoComplete="off"
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
          ))}
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
  return (
    <section className="onboarding-section" aria-labelledby="enable-title">
      <div className="section-number">04</div>
      <div>
        <h2 id="enable-title">准备并启用</h2>
        <div className="readiness-summary">
          <StatusLabel tone={data.readiness.status === 'ready' ? 'success' : 'warning'}>
            {readinessLabel(data.readiness.status)}
          </StatusLabel>
          <small>
            {data.readiness.checkedAt
              ? `检查于 ${formatDate(data.readiness.checkedAt)}`
              : '尚未检查'}
          </small>
        </div>
        <ul className="check-list">
          {data.readiness.checks.map((check) => (
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
              busy || data.readiness.status !== 'ready' || data.detail.project.status === 'active'
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
