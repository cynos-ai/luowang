import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';

import type { AppRoute } from './route';
import { appPath } from './route';

export type NavigableRoute = Exclude<AppRoute, { name: 'not-found' }>;

type NavigationContextValue = {
  navigate: (target: NavigableRoute | string, options?: { replace?: boolean }) => void;
};

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({
  navigate,
  children,
}: NavigationContextValue & { children: ReactNode }) {
  return <NavigationContext.Provider value={{ navigate }}>{children}</NavigationContext.Provider>;
}

export function AppLink({
  to,
  children,
  className,
  current,
}: {
  to: NavigableRoute;
  children: ReactNode;
  className?: string;
  current?: boolean;
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
