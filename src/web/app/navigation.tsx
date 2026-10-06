import { createContext, useContext, useEffect, type MouseEvent, type ReactNode } from 'react';

import type { AppRoute } from './route';
import { appPath } from './route';

export type NavigableRoute = Exclude<AppRoute, { name: 'not-found' }>;

type NavigationContextValue = {
  navigate: (target: NavigableRoute | string, options?: { replace?: boolean }) => void;
  registerBlocker: (blocker: () => boolean) => () => void;
};

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({
  navigate,
  registerBlocker,
  children,
}: NavigationContextValue & { children: ReactNode }) {
  return (
    <NavigationContext.Provider value={{ navigate, registerBlocker }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function AppLink({
  to,
  children,
  className,
  current,
  'aria-label': ariaLabel,
}: {
  to: NavigableRoute;
  children: ReactNode;
  className?: string;
  current?: boolean;
  'aria-label'?: string;
}) {
  const navigation = useNavigation();
  const href = appPath(to);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigation.navigate(to);
  };
  return (
    <a
      className={className}
      href={href}
      aria-current={current ? 'page' : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

export function useNavigation(): NavigationContextValue {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('NavigationProvider is missing');
  return value;
}

export function useNavigationBlocker(blocker: (() => boolean) | null): void {
  const { registerBlocker } = useNavigation();
  useEffect(() => {
    if (!blocker) return;
    return registerBlocker(blocker);
  }, [blocker, registerBlocker]);
}
