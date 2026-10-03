import { useCallback, useEffect, useRef, useState } from 'react';

export type ResourceState<T> = {
  fetchedAt: string | null;
  value: T | null;
  loading: boolean;
  error: string;
  reload: () => void;
};

export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  errorMessage: (cause: unknown) => string,
): ResourceState<T> {
  const generation = useRef(0);
  const errorMessageRef = useRef(errorMessage);
  errorMessageRef.current = errorMessage;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<ResourceState<T>, 'reload'>>({
    fetchedAt: null,
    value: null,
    loading: true,
    error: '',
  });
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setState({ value, loading: false, error: '', fetchedAt: new Date().toISOString() });
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setState((current) => ({
            fetchedAt: current.fetchedAt,
            value: current.value,
            loading: false,
            error: errorMessageRef.current(cause),
          }));
        }
      },
    );
    return () => controller.abort();
  }, [key, load, revision]);

  return { ...state, reload };
}
