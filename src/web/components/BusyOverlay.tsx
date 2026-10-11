import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

/** Blocking task feedback. Only explicit cancellation can stop the background task. */
export function BusyOverlay({
  title,
  children,
  startedAt,
  stopping = false,
  stopDisabled = false,
  onStop,
  stopLabel = '停止任务',
}: {
  title: string;
  children: ReactNode;
  startedAt?: string;
  stopping?: boolean;
  stopDisabled?: boolean;
  onStop: () => void;
  stopLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const elapsed = startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : null;
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog busy-overlay"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="busy-overlay-signal" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2 id={titleId}>{title}</h2>
      <div role="status" aria-live="polite">
        {children}
      </div>
      <div className="busy-overlay-footer">
        <span>
          {elapsed !== null && Number.isFinite(elapsed)
            ? `已用时 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
            : '正在处理'}
        </span>
        <Button
          type="button"
          variant="secondary"
          disabled={stopping || stopDisabled}
          onClick={onStop}
        >
          {stopping ? '正在停止…' : stopLabel}
        </Button>
      </div>
      <p className="busy-overlay-hint">
        处理中暂时锁定页面，避免误操作。关闭或刷新页面不会取消任务。
      </p>
    </dialog>
  );
}
