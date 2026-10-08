import { useState, type FormEvent } from 'react';

import { requestJson, toUserMessage } from '../../api';
import { useAppDialog } from '../../components/AppDialogProvider';
import { useAppMessage } from '../../components/AppMessageProvider';
import { Button, Field, FileUpload, HelpLabel, StatusLabel, SelectBox } from '../../components/ui';
import type { ProjectManagedFile } from '../../project-types';
import { useNavigationBlocker } from '../../app/navigation';

export function ProjectManagedFilesSettings({
  projectId,
  files,
  disabled,
  onChanged,
  title = '配置文件',
  defaultPurpose = 'config',
  embedded = false,
}: {
  projectId: string;
  files: ProjectManagedFile[];
  disabled: boolean;
  onChanged: () => void;
  title?: string;
  defaultPurpose?: 'config' | 'data';
  embedded?: boolean;
}) {
  const notify = useAppMessage();
  const { confirm } = useAppDialog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [encodedContent, setEncodedContent] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<'config' | 'data'>(defaultPurpose);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [contentEditing, setContentEditing] = useState(false);
  const locked = disabled || busy || reading;
  useNavigationBlocker(
    busy || reading
      ? () => false
      : path || content || encodedContent !== null
        ? () => ({
            title: '离开文件编辑？',
            message: '文件修改尚未保存，离开将丢弃修改。',
            confirmLabel: '离开',
            cancelLabel: '继续编辑',
            danger: true,
          })
        : null,
  );

  function clear() {
    setEditingId(null);
    setPath('');
    setContent('');
    setServiceName('');
    setEncodedContent(null);
    setPurpose(defaultPurpose);
    setUploadedFile(null);
    setContentEditing(false);
  }

  async function selectFile(file: File | null, filePurpose = purpose) {
    if (!file) {
      setUploadedFile(null);
      setContent('');
      setEncodedContent(null);
      setContentEditing(false);
      return;
    }
    const limit = filePurpose === 'config' ? 256 * 1024 : 10 * 1024 * 1024;
    if (file.size > limit) {
      notify.error(filePurpose === 'config' ? '配置文件不能超过 256 KiB' : '文件不能超过 10 MiB');
      return;
    }
    setReading(true);
    try {
      if (filePurpose === 'config') {
        setContent(await file.text());
        setEncodedContent(null);
      } else {
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('文件读取失败'));
          reader.readAsDataURL(file);
        });
        setContent('');
        setEncodedContent(encoded);
      }
      setPath((current) => current || file.name);
      setUploadedFile(file);
      setPurpose(filePurpose);
      setContentEditing(false);
    } catch {
      notify.error('文件读取失败');
    } finally {
      setReading(false);
    }
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
            purpose,
            ...(encodedContent !== null
              ? { encodedContent }
              : editingId && !content
                ? {}
                : { content }),
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
    <section
      className={
        embedded ? 'settings-group managed-files-settings' : 'settings-panel managed-files-settings'
      }
    >
      <header>{embedded ? <h3>{title}</h3> : <h2>{title}</h2>}</header>
      <form className="managed-file-editor" onSubmit={(event) => void save(event)}>
        <FileUpload
          file={uploadedFile}
          disabled={disabled || busy}
          busy={reading}
          maxBytes={purpose === 'config' ? 256 * 1024 : 10 * 1024 * 1024}
          onChange={(file) => void selectFile(file)}
          onError={notify.error}
        />
        <div className="settings-fields">
          <Field label="文件用途">
            <SelectBox
              ariaLabel="文件用途"
              value={purpose}
              disabled={locked}
              options={[
                { value: 'config', label: '配置文件' },
                { value: 'data', label: '初始测试数据' },
              ]}
              onChange={(value) => {
                const next = value as 'config' | 'data';
                if (uploadedFile) void selectFile(uploadedFile, next);
                else {
                  setPurpose(next);
                  if (next === 'data') setContent('');
                }
              }}
            />
          </Field>
          <Field
            label={
              <HelpLabel
                label="项目内相对路径"
                help="默认使用原文件名，放在项目根目录。可改为 config/.env.test 等路径。"
              />
            }
          >
            <input
              required
              value={path}
              disabled={locked}
              aria-label="项目内相对路径"
              placeholder="例如 .env.test、data/seed.sql"
              onChange={(event) => setPath(event.target.value)}
            />
          </Field>
        </div>
        <details className="settings-details">
          <summary>目标服务（高级）</summary>
          <Field label="目标 Compose 服务（可选）">
            <input
              value={serviceName}
              disabled={locked}
              placeholder="例如 app、database"
              onChange={(event) => setServiceName(event.target.value)}
            />
          </Field>
        </details>
        {purpose === 'config' && encodedContent === null && (
          <details
            className="settings-details"
            open={contentEditing}
            onToggle={(event) => setContentEditing(event.currentTarget.open)}
          >
            <summary>编辑文件内容（可选）</summary>
            <Field label="文件内容">
              <textarea
                rows={8}
                value={content}
                disabled={locked}
                placeholder={editingId ? '已安全保存 · 留空保持原内容' : '输入文件内容'}
                onChange={(event) => setContent(event.target.value)}
              />
            </Field>
          </details>
        )}
        <div className="form-actions">
          {editingId && (
            <Button variant="secondary" type="button" disabled={locked} onClick={clear}>
              取消
            </Button>
          )}
          <Button
            type="submit"
            disabled={locked || !path || (!editingId && !uploadedFile && !content)}
          >
            {editingId ? '保存修改' : '新增文件'}
          </Button>
        </div>
      </form>
      {files.length > 0 && (
        <div className="resource-list">
          {files.map((file) => (
            <article
              className="resource-row"
              key={file.id}
              data-status={file.configured ? 'success' : undefined}
            >
              <div>
                <strong>{file.path}</strong>
                <span>
                  {file.purpose === 'data' ? '测试数据' : '配置文件'}
                  {file.byteSize ? ` · ${Math.ceil(file.byteSize / 1024)} KiB` : ''}
                </span>
                <StatusLabel tone={file.configured ? 'success' : 'warning'}>
                  {file.configured
                    ? `已保存 · 版本 ${file.revision}${file.serviceName ? ` · ${file.serviceName}` : ''}`
                    : '内容缺失'}
                </StatusLabel>
              </div>
              <div className="row-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setEditingId(file.id);
                    setPath(file.path);
                    setContent('');
                    setEncodedContent(null);
                    setPurpose(file.purpose ?? 'config');
                    setServiceName(file.serviceName ?? '');
                    setUploadedFile(null);
                    setContentEditing(false);
                  }}
                >
                  编辑
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  disabled={locked}
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
      )}
    </section>
  );
}
