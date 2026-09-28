import type { ReactNode } from 'react';

export function PageHeading({
  title,
  scope,
  description,
  actions,
}: {
  title: string;
  scope?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {scope && <span className="scope-label">{scope}</span>}
        <h1>{title}</h1>
      </div>
      {(description || actions) && (
        <div className="page-heading-side">
          {description && <p>{description}</p>}
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}
