import type { ReactNode } from 'react';

import type {
  ConfigResponse,
  ConnectivityCheck,
  ProviderModelInfo,
  SecretKey,
} from '../../shared/types';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className={`field ${error ? 'field-invalid' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && !error && <small className="field-hint">{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}

export function SectionCard({
  id,
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel settings-section" aria-labelledby={id}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={id}>{title}</h2>
          {description && <p className="section-description">{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function SecretField({
  field,
  metadata,
  value,
  onChange,
  onDelete,
}: {
  field: { key: SecretKey; label: string };
  metadata: ConfigResponse['secrets'][SecretKey];
  value: string;
  onChange: (value: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="secret-field">
      <Field label={field.label}>
        <input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={metadata.configured ? '已配置，留空保持不变' : '未配置'}
        />
      </Field>
      <div className="secret-status">
        <span>{metadata.configured ? `${metadata.masked} · 已安全保存` : '尚未保存'}</span>
        {metadata.configured && (
          <button className="button-link danger" type="button" onClick={onDelete}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}

export function ConnectivityResult({
  check,
  busy,
  onRun,
  compact = false,
  disabled = false,
}: {
  check: ConnectivityCheck | undefined;
  busy: boolean;
  onRun?: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  if (!check) {
    return <p className="inline-check inline-check-empty">检查状态载入中…</p>;
  }
  return (
    <div className={`inline-check ${compact ? 'inline-check-compact' : ''}`}>
      <div>
        <span className={`check-dot check-dot-${check.result.status}`} aria-hidden="true" />
        <strong>{checkStatusLabel(check.result.status)}</strong>
        <p>{check.result.message}</p>
        <small>
          {check.result.checkedAt ? `检查于 ${formatDate(check.result.checkedAt)}` : '尚未执行'}
          {check.result.latencyMs !== null ? ` · ${check.result.latencyMs} ms` : ''}
        </small>
      </div>
      {onRun && check.available && (
        <button
          className="button button-secondary"
          type="button"
          disabled={busy || disabled}
          onClick={onRun}
        >
          {busy ? '检查中…' : '测试连接'}
        </button>
      )}
    </div>
  );
}

export function ModelCapabilities({ model }: { model: ProviderModelInfo | undefined }) {
  if (!model)
    return <span className="model-capabilities model-capabilities-empty">未匹配模型目录</span>;
  const vision = model.input.some((input) => input.toLowerCase() === 'image');
  return (
    <span className="model-capabilities">
      <span className="capability-badge">文本</span>
      {vision && <span className="capability-badge capability-vision">视觉</span>}
      {model.reasoning && <span className="capability-badge capability-reasoning">推理</span>}
    </span>
  );
}

export function checkStatusLabel(status: ConnectivityCheck['result']['status']): string {
  switch (status) {
    case 'ok':
      return '通过';
    case 'failed':
      return '失败';
    case 'timeout':
      return '超时';
    case 'unreachable':
      return '不可达';
    case 'unknown':
      return '无法确认';
    case 'not_checked':
      return '待检查';
    case 'not_configured':
      return '未配置';
    case 'not_available':
      return '未启用';
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}
