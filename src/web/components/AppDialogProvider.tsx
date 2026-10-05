import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PromptOptions = {
  title: string;
  message?: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type PendingDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const AppDialogContext = createContext<{
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
} | null>(null);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const pendingRef = useRef<PendingDialog | null>(null);

  const replacePending = useCallback((next: PendingDialog) => {
    const current = pendingRef.current;
    if (current?.kind === 'confirm') current.resolve(false);
    if (current?.kind === 'prompt') current.resolve(null);
    pendingRef.current = next;
    setPending(next);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => replacePending({ kind: 'confirm', options, resolve })),
    [replacePending],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(options.initialValue ?? '');
        replacePending({ kind: 'prompt', options, resolve });
      }),
    [replacePending],
  );
  const close = useCallback((value: boolean | string | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (current?.kind === 'confirm') current.resolve(Boolean(value));
    if (current?.kind === 'prompt') current.resolve(typeof value === 'string' ? value : null);
  }, []);

  return (
    <AppDialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {pending?.kind === 'confirm' && (
        <ConfirmDialog
          open
          {...pending.options}
          onConfirm={() => close(true)}
          onClose={() => close(false)}
        />
      )}
      {pending?.kind === 'prompt' && (
        <PromptDialog
          open
          {...pending.options}
          value={promptValue}
          onChange={setPromptValue}
          onConfirm={() => close(promptValue.trim())}
          onClose={() => close(null)}
        />
      )}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog() {
  const value = useContext(AppDialogContext);
  if (!value) throw new Error('AppDialogProvider is missing');
  return value;
}
