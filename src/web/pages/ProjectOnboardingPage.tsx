import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../api';
import { useNavigation } from '../app/navigation';
import { useResource } from '../app/resource';
import { AppMessageFeedback, useAppMessage } from '../components/AppMessageProvider';
import { Field, SelectBox } from '../components/FormControls';
import type { ConnectionResourcesResponse, ProjectReference } from '../project-types';
import { ProjectsPage } from './ProjectsPage';

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ProjectOnboardingPage({
  onProjectsChanged,
}: {
  onProjectsChanged: () => Promise<void>;
}) {
  const navigation = useNavigation();
  const notify = useAppMessage();
  const dialog = useRef<HTMLDialogElement>(null);
  const requestedProjectId = new URLSearchParams(window.location.search).get('projectId');
  const legacyProjectId =
    requestedProjectId && PROJECT_ID.test(requestedProjectId) ? requestedProjectId : null;
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
  useEffect(() => {
    if (!legacyProjectId) return;
    navigation.navigate(
      { name: 'project-settings', projectId: legacyProjectId, section: 'general' },
      { replace: true },
    );
  }, [legacyProjectId, navigation]);

  useEffect(() => {
    const element = dialog.current;
    if (!element || legacyProjectId || element.open) return;
    element.showModal();
  }, [legacyProjectId]);

  function close() {
    if (busy) return;
    navigation.navigate({ name: 'projects' }, { replace: true });
  }

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
    <>
      <ProjectsPage onProjectsChanged={onProjectsChanged} />
      <dialog
        ref={dialog}
        className="project-onboarding-dialog"
        aria-labelledby="connect-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="project-onboarding-dialog-heading">
          <div>
            <span className="scope-label">新项目</span>
            <h2 id="connect-title">连接仓库</h2>
          </div>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={close}>
            ×
          </button>
        </div>
        <p>完成仓库验证后，进入项目设置继续配置。</p>
        <AppMessageFeedback error={error} />
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
          <div className="dialog-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={close}
            >
              取消
            </button>
            <button className="button" type="submit" disabled={busy}>
              {busy ? '正在验证…' : '验证仓库并进入项目设置'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
