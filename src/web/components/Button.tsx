import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';

export function Button({
  variant = 'default',
  compact = false,
  busy = false,
  className = '',
  disabled,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant;
  compact?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const variantClass = variant === 'default' ? '' : `button-${variant}`;
  const classes = ['button', variantClass, compact ? 'button-compact' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      {...props}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}
