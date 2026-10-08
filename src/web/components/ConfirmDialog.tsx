import { useEffect, useRef } from 'react';

import { Button } from './Button';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '返回',
  danger = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => {
      if (!open) return;
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2>{title}</h2>
      <p>{message}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <Button variant="secondary" type="button" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'default'} type="button" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
