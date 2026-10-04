import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

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
  label: ReactNode;
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
    <span className="model-capabilities" aria-label="能力">
      <CapabilityIcon label="文本" path="M5 3h10l4 4v14H5z M15 3v5h4 M8 12h8 M8 16h6" />
      {vision && (
        <CapabilityIcon
          label="视觉"
          path="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
        />
      )}
      {model.reasoning && (
        <CapabilityIcon
          label="推理"
          path="M9 18h6 M10 22h4 M8 14c-1.3-1.1-2-2.7-2-4.5a6 6 0 0 1 12 0c0 1.8-.7 3.4-2 4.5-.8.7-1 1.3-1 2H9c0-.7-.2-1.3-1-2z"
        />
      )}
    </span>
  );
}

function CapabilityIcon({ label, path }: { label: string; path: string }) {
  return (
    <span className="capability-icon" role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={path} />
      </svg>
    </span>
  );
}

export type ComboBoxOption = { value: string; label: string; detail?: string };

export function ComboBox({
  ariaLabel,
  value,
  options,
  disabled = false,
  placeholder,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: ComboBoxOption[];
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const normalized = value.trim().toLowerCase();
  const filtered = options.filter((option) => {
    const text = `${option.value} ${option.label} ${option.detail ?? ''}`.toLowerCase();
    return !normalized || text.includes(normalized);
  });

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => setActive(-1), [value, options]);

  function choose(option: ComboBoxOption) {
    onChange(option.value);
    setOpen(false);
    setActive(-1);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => {
        if (!filtered.length) return -1;
        if (current < 0) return delta > 0 ? 0 : filtered.length - 1;
        return (current + delta + filtered.length) % filtered.length;
      });
    } else if (event.key === 'Enter' && open && active >= 0 && filtered[active]) {
      event.preventDefault();
      choose(filtered[active]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div
      className="combo-box"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <button
        className="combo-toggle"
        type="button"
        tabIndex={-1}
        aria-label={`展开${ariaLabel}选项`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {open && !disabled && (
        <div className="combo-options" id={listId} role="listbox">
          {filtered.length ? (
            filtered.map((option, index) => (
              <button
                id={`${listId}-${index}`}
                className="combo-option"
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-active={index === active || undefined}
                key={option.value}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                <strong>{option.label}</strong>
                {option.detail && <small>{option.detail}</small>}
              </button>
            ))
          ) : (
            <p className="combo-empty">可继续使用当前输入值</p>
          )}
        </div>
      )}
    </div>
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
