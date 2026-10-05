import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type MessageKind = 'success' | 'error' | 'warning' | 'info';

type AppMessage = {
  id: number;
  kind: MessageKind;
  text: string;
};

type AppMessageApi = Record<MessageKind, (text: string) => void>;

const AppMessageContext = createContext<AppMessageApi | null>(null);

const symbols: Record<MessageKind, string> = {
  success: '✓',
  error: '×',
  warning: '!',
  info: 'i',
};

export function AppMessageProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const nextId = useRef(0);

  const remove = useCallback((id: number) => {
    setMessages((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (kind: MessageKind, text: string) => {
      if (!text) return;
      const id = ++nextId.current;
      setMessages((current) => [...current.slice(-2), { id, kind, text }]);
      window.setTimeout(() => remove(id), kind === 'success' || kind === 'info' ? 3000 : 5000);
    },
    [remove],
  );

  const api = useMemo<AppMessageApi>(
    () => ({
      success: (text) => show('success', text),
      error: (text) => show('error', text),
      warning: (text) => show('warning', text),
      info: (text) => show('info', text),
    }),
    [show],
  );

  return (
    <AppMessageContext.Provider value={api}>
      {children}
      <div className="app-message-stack" aria-live="polite" aria-atomic="false">
        {messages.map((item) => (
          <div
            className={`app-message app-message-${item.kind}`}
            key={item.id}
            role={item.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="app-message-symbol" aria-hidden="true">
              {symbols[item.kind]}
            </span>
            <span>{item.text}</span>
            <button
              className="app-message-close"
              type="button"
              aria-label="关闭提示"
              onClick={() => remove(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </AppMessageContext.Provider>
  );
}

export function useAppMessage(): AppMessageApi {
  const value = useContext(AppMessageContext);
  if (!value) throw new Error('AppMessageProvider is missing');
  return value;
}

export function AppMessageFeedback({ success, error }: { success?: string; error?: string }) {
  const message = useAppMessage();
  useEffect(() => {
    if (success) message.success(success);
  }, [message, success]);
  useEffect(() => {
    if (error) message.error(error);
  }, [error, message]);
  return null;
}
