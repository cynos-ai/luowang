import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../api';
import { useNavigation } from '../app/navigation';
import { useResource } from '../app/resource';
import { AppMessageFeedback, useAppMessage } from '../components/AppMessageProvider';
import { Field, SelectBox } from '../components/FormControls';
import { PageHeading } from '../components/PageHeading';
import type { ConnectionResourcesResponse, ProjectReference } from '../project-types';

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resumable = projects.filter((project) => project.status === 'paused');

  useEffect(() => {
    if (!requestedProjectId || !PROJECT_ID.test(requestedProjectId)) return;
    navigation.navigate(
      { name: 'project-settings', projectId: requestedProjectId, section: 'general' },
      { replace: true },
    );
  }, [navigation, requestedProjectId]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
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
      notify.success('项目已连接，请继续完成项目设置');
      navigation.navigate(
        { name: 'project-settings', projectId: response.project.projectId, section: 'testing' },
        { replace: true },
      );
    } catch (cause) {
      setError(toUserMessage(cause, '连接项目失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page-content onboarding-page">
      <PageHeading title="接入新项目" scope="全局" />
      <div className="page-body onboarding-layout onboarding-create-layout">
        <AppMessageFeedback error={error} />
        <section className="onboarding-section" aria-labelledby="connect-title">
          <div className="section-number">01</div>
          <div>
            <h2 id="connect-title">连接仓库</h2>
            <p>完成仓库验证后，进入统一的项目设置继续配置。</p>
            <form className="form-grid" onSubmit={createProject}>
              <Field label="项目名称">
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="GitHub 仓库地址">
                <input
                  required
                  type="url"
                  placeholder="https://github.com/owner/repository"
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
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
                      ...(connectionResource.value?.githubCredentials ?? []).map((item) => ({
                        value: item.id,
                        label: item.name,
                      })),
                    ]}
                    onChange={setCredentialChoice}
                  />
                  <button
                    className="button button-secondary resource-add-button"
                    type="button"
                    onClick={() => navigation.navigate('/settings/github')}
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
                      ...(connectionResource.value?.executionServers ?? []).map((item) => ({
                        value: item.id,
                        label: item.name,
                        detail: `${item.username}@${item.host}`,
                      })),
                    ]}
                    onChange={setServerChoice}
                  />
                  <button
                    className="button button-secondary resource-add-button"
                    type="button"
                    onClick={() => navigation.navigate('/settings/servers')}
                  >
                    新增
                  </button>
                </div>
              </div>
              <button className="button" type="submit" disabled={busy}>
                {busy ? '正在验证…' : '验证仓库并进入项目设置'}
              </button>
            </form>
            {resumable.length > 0 && (
              <div className="resume-list">
                <h3>继续配置未启用的项目</h3>
                {resumable.map((project) => (
                  <button
                    type="button"
                    key={project.projectId}
                    onClick={() =>
                      navigation.navigate({
                        name: 'project-settings',
                        projectId: project.projectId,
                        section: 'general',
                      })
                    }
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
      </div>
    </section>
  );
}
