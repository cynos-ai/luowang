import type { ReactNode } from 'react';

export function PageHeading({
  title,
  scope,
  actions,
}: {
  title: string;
  scope?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={`page-heading${actions ? ' page-heading-with-actions' : ''}`}>
      <div className="page-heading-title">
        {scope && <span className="scope-label">{scope}</span>}
        <h1>{title}</h1>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
      <span className="page-heading-mark" aria-hidden="true" />
    </header>
  );
}
