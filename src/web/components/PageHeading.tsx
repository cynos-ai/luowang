import type { ReactNode } from 'react';

export function PageHeading({
  title,
  actions,
}: {
  title: string;
  scope?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={actions ? 'page-toolbar' : 'page-title-only'}>
      <h1 className="visually-hidden">{title}</h1>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
