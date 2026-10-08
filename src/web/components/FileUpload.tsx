import { useId, useRef, useState } from 'react';

import { Button } from './Button';

export function FileUpload({
  label = '上传文件',
  file,
  disabled = false,
  busy = false,
  accept,
  maxBytes,
  onChange,
  onError,
}: {
  label?: string;
  file: { name: string; size: number } | null;
  disabled?: boolean;
  busy?: boolean;
  accept?: string;
  maxBytes?: number;
  onChange: (file: File | null) => void;
  onError: (message: string) => void;
}) {
  const labelId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const locked = disabled || busy;

  function choose(files: FileList | null) {
    if (locked || !files?.length) return;
    if (files.length > 1) {
      onError('请一次选择一个文件');
      return;
    }
    const selected = files[0];
    if (maxBytes !== undefined && selected.size > maxBytes) {
      onError(`文件不能超过 ${formatSize(maxBytes)}`);
      return;
    }
    onChange(selected);
  }

  return (
    <div className="file-upload" aria-busy={busy || undefined}>
      <span className="file-upload-label" id={labelId}>
        {label}
      </span>
      <div
        className="file-upload-area"
        data-dragging={dragging && !locked ? true : undefined}
        data-selected={Boolean(file) || undefined}
        data-disabled={locked || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!locked) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(event.dataTransfer.files);
        }}
      >
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          aria-labelledby={labelId}
          tabIndex={-1}
          disabled={locked}
          accept={accept}
          onChange={(event) => {
            choose(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        <svg className="file-upload-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7" />
        </svg>
        <div className="file-upload-info" aria-live="polite">
          <strong>{busy ? '正在读取文件…' : (file?.name ?? '拖放文件到这里')}</strong>
          {file && <span>{formatSize(file.size)}</span>}
        </div>
        <div className="file-upload-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={locked}
            onClick={() => input.current?.click()}
          >
            {file ? '更换文件' : '选择文件'}
          </Button>
          {file && (
            <Button
              type="button"
              variant="secondary"
              disabled={locked}
              onClick={() => onChange(null)}
            >
              移除
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${bytes} B`;
}
