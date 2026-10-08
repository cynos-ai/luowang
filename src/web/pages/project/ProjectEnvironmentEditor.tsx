import { useEffect, useState } from 'react';
import { Button, Field, useAppMessage } from '../../components/ui';
import { ApiError, requestJson, toUserMessage } from '../../api';
import type { ProjectConfiguration } from '../../project-types';
import { useNavigationBlocker } from '../../app/navigation';

type Draft = {
  generatedDefinition: NonNullable<ProjectConfiguration['generatedDefinition']>;
  runtime: ProjectConfiguration['runtime'];
};
type Task = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  draft: Draft | null;
  error: string | null;
  targetCommit: string | null;
  filesRead?: number;
};

export function ProjectEnvironmentEditor({
  projectId,
  configuration,
  disabled,
  onSave,
  recommendation,
}: {
  projectId: string;
  configuration: ProjectConfiguration;
  disabled: boolean;
  onSave: (patch: Partial<ProjectConfiguration>) => void;
  recommendation?: { reason: string; targetCommit: string } | null;
}) {
  const notify = useAppMessage();
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ task: Task | null }>(`/api/projects/${projectId}/environment-generation`)
      .then(({ task: currentTask }) => {
        if (cancelled || !currentTask) return;
        setTask(currentTask);
        if (currentTask.status === 'completed' && currentTask.draft)
          setEditing(JSON.stringify(currentTask.draft, null, 2));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  useNavigationBlocker(
    editing !== null
      ? () => ({
          title: '离开配置编辑？',
          message: '启动配置尚未保存，离开将丢弃修改。',
          confirmLabel: '离开',
          cancelLabel: '继续编辑',
          danger: true,
        })
      : null,
  );
  useEffect(() => {
    if (!editing) return;
    try {
      if (
        JSON.stringify((JSON.parse(editing) as Draft).generatedDefinition) ===
          JSON.stringify(configuration.generatedDefinition) &&
        JSON.stringify((JSON.parse(editing) as Draft).runtime) ===
          JSON.stringify(configuration.runtime)
      )
        setEditing(null);
    } catch {
      /* Preserve invalid edits until the user fixes or cancels them. */
    }
  }, [configuration.generatedDefinition, configuration.runtime, editing]);
  useEffect(() => {
    if (!task || task.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void requestJson<{ task: Task }>(
        `/api/projects/${projectId}/environment-generation/${task.id}`,
      )
        .then(({ task: next }) => {
          if (cancelled) return;
          setTask(next);
          if (next.status === 'completed' && next.draft) {
            setEditing(JSON.stringify(next.draft, null, 2));
            notify.success('启动配置已生成，请查看后保存');
          } else if (next.status === 'failed' || next.status === 'cancelled') {
            setError(next.error ?? '配置生成未完成');
            if (next.status === 'failed') notify.error(next.error ?? '配置生成失败');
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(toUserMessage(cause, '无法读取生成进度'));
            if (cause instanceof ApiError && cause.status === 404) setTask(null);
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, task, notify]);
  const saved = configuration.generatedDefinition;
  const current = saved ? { generatedDefinition: saved, runtime: configuration.runtime } : null;
  return (
    <section className="settings-group environment-editor">
      <header className="settings-group-heading">
        <h3>启动配置</h3>
        <div className="row-actions">
          <Button
            type="button"
            disabled={disabled || starting || task?.status === 'running' || editing !== null}
            onClick={() => {
              setStarting(true);
              setError('');
              void requestJson<{ task: Task }>(
                `/api/projects/${projectId}/environment-generation`,
                { method: 'POST', body: '{}' },
              )
                .then(({ task: next }) => {
                  setTask(next);
                  notify.success('配置生成已开始');
                })
                .catch((cause) => {
                  const message = toUserMessage(cause, '无法开始生成');
                  setError(message);
                  notify.error(message);
                })
                .finally(() => setStarting(false));
            }}
          >
            {saved ? 'AI 更新配置' : 'AI 生成配置'}
          </Button>
          {task?.status === 'running' && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void requestJson(`/api/projects/${projectId}/environment-generation/${task.id}`, {
                  method: 'DELETE',
                })
                  .then(() => notify.success('停止请求已提交'))
                  .catch((cause) => notify.error(toUserMessage(cause, '停止失败')));
              }}
            >
              停止生成
            </Button>
          )}
        </div>
      </header>
      {task?.status === 'running' && (
        <p role="status">
          正在读取固定源码并生成配置{task.targetCommit ? ` · ${task.targetCommit.slice(0, 8)}` : ''}
          {task.filesRead ? ` · 已读取 ${task.filesRead} 个文件` : ''}
        </p>
      )}
      {saved && (
        <p>
          {saved.summary} <code>{saved.sourceCommit.slice(0, 8)}</code>
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {recommendation && (
        <p className="notice notice-warning">
          建议更新启动配置：{recommendation.reason} ·{' '}
          <code>{recommendation.targetCommit.slice(0, 8)}</code>
        </p>
      )}
      {(editing !== null || saved) && (
        <details className="settings-details" open={editing !== null}>
          <summary>查看 / 修改启动配置</summary>
          {editing !== null && current && (
            <details>
              <summary>上次保存的配置</summary>
              <pre>{JSON.stringify(current, null, 2)}</pre>
            </details>
          )}
          <Field label="配置内容（JSON）">
            <textarea
              rows={18}
              disabled={disabled || task?.status === 'running'}
              value={editing ?? JSON.stringify(current, null, 2)}
              onChange={(event) => setEditing(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button
              type="button"
              disabled={disabled || editing === null}
              onClick={() => {
                try {
                  const draft = JSON.parse(editing!) as Draft;
                  if (!draft.generatedDefinition || !draft.runtime)
                    throw new Error('配置缺少生成文件或运行定义');
                  onSave({
                    runtimeMode: 'managed',
                    startType: 'compose',
                    executionDockerfile: '',
                    ...draft,
                  });
                } catch {
                  notify.error('配置 JSON 无效，请检查生成文件和运行定义');
                }
              }}
            >
              保存启动配置
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              取消修改
            </Button>
          </div>
        </details>
      )}
    </section>
  );
}
