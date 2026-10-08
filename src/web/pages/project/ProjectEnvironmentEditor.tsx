import { useEffect, useState } from 'react';
import { Button, Field, StatusLabel, useAppMessage } from '../../components/ui';
import { ApiError, requestJson, toUserMessage } from '../../api';
import type { ProjectConfiguration } from '../../project-types';
import { useNavigationBlocker } from '../../app/navigation';
import {
  ENVIRONMENT_STAGES,
  type EnvironmentValidationTask,
} from '../../../shared/environment-preparation';

type Draft = {
  generatedDefinition: NonNullable<ProjectConfiguration['generatedDefinition']>;
  runtime: ProjectConfiguration['runtime'];
};
type Task = {
  id: string;
  status: 'running' | 'completed' | 'needs_input' | 'failed' | 'cancelled';
  draft: Draft | null;
  error: string | null;
  targetCommit: string | null;
  filesRead?: number;
  missingInputs?: Array<{ item: string; reason: string }>;
  reviewState?: 'pending' | 'applied' | 'discarded';
  stale?: boolean;
};

export function ProjectEnvironmentEditor({
  projectId,
  configuration,
  disabled,
  onSave,
  recommendation,
  hasUnsavedConfiguration = false,
  managedFiles = [],
}: {
  projectId: string;
  configuration: ProjectConfiguration;
  disabled: boolean;
  onSave: (patch: Partial<ProjectConfiguration>, taskId?: string) => Promise<boolean>;
  recommendation?: { reason: string; targetCommit: string } | null;
  hasUnsavedConfiguration?: boolean;
  managedFiles?: Array<{ path: string; serviceName: string | null; purpose?: string }>;
}) {
  const notify = useAppMessage();
  const [task, setTask] = useState<Task | null>(null);
  const [validation, setValidation] = useState<EnvironmentValidationTask | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [requirements, setRequirements] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = configuration.generatedDefinition;
  const current = saved ? { generatedDefinition: saved, runtime: configuration.runtime } : null;
  const working = task?.status === 'running' || validation?.status === 'running';
  const locked = disabled || busy || working || hasUnsavedConfiguration;
  const pendingDraft =
    task?.status === 'completed' && (!task.reviewState || task.reviewState === 'pending');
  let draft: Draft | null = current;
  let invalidJson = false;
  if (editing !== null) {
    try {
      const value = JSON.parse(editing) as Draft;
      if (
        !value.generatedDefinition ||
        typeof value.generatedDefinition.sourceCommit !== 'string' ||
        typeof value.generatedDefinition.summary !== 'string' ||
        !Array.isArray(value.generatedDefinition.files) ||
        !value.generatedDefinition.files.every(
          (file) => file && typeof file.path === 'string' && typeof file.content === 'string',
        ) ||
        !Array.isArray(value.runtime?.composeServices) ||
        !value.runtime.composeServices.every((service) => typeof service === 'string') ||
        !Array.isArray(value.runtime?.initializationSteps ?? []) ||
        !(value.runtime.initializationSteps ?? []).every(
          (step) => step && typeof step.service === 'string' && typeof step.command === 'string',
        )
      )
        throw new Error();
      draft = value;
    } catch {
      invalidJson = true;
      draft = null;
    }
  }

  useEffect(() => {
    let cancelled = false;
    setTask(null);
    setValidation(null);
    setEditing(null);
    setError('');
    setRequirements('');
    void Promise.allSettled([
      requestJson<{ task: Task | null }>(`/api/projects/${projectId}/environment-generation`),
      requestJson<{ task: EnvironmentValidationTask | null }>(
        `/api/projects/${projectId}/environment-validation`,
      ),
    ]).then(([generation, check]) => {
      if (cancelled) return;
      if (generation.status === 'fulfilled') {
        const value = generation.value.task;
        setTask(value);
        if (
          value?.status === 'completed' &&
          value.draft &&
          !value.stale &&
          (!value.reviewState || value.reviewState === 'pending')
        )
          setEditing(JSON.stringify(value.draft, null, 2));
      }
      if (check.status === 'fulfilled') setValidation(check.value.task);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useNavigationBlocker(
    editing !== null
      ? () => ({
          title: '离开配置编辑？',
          message: '未保存的编辑将丢失，AI 原始草案仍可再次查看。',
          confirmLabel: '离开',
          cancelLabel: '继续编辑',
          danger: true,
        })
      : null,
  );

  useEffect(() => {
    if (!working) return;
    let cancelled = false;
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return;
      fetching = true;
      void (async () => {
        try {
          if (task?.status === 'running') {
            const { task: next } = await requestJson<{ task: Task }>(
              `/api/projects/${projectId}/environment-generation/${task.id}`,
            );
            if (cancelled) return;
            setTask(next);
            if (next.status === 'completed' && next.draft) {
              setEditing(JSON.stringify(next.draft, null, 2));
              notify.success('启动配置已生成，请查看后保存');
            } else if (next.status === 'needs_input') notify.info('需要补充信息后才能生成配置');
            else if (next.status === 'failed') notify.error(next.error ?? '配置生成失败');
            else if (next.status === 'cancelled') notify.info('配置生成已停止');
          }
          if (validation?.status === 'running') {
            const { task: next } = await requestJson<{ task: EnvironmentValidationTask | null }>(
              `/api/projects/${projectId}/environment-validation`,
            );
            if (cancelled) return;
            setValidation(next);
            if (next?.status === 'passed') notify.success('环境验证通过，临时资源已清理');
            else if (next && next.status !== 'running')
              notify.error(next.failure?.message ?? '环境验证未通过');
          }
        } catch (cause) {
          if (!cancelled) {
            setError(toUserMessage(cause, '无法读取准备进度'));
            if (cause instanceof ApiError && cause.status === 404) {
              setTask(null);
              setValidation(null);
            }
          }
        } finally {
          fetching = false;
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, task?.id, task?.status, validation?.status, working, notify]);

  // A saved configuration change invalidates the displayed result immediately.
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ task: EnvironmentValidationTask | null }>(
      `/api/projects/${projectId}/environment-validation`,
    )
      .then(({ task: next }) => {
        if (!cancelled) setValidation(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, configuration]);

  async function operate(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      const message = toUserMessage(cause, '操作失败');
      setError(message);
      notify.error(message);
    } finally {
      setBusy(false);
    }
  }
  function generate(useValidationFailure = false) {
    void operate(async () => {
      const result = await requestJson<{ task: Task }>(
        `/api/projects/${projectId}/environment-generation`,
        { method: 'POST', body: JSON.stringify({ requirements, useValidationFailure }) },
      );
      setTask(result.task);
      notify.success('配置生成已开始');
    });
  }

  const changes = current && draft && editing !== null ? describeChanges(current, draft) : [];
  return (
    <section className="settings-group environment-editor">
      <header className="settings-group-heading">
        <h3>启动配置</h3>
        <div className="row-actions">
          <Button type="button" disabled={locked || editing !== null} onClick={() => generate()}>
            {saved ? 'AI 更新配置' : 'AI 生成配置'}
          </Button>
          {task?.status === 'running' && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void operate(async () => {
                  await requestJson(
                    `/api/projects/${projectId}/environment-generation/${task.id}`,
                    { method: 'DELETE' },
                  );
                  notify.success('停止请求已提交');
                })
              }
            >
              停止生成
            </Button>
          )}
        </div>
      </header>
      <Field label="补充要求（可选）">
        <textarea
          rows={2}
          maxLength={4096}
          value={requirements}
          disabled={locked}
          onChange={(event) => setRequirements(event.target.value)}
          placeholder="例如：使用项目 seed 初始化数据；保留我调整的健康检查路径"
        />
      </Field>
      {hasUnsavedConfiguration && <p role="status">请先保存运行方式和运行参数。</p>}
      {task?.status === 'running' && (
        <p role="status">
          正在读取固定源码并生成配置{task.targetCommit ? ` · ${task.targetCommit.slice(0, 8)}` : ''}
          {task.filesRead ? ` · 已读取 ${task.filesRead} 个文件` : ''}
        </p>
      )}
      {task?.error && (
        <p className="notice notice-error" role="alert">
          {task.error}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {task?.status === 'needs_input' && (
        <section className="content-block">
          <h4>需要你补充</h4>
          <ul>
            {task.missingInputs?.map((item, index) => (
              <li key={index}>
                <strong>{item.item}</strong>：{item.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      {pendingDraft && task.stale && (
        <p className="notice notice-warning">这份草案生成后，项目配置或文件已变化。请重新生成。</p>
      )}
      {recommendation && (
        <p className="notice notice-warning">
          建议更新启动配置：{recommendation.reason} ·{' '}
          <code>{recommendation.targetCommit.slice(0, 8)}</code>
        </p>
      )}
      {draft && (
        <>
          <div className="settings-group-heading">
            <p>{draft.generatedDefinition.summary}</p>
            <StatusLabel tone={editing === null ? 'neutral' : 'warning'}>
              {editing === null ? '已保存' : '待确认'}
            </StatusLabel>
          </div>
          <dl className="environment-summary">
            <div>
              <dt>应用服务</dt>
              <dd>{draft.runtime.applicationService}</dd>
            </div>
            <div>
              <dt>依赖与工具</dt>
              <dd>
                {draft.runtime.composeServices
                  .filter((value) => value !== draft.runtime.applicationService)
                  .join('、') || '无额外服务'}
              </dd>
            </div>
            <div>
              <dt>测试命令执行位置</dt>
              <dd>
                {draft.runtime.commandService} · {draft.runtime.workingDirectory}
              </dd>
            </div>
            <div>
              <dt>应用端口</dt>
              <dd>{draft.runtime.servicePort}</dd>
            </div>
            <div>
              <dt>健康检查</dt>
              <dd>
                {draft.runtime.healthPath} · 最长 {draft.runtime.healthTimeoutSeconds} 秒
              </dd>
            </div>
            <div>
              <dt>分析代码版本</dt>
              <dd>
                <code>{draft.generatedDefinition.sourceCommit.slice(0, 8)}</code>
              </dd>
            </div>
          </dl>
          {(draft.runtime.initializationSteps?.length ?? 0) > 0 && (
            <section>
              <h4>初始化步骤</h4>
              <ol>
                {draft.runtime.initializationSteps!.map((step, index) => (
                  <li key={index}>
                    <details>
                      <summary>
                        {step.service} · 最长 {step.timeoutSeconds} 秒 · 查看命令
                      </summary>
                      <pre>{step.command}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {managedFiles.length > 0 && (
            <section>
              <h4>使用的文件</h4>
              <ul>
                {managedFiles.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code> →{' '}
                    {file.serviceName ??
                      (file.purpose === 'data'
                        ? draft.runtime.commandService
                        : draft.runtime.applicationService)}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {changes.length > 0 && (
            <section>
              <h4>相对已保存配置的变化</h4>
              <ul>
                {changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {(editing !== null || saved) && (
        <>
          <details className="settings-details">
            <summary>高级：查看 / 编辑原始 JSON</summary>
            {editing !== null && current && (
              <details>
                <summary>上次保存的配置</summary>
                <pre>{JSON.stringify(current, null, 2)}</pre>
              </details>
            )}
            <Field label="配置内容（JSON）">
              <textarea
                rows={18}
                disabled={locked}
                value={editing ?? JSON.stringify(current, null, 2)}
                onChange={(event) => setEditing(event.target.value)}
              />
            </Field>
            {invalidJson && <p role="alert">JSON 格式或必要字段不完整，请修正后保存。</p>}
          </details>
          {draft && (
            <details className="settings-details">
              <summary>查看生成的配置文件（{draft.generatedDefinition.files.length}）</summary>
              {draft.generatedDefinition.files.map((file) => (
                <details key={file.path}>
                  <summary>{file.path}</summary>
                  <pre>{file.content}</pre>
                </details>
              ))}
            </details>
          )}
          {editing !== null && (
            <div className="form-actions">
              <Button
                type="button"
                disabled={locked || invalidJson || (pendingDraft && task.stale)}
                onClick={() =>
                  void operate(async () => {
                    const value = JSON.parse(editing) as Draft;
                    const applied = await onSave(
                      {
                        runtimeMode: 'managed',
                        startType: 'compose',
                        executionDockerfile: '',
                        generatedDefinition: value.generatedDefinition,
                        runtime: value.runtime,
                      },
                      pendingDraft ? task.id : undefined,
                    );
                    if (applied) {
                      setEditing(null);
                      if (task) setTask({ ...task, reviewState: 'applied' });
                    }
                  })
                }
              >
                保存启动配置
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void operate(async () => {
                    if (pendingDraft) {
                      await requestJson(
                        `/api/projects/${projectId}/environment-generation/${task.id}/discard`,
                        { method: 'POST', body: '{}' },
                      );
                      setTask({ ...task, reviewState: 'discarded' });
                    }
                    setEditing(null);
                    notify.success('修改已放弃，保留已保存配置');
                  })
                }
              >
                取消修改
              </Button>
            </div>
          )}
        </>
      )}
      <section className="settings-group">
        <header className="settings-group-heading">
          <h3>环境验证</h3>
          <div className="row-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={locked || editing !== null}
              onClick={() =>
                void operate(async () => {
                  const result = await requestJson<{ task: EnvironmentValidationTask }>(
                    `/api/projects/${projectId}/environment-validation`,
                    { method: 'POST', body: '{}' },
                  );
                  setValidation(result.task);
                  notify.success('环境验证已开始');
                })
              }
            >
              验证已保存环境
            </Button>
            {validation?.status === 'running' && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void operate(async () => {
                    await requestJson(
                      `/api/projects/${projectId}/environment-validation/${validation.id}`,
                      { method: 'DELETE' },
                    );
                    notify.success('停止请求已提交，等待资源清理');
                  })
                }
              >
                停止验证
              </Button>
            )}
          </div>
        </header>
        {validation && (
          <>
            <StatusLabel
              tone={
                validation.stale
                  ? 'warning'
                  : validation.status === 'passed'
                    ? 'success'
                    : validation.status === 'running'
                      ? 'neutral'
                      : 'warning'
              }
            >
              {validation.stale
                ? '配置已变化，需要重新验证'
                : {
                    running: '正在验证',
                    passed: '验证通过',
                    failed: '验证失败',
                    cancelled: '验证已停止',
                  }[validation.status]}
            </StatusLabel>
            {validation.targetCommit && (
              <p>
                验证代码版本：<code>{validation.targetCommit.slice(0, 8)}</code>
              </p>
            )}
            <ol className="environment-validation-steps">
              {validation.steps.map((step, index) => (
                <li key={index}>
                  <span>{ENVIRONMENT_STAGES[step.stage]}</span>
                  <StatusLabel
                    tone={
                      step.status === 'passed'
                        ? 'success'
                        : step.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {{ running: '进行中', passed: '通过', failed: '未通过' }[step.status]}
                  </StatusLabel>
                  {step.message && <p>{step.message}</p>}
                </li>
              ))}
            </ol>
            {validation.failure && <p role="alert">{validation.failure.message}</p>}
            {validation.status !== 'running' && (
              <p>
                {validation.cleanupConfirmed
                  ? '临时资源已清理'
                  : '资源清理尚未确认，恢复流程将继续核对'}
              </p>
            )}
            {validation.failure && (
              <Button
                type="button"
                variant="secondary"
                disabled={locked || editing !== null}
                onClick={() => generate(true)}
              >
                根据本次失败更新配置
              </Button>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function describeChanges(before: Draft, after: Draft): string[] {
  const labels: Record<string, string> = {
    workingDirectory: '工作目录',
    prepareCommand: '准备命令',
    startCommand: '启动命令',
    servicePort: '应用端口',
    healthPath: '健康检查路径',
    healthTimeoutSeconds: '健康检查等待时间',
    composeFile: 'Compose 文件',
    composeServices: '服务列表',
    applicationService: '应用服务',
    commandService: '测试工具服务',
    initializationSteps: '初始化步骤',
  };
  const changes = Object.entries(labels)
    .filter(
      ([key]) =>
        JSON.stringify(before.runtime[key as keyof Draft['runtime']]) !==
        JSON.stringify(after.runtime[key as keyof Draft['runtime']]),
    )
    .map(([, label]) => `调整${label}`);
  for (const file of after.generatedDefinition.files) {
    const previous = before.generatedDefinition.files.find((entry) => entry.path === file.path);
    if (!previous) changes.push(`新增文件 ${file.path}`);
    else if (previous.content !== file.content) changes.push(`修改文件 ${file.path}`);
  }
  for (const file of before.generatedDefinition.files)
    if (!after.generatedDefinition.files.some((entry) => entry.path === file.path))
      changes.push(`移除文件 ${file.path}`);
  return changes;
}
