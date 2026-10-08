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
  status,
  children,
}: {
  label: ReactNode;
  hint?: string;
  error?: string;
  status?: 'success';
  children: ReactNode;
}) {
  return (
    <label
      className={`field ${error ? 'field-invalid' : ''}`}
      data-status={!error ? status : undefined}
    >
      <span>
        {label}
        {!error && status === 'success' && (
          <span className="field-status" role="img" aria-label="已保存">
            ✓
          </span>
        )}
      </span>
      {children}
      {hint && !error && <small className="field-hint">{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}

export function HelpLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="field-label-with-help">
      {label}
      <span
        className="field-help"
        tabIndex={0}
        role="img"
        aria-label={`${label}说明：${help}`}
        title={help}
      >
        ?
      </span>
    </span>
  );
}

export function NumberInput({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  required = false,
  ariaLabel,
  width = 'compact',
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  width?: 'compact' | 'wide' | 'full';
  onChange: (value: number) => void;
}) {
  const precision = Math.max(decimalPlaces(step), decimalPlaces(min), decimalPlaces(max));
  const normalize = (next: number) => {
    const bounded = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, next),
    );
    return Number(bounded.toFixed(precision));
  };
  const changeBy = (direction: -1 | 1) => onChange(normalize(value + step * direction));

  return (
    <div className={`number-input number-input-${width}`}>
      <button
        type="button"
        aria-label={ariaLabel ? `减少${ariaLabel}` : '减少'}
        disabled={disabled || (min !== undefined && value <= min)}
        onClick={() => changeBy(-1)}
      >
        −
      </button>
      <input
        type="number"
        inputMode="decimal"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        required={required}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      <button
        className="number-input-increase"
        type="button"
        aria-label={ariaLabel ? `增加${ariaLabel}` : '增加'}
        disabled={disabled || (max !== undefined && value >= max)}
        onClick={() => changeBy(1)}
      >
        +
      </button>
    </div>
  );
}

function decimalPlaces(value: number | undefined): number {
  if (value === undefined || Number.isInteger(value)) return 0;
  return value.toString().split('.')[1]?.length ?? 0;
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
  children?: ReactNode;
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
      <CapabilityIcon
        kind="text"
        label="文本"
        path="M5 2h10l4 4v16H5V2zm9 2v4h4l-4-4zM8 11v2h8v-2H8zm0 4v2h8v-2H8z"
      />
      {vision && (
        <CapabilityIcon
          kind="vision"
          label="视觉"
          path="M12 5c-6.2 0-10 7-10 7s3.8 7 10 7 10-7 10-7-3.8-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"
        />
      )}
      {model.reasoning && (
        <CapabilityIcon
          kind="reasoning"
          label="推理"
          path="M9 21h6v-2H9v2zm3-19a7 7 0 0 0-4.5 12.4c.9.8 1.3 1.5 1.5 2.6h6c.2-1.1.6-1.8 1.5-2.6A7 7 0 0 0 12 2zm2.9 10.9c-1 .9-1.6 1.7-1.8 2.1h-2.2c-.2-.4-.8-1.2-1.8-2.1A4.8 4.8 0 0 1 7 9a5 5 0 0 1 10 0c0 1.5-.8 2.9-2.1 3.9z"
        />
      )}
    </span>
  );
}

function CapabilityIcon({
  kind,
  label,
  path,
}: {
  kind: 'text' | 'vision' | 'reasoning';
  label: string;
  path: string;
}) {
  return (
    <span
      className={`capability-icon capability-icon-${kind}`}
      role="img"
      aria-label={label}
      title={label}
    >
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
  displayValue,
  allowCustom = true,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: ComboBoxOption[];
  disabled?: boolean;
  placeholder?: string;
  displayValue?: string;
  allowCustom?: boolean;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [filtering, setFiltering] = useState(false);
  const shownValue = displayValue ?? value;
  const [inputValue, setInputValue] = useState(shownValue);
  const normalized = filtering ? inputValue.trim().toLowerCase() : '';
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
  useEffect(() => {
    if (!filtering) setInputValue(shownValue);
  }, [filtering, shownValue]);

  function choose(option: ComboBoxOption) {
    onChange(option.value);
    setInputValue(option.label);
    setOpen(false);
    setFiltering(false);
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
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setFiltering(false);
          setInputValue(shownValue);
        }
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
        value={inputValue}
        onChange={(event) => {
          setInputValue(event.target.value);
          if (allowCustom) onChange(event.target.value);
          setFiltering(true);
          setOpen(true);
        }}
        onFocus={() => {
          setFiltering(false);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        className="combo-toggle"
        type="button"
        tabIndex={-1}
        aria-label={`展开${ariaLabel}选项`}
        disabled={disabled}
        onClick={() => {
          setFiltering(false);
          setOpen((current) => !current);
        }}
      >
        <span className="combo-chevron" aria-hidden="true" />
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

export function SelectBox({
  ariaLabel,
  value,
  options,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: ComboBoxOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(
    Math.max(
      0,
      options.findIndex((item) => item.value === value),
    ),
  );
  const selected = options.find((item) => item.value === value) ?? options[0];

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => {
    setActive(
      Math.max(
        0,
        options.findIndex((item) => item.value === value),
      ),
    );
  }, [options, value]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div
      className="select-box"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="select-trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current) => (current + delta + options.length) % options.length);
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            choose(active);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <span className="combo-chevron" aria-hidden="true" />
      </button>
      {open && !disabled && (
        <div className="combo-options" id={listId} role="listbox">
          {options.map((option, index) => (
            <button
              className="combo-option"
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-active={index === active || undefined}
              key={option.value}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <strong>{option.label}</strong>
              {option.detail && <small>{option.detail}</small>}
            </button>
          ))}
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
