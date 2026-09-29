import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { AuthStatusResponse } from '../../shared/types';
import { requestJson, toUserMessage } from '../api';
import { AppShell } from '../components/AppShell';
import { LoginPanel } from '../components/LoginPanel';
import { PageHeading } from '../components/PageHeading';
import { AccountSettingsPage } from '../pages/AccountSettingsPage';
import { GlobalSettingsPage } from '../pages/GlobalSettingsPage';
import { ProjectOnboardingPage } from '../pages/ProjectOnboardingPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { SystemStatusPage } from '../pages/SystemStatusPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { ProjectOverviewPage } from '../pages/project/ProjectOverviewPage';
import { ProjectReadinessPage } from '../pages/project/ProjectReadinessPage';
import { ProjectRunPage } from '../pages/project/ProjectRunPage';
import { ProjectRunsPage } from '../pages/project/ProjectRunsPage';
import { ProjectScenarioPage } from '../pages/project/ProjectScenarioPage';
import { ProjectScenariosPage } from '../pages/project/ProjectScenariosPage';
import { ProjectSettingsPage } from '../pages/project/ProjectSettingsPage';
import { ProjectTestPage } from '../pages/project/ProjectTestPage';
import type { ProjectReference } from '../project-types';
import { NavigationProvider, type NavigableRoute } from './navigation';
import { appPath, legacyHashRedirect, parseAppPath, type AppRoute } from './route';

export default function AppRouter() {
  const [route, setRoute] = useState<AppRoute>(initialRoute);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [projects, setProjects] = useState<ProjectReference[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const returnRoute = useRef<AppRoute | null>(null);
  const routeRef = useRef(route);
  const blockerRef = useRef<(() => boolean) | null>(null);
  routeRef.current = route;

  const mayNavigate = useCallback(() => blockerRef.current?.() ?? true, []);
  const registerBlocker = useCallback((blocker: () => boolean) => {
    blockerRef.current = blocker;
    return () => {
      if (blockerRef.current === blocker) blockerRef.current = null;
    };
  }, []);
  const navigate = useCallback(
    (target: NavigableRoute | string, options: { replace?: boolean } = {}) => {
      if (!mayNavigate()) return;
      const pathname = typeof target === 'string' ? target : appPath(target);
      if (options.replace) window.history.replaceState(null, '', pathname);
      else window.history.pushState(null, '', pathname);
      const next = parseAppPath(pathname);
      routeRef.current = next;
      setRoute(next);
      window.scrollTo({ top: 0 });
    },
    [mayNavigate],
  );

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    const response = await requestJson<{ projects: ProjectReference[] }>('/api/projects', {
      signal,
    });
    setProjects(response.projects);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<AuthStatusResponse>('/api/auth/status', { signal: controller.signal })
      .then((value) => {
        setAuth(value);
        if (value.authenticated) {
          void loadProjects(controller.signal).catch((cause: unknown) => {
            if (!controller.signal.aborted) {
              setError(toUserMessage(cause, '项目列表读取失败'));
            }
          });
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setAuth({ configured: true, authenticated: false });
        setError(toUserMessage(cause, '暂时无法连接罗网'));
      });
    const onPopState = () => {
      if (!mayNavigate()) {
        window.history.pushState(null, '', routePath(routeRef.current));
        return;
      }
      const next = parseAppPath(window.location.pathname);
      routeRef.current = next;
      setRoute(next);
    };
    const onUnauthorized = () => {
      setAuth({ configured: true, authenticated: false });
      setProjects([]);
      setError('登录已过期，请重新登录');
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('luowang:unauthorized', onUnauthorized);
    return () => {
      controller.abort();
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('luowang:unauthorized', onUnauthorized);
    };
  }, [loadProjects, mayNavigate]);

  useEffect(() => {
    if (!auth) return;
    if (!auth.authenticated && route.name !== 'login') {
      returnRoute.current = route;
      navigate({ name: 'login' }, { replace: true });
    }
    if (auth.authenticated && route.name === 'login' && !returnRoute.current) {
      navigate({ name: 'workspace' }, { replace: true });
    }
  }, [auth, navigate, route.name]);

  useEffect(() => {
    document.title = `${routeTitle(route)} · 罗网`;
  }, [route]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await requestJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      const status = await requestJson<AuthStatusResponse>('/api/auth/status');
      setPassword('');
      setAuth(status);
      await loadProjects();
      const destination = returnRoute.current;
      returnRoute.current = null;
      const target =
        destination?.name === 'not-found'
          ? destination.pathname
          : destination && destination.name !== 'login'
            ? destination
            : { name: 'workspace' as const };
      navigate(target, { replace: true });
    } catch (cause) {
      setError(toUserMessage(cause, '登录失败'));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!mayNavigate()) return;
    blockerRef.current = null;
    try {
      await requestJson('/api/auth/logout', { method: 'POST' });
    } finally {
      setAuth({ configured: true, authenticated: false });
      setProjects([]);
      navigate({ name: 'login' }, { replace: true });
    }
  }

  const project = useMemo(() => {
    if (!('projectId' in route)) return null;
    return projects.find((candidate) => candidate.projectId === route.projectId) ?? null;
  }, [projects, route]);

  if (!auth) return <BootScreen error={error} />;
  if (!auth.authenticated || route.name === 'login') {
    return (
      <main className="login-screen">
        <div className="login-wordmark" aria-label="罗网 LuoWang">
          <strong>罗网</strong>
          <span>LuoWang</span>
        </div>
        <LoginPanel
          configured={auth.configured}
          password={password}
          busy={busy}
          message=""
          error={error}
          onPasswordChange={setPassword}
          onSubmit={login}
          titleAsHeading1
        />
      </main>
    );
  }

  return (
    <NavigationProvider navigate={navigate} registerBlocker={registerBlocker}>
      <AppShell route={route} project={project} onLogout={() => void logout()}>
        {error && (
          <p className="app-banner" role="alert">
            {error}
          </p>
        )}
        <RoutePage
          route={route}
          projects={projects}
          reloadProjects={() => loadProjects()}
          onPasswordChanged={() => {
            setAuth({ configured: true, authenticated: false });
            setProjects([]);
            setError('密码已更新，请重新登录');
          }}
        />
      </AppShell>
    </NavigationProvider>
  );
}

function RoutePage({
  route,
  projects,
  reloadProjects,
  onPasswordChanged,
}: {
  route: AppRoute;
  projects: ProjectReference[];
  reloadProjects: () => Promise<void>;
  onPasswordChanged: () => void;
}) {
  if (route.name === 'not-found') {
    return (
      <section className="page-content">
        <PageHeading title="页面不存在" scope="404" />
      </section>
    );
  }
  if (route.name === 'workspace') return <WorkspacePage />;
  if (route.name === 'system') return <SystemStatusPage />;
  if (route.name === 'global-settings') return <GlobalSettingsPage section={route.section} />;
  if (route.name === 'account') {
    return <AccountSettingsPage onPasswordChanged={onPasswordChanged} />;
  }
  if (route.name === 'projects') {
    return <ProjectsPage onProjectsChanged={reloadProjects} />;
  }
  if (route.name === 'project-new') {
    return <ProjectOnboardingPage projects={projects} onProjectsChanged={reloadProjects} />;
  }
  if (route.name === 'project-overview') {
    return <ProjectOverviewPage projectId={route.projectId} />;
  }
  if (route.name === 'project-readiness') {
    return <ProjectReadinessPage projectId={route.projectId} />;
  }
  if (route.name === 'project-test') {
    return <ProjectTestPage projectId={route.projectId} />;
  }
  if (route.name === 'project-runs') {
    return <ProjectRunsPage projectId={route.projectId} />;
  }
  if (route.name === 'project-run') {
    return <ProjectRunPage projectId={route.projectId} runId={route.runId} tab={route.tab} />;
  }
  if (route.name === 'project-scenarios') {
    return <ProjectScenariosPage projectId={route.projectId} />;
  }
  if (route.name === 'project-scenario') {
    return <ProjectScenarioPage projectId={route.projectId} scenarioId={route.scenarioId} />;
  }
  if (route.name === 'project-settings') {
    return (
      <ProjectSettingsPage
        projectId={route.projectId}
        section={route.section}
        onProjectChanged={reloadProjects}
      />
    );
  }
  const page = pageCopy(route);
  return (
    <section className="page-content">
      <PageHeading title={page.title} scope={page.scope} />
      <section className="phase-placeholder" aria-label="页面接入状态">
        <strong>页面结构已就位</strong>
        <p>数据与操作将在对应实施阶段接入真实接口。</p>
      </section>
    </section>
  );
}

function BootScreen({ error }: { error: string }) {
  return (
    <main className="boot-screen" aria-busy={!error}>
      <div className="login-wordmark">
        <strong>罗网</strong>
        <span>LuoWang</span>
      </div>
      <p>{error || '正在连接控制台'}</p>
      {error && (
        <button className="button" type="button" onClick={() => window.location.reload()}>
          重新连接
        </button>
      )}
    </main>
  );
}

function initialRoute(): AppRoute {
  const legacy = legacyHashRedirect(window.location.hash);
  if (legacy) {
    window.history.replaceState(null, '', legacy);
    return parseAppPath(legacy);
  }
  if (window.location.pathname === '/') {
    window.history.replaceState(null, '', '/workspace');
    return { name: 'workspace' };
  }
  return parseAppPath(window.location.pathname);
}

function routePath(route: AppRoute): string {
  return route.name === 'not-found' ? route.pathname : appPath(route);
}

function routeTitle(route: AppRoute): string {
  return route.name === 'not-found' ? '页面不存在' : pageCopy(route).title;
}

function pageCopy(route: Exclude<AppRoute, { name: 'not-found' }>): {
  title: string;
  scope: string;
  description: string;
} {
  switch (route.name) {
    case 'login':
      return { title: '管理员登录', scope: '认证', description: '登录控制台。' };
    case 'workspace':
      return { title: '工作台', scope: '全局', description: '当前执行、队列和需要处理的事项。' };
    case 'projects':
      return { title: '项目', scope: '全局', description: '查看和管理已接入项目。' };
    case 'project-new':
      return { title: '接入项目', scope: '全局', description: '连接仓库并完成运行准备。' };
    case 'system':
      return { title: '系统状态', scope: '全局', description: '查看依赖和本地资源状态。' };
    case 'global-settings':
      return { title: '全局设置', scope: '影响全部项目', description: '这些设置影响全部项目。' };
    case 'account':
      return { title: '账号设置', scope: '管理员', description: '更新当前管理员密码。' };
    case 'project-overview':
      return { title: '项目概览', scope: '当前项目', description: '查看项目状态和最近活动。' };
    case 'project-test':
      return { title: '测试', scope: '当前项目', description: '发起测试并跟踪当前执行。' };
    case 'project-runs':
      return { title: '测试记录', scope: '当前项目', description: '查看完整测试历史。' };
    case 'project-run':
      return {
        title: `测试 ${route.runId}`,
        scope: '当前项目',
        description: '查看结果、报告和证据。',
      };
    case 'project-scenarios':
      return { title: '场景', scope: '当前项目', description: '查看 Git 中的测试场景。' };
    case 'project-scenario':
      return {
        title: route.scenarioId,
        scope: '当前项目 · 场景',
        description: '查看场景定义和执行历史。',
      };
    case 'project-readiness':
      return { title: '运行准备', scope: '当前项目', description: '检查执行测试所需条件。' };
    case 'project-settings':
      return { title: '项目设置', scope: '当前项目', description: '只影响当前项目。' };
  }
}
