import { useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../../api';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useAppMessage } from '../../components/AppMessageProvider';
import { Field } from '../../components/FormControls';
import type { ProjectManagedFile } from '../../project-types';

export function ProjectManagedFilesSettings({
  projectId,
  files,
  disabled,
  onChanged,
}: {
  projectId: string;
  files: ProjectManagedFile[];
  disabled: boolean;
  onChanged: () => void;
}) {
  const notify = useAppMessage();
  const { confirm } = useAppDialog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [busy, setBusy] = useState(false);

  function clear() {
    setEditingId(null);
    setPath('');
    setContent('');
    setServiceName('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await requestJson(
        editingId
          ? `/api/projects/${projectId}/files/${encodeURIComponent(editingId)}`
          : `/api/projects/${projectId}/files`,
        {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({
            path,
            serviceName: serviceName || null,
            ...(editingId && !content ? {} : { content }),
          }),
        },
      );
      clear();
      onChanged();
      notify.success(editingId ? '受控文件已更新' : '受控文件已保存');
    } catch (cause) {
      notify.error(toUserMessage(cause, '受控文件保存失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel resource-panel">
      <header>
        <h2>受控文件</h2>
        <p>文件在镜像构建后注入本次运行，不进入 Git 或镜像层。</p>
      </header>
      <form className="managed-file-editor" onSubmit={(event) => void save(event)}>
        <Field label="项目内相对路径" hint="例如 .env.test、config/beta.yml、certs/test.pem">
          <input
            required
            value={path}
            disabled={disabled || busy}
            onChange={(event) => setPath(event.target.value)}
          />
        </Field>
        <Field
          label="目标 Compose 服务（可选）"
          hint="单容器留空；Compose 填写需要该文件的服务名。"
        >
          <input
            value={serviceName}
            disabled={disabled || busy}
            onChange={(event) => setServiceName(event.target.value)}
          />
        </Field>
        <Field label="文件内容">
          <textarea
            required={!editingId}
            rows={8}
            value={content}
            disabled={disabled || busy}
            placeholder={editingId ? '已安全保存 · 留空保持原内容' : '输入文件内容'}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <div className="row-actions">
          <button className="button" type="submit" disabled={disabled || busy}>
            {editingId ? '保存修改' : '新增文件'}
          </button>
          {editingId && (
            <button className="button button-secondary" type="button" onClick={clear}>
              取消
            </button>
          )}
        </div>
      </form>
      <div className="resource-list">
        {files.length === 0 && <p className="muted-copy">尚未保存受控文件</p>}
        {files.map((file) => (
          <article className="resource-row" key={file.id}>
            <div>
              <strong>{file.path}</strong>
              <span>
                {file.configured
                  ? `内容已安全保存 · 版本 ${file.revision}${file.serviceName ? ` · ${file.serviceName}` : ''}`
                  : '内容缺失'}
              </span>
            </div>
            <div className="row-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  setEditingId(file.id);
                  setPath(file.path);
                  setContent('');
                  setServiceName(file.serviceName ?? '');
                }}
              >
                编辑
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={disabled || busy}
                onClick={() =>
                  void (async () => {
                    if (
                      !(await confirm({
                        title: '删除受控文件？',
                        message: `将删除“${file.path}”的加密内容，无法恢复。`,
                        confirmLabel: '确认删除',
                        danger: true,
                      }))
                    )
                      return;
                    setBusy(true);
                    try {
                      await requestJson(
                        `/api/projects/${projectId}/files/${encodeURIComponent(file.id)}`,
                        { method: 'DELETE' },
                      );
                      if (editingId === file.id) clear();
                      onChanged();
                      notify.success('受控文件已删除');
                    } catch (cause) {
                      notify.error(toUserMessage(cause, '受控文件删除失败'));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
