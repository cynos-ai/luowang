import type { ReactNode } from 'react';

export function AsyncRegion({
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  loading: boolean;
  error?: string;
  empty?: boolean;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <section className="async-region" aria-busy="true" aria-live="polite">
        <strong>正在读取</strong>
        <p>请稍候。</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="async-region async-error" role="alert">
        <strong>读取失败</strong>
        <p>{error}</p>
        {onRetry && (
          <button className="button button-secondary" type="button" onClick={onRetry}>
            重试
          </button>
        )}
      </section>
    );
  }
  if (empty) {
    return (
      <section className="async-region">
        <strong>暂无内容</strong>
      </section>
    );
  }
  return <>{children}</>;
}
