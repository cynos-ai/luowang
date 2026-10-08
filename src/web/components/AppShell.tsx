import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import type { AppRoute } from '../app/route';
import { useResource } from '../app/resource';
import { requestJson, toUserMessage } from '../api';
import { AppLink } from '../app/navigation';
import type { ProjectReference } from '../project-types';
import { BrandLogo } from './ui';

function useOperatorName(): string {
  const load = useCallback(
    (signal: AbortSignal) =>
      requestJson<{ profile: { displayName: string } | null }>('/api/account', { signal }),
    [],
  );
  const profile = useResource('operator-profile', load, (cause) =>
    toUserMessage(cause, '管理员资料读取失败'),
  );
  const reload = profile.reload;
  useEffect(() => {
    const onProfileChanged = () => reload();
    window.addEventListener('luowang:profile-changed', onProfileChanged);
    return () => window.removeEventListener('luowang:profile-changed', onProfileChanged);
  }, [reload]);
  return profile.value?.profile?.displayName?.trim() || '管理员';
}

export function AppShell({
  route,
  project,
  onLogout,
  children,
}: {
  route: AppRoute;
  project: ProjectReference | null;
  onLogout: () => void;
  children: ReactNode;
}) {
  const projectId = projectIdFromRoute(route);
  const operatorMenu = useRef<HTMLDetailsElement>(null);
  const operatorName = useOperatorName();
  const operatorInitial = [...operatorName][0] ?? '管';
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!operatorMenu.current?.contains(event.target as Node))
        operatorMenu.current?.removeAttribute('open');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') operatorMenu.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  return (
    <div className="lw-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="lw-header">
        <AppLink className="wordmark" to={{ name: 'workspace' }} aria-label="罗网工作台">
          <span className="wordmark-paper">
            <BrandLogo tone="color" decorative />
          </span>
        </AppLink>
        <nav className="global-nav" aria-label="全局导航">
          <AppLink
            className="nav-link"
            to={{ name: 'workspace' }}
            current={route.name === 'workspace'}
          >
            总览
          </AppLink>
          <AppLink className="nav-link" to={{ name: 'projects' }} current={isProjectRoute(route)}>
            项目
          </AppLink>
          <AppLink className="nav-link" to={{ name: 'system' }} current={route.name === 'system'}>
            系统状态
          </AppLink>
          <AppLink
            className="nav-link"
            to={{ name: 'global-settings', section: 'models' }}
            current={route.name === 'global-settings'}
          >
            全局设置
          </AppLink>
        </nav>
        <details className="operator-menu" key={route.name} ref={operatorMenu}>
          <summary aria-label={`管理员 ${operatorName}`} title={operatorName}>
            <span className="operator-avatar" aria-hidden="true">
              {operatorInitial}
            </span>
            <span className="operator-presence" aria-hidden="true" />
          </summary>
          <div className="operator-menu-popover">
            <AppLink to={{ name: 'global-settings', section: 'system' }}>系统设置</AppLink>
            <button type="button" onClick={onLogout}>
              退出登录
            </button>
          </div>
        </details>
      </header>
      {projectId && <ProjectContext route={route} projectId={projectId} project={project} />}
      <main id="main-content" className="lw-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function ProjectContext({
  route,
  projectId,
  project,
}: {
  route: AppRoute;
  projectId: string;
  project: ProjectReference | null;
}) {
  const reference = project ?? {
    projectId,
    displayName: '项目读取中',
    repositoryOwner: '—',
    repositoryName: '加载中',
  };
  return (
    <section className="project-context" aria-label="当前项目">
      <div className="project-context-title">
        <span className="scope-label">当前项目</span>
        <h2>{reference.displayName}</h2>
        <p>
          {reference.repositoryOwner}/{reference.repositoryName}
        </p>
      </div>
      <nav className="project-nav" aria-label="项目导航">
        <ProjectLink route={route} name="project-overview" projectId={projectId} label="概览" />
        <ProjectLink route={route} name="project-test" projectId={projectId} label="测试" />
        <ProjectLink route={route} name="project-runs" projectId={projectId} label="测试记录" />
        <ProjectLink route={route} name="project-scenarios" projectId={projectId} label="场景" />
        <ProjectLink
          route={route}
          name="project-readiness"
          projectId={projectId}
          label="运行准备"
        />
        <AppLink
          className="project-link"
          to={{ name: 'project-settings', projectId, section: 'general' }}
          current={route.name === 'project-settings'}
        >
          项目设置
        </AppLink>
      </nav>
    </section>
  );
}

function ProjectLink({
  route,
  name,
  projectId,
  label,
}: {
  route: AppRoute;
  name:
    | 'project-overview'
    | 'project-test'
    | 'project-runs'
    | 'project-scenarios'
    | 'project-readiness';
  projectId: string;
  label: string;
}) {
  const current =
    route.name === name ||
    (name === 'project-runs' && route.name === 'project-run') ||
    (name === 'project-scenarios' && route.name === 'project-scenario');
  return (
    <AppLink className="project-link" to={{ name, projectId }} current={current}>
      {label}
    </AppLink>
  );
}

function projectIdFromRoute(route: AppRoute): string | null {
  return 'projectId' in route ? route.projectId : null;
}

function isProjectRoute(route: AppRoute): boolean {
  return route.name === 'projects' || route.name === 'project-new' || 'projectId' in route;
}
