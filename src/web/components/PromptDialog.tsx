import { useEffect, useRef } from 'react';

import { Field } from './FormControls';
import { Button } from './Button';

export function PromptDialog({
  open,
  title,
  message,
  label,
  value,
  confirmLabel = '继续',
  cancelLabel = '取消',
  onChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message?: string;
  label: string;
  value: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.focus();
      input.current?.select();
    }
    if (!open && element.open) element.close();
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onConfirm();
        }}
      >
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <Field label={label}>
          <input ref={input} value={value} onChange={(event) => onChange(event.target.value)} />
        </Field>
        <div className="dialog-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
