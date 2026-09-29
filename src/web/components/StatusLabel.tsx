import type { ReactNode } from 'react';

export function StatusLabel({
  tone,
  children,
}: {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'running';
  children: ReactNode;
}) {
  return <span className={`status-label status-${tone}`}>{children}</span>;
}
