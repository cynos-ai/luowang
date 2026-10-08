export function Switch({
  ariaLabel,
  checked,
  disabled = false,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch-control">
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-indicator" aria-hidden="true">
        {checked ? '✓' : '−'}
      </span>
      <span className="switch-state">{checked ? '已启用' : '未启用'}</span>
    </label>
  );
}
