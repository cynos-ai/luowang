export const globalSettingSections = [
  'models',
  'browser',
  'object-storage',
  'local-data',
  'credentials',
] as const;

export const projectSettingSections = [
  'general',
  'testing',
  'environment',
  'execution',
  'automation',
  'credentials',
] as const;

export const runDetailTabs = [
  'summary',
  'scenarios',
  'review',
  'report',
  'evidence',
  'technical',
] as const;

export type GlobalSettingSection = (typeof globalSettingSections)[number];
export type ProjectSettingSection = (typeof projectSettingSections)[number];
export type RunDetailTab = (typeof runDetailTabs)[number];

export type AppRoute =
  | { name: 'login' }
  | { name: 'workspace' }
  | { name: 'projects' }
  | { name: 'project-new' }
  | { name: 'system' }
  | { name: 'global-settings'; section: GlobalSettingSection }
  | { name: 'account' }
  | { name: 'project-overview'; projectId: string }
  | { name: 'project-test'; projectId: string }
  | { name: 'project-runs'; projectId: string }
  | { name: 'project-run'; projectId: string; runId: string; tab: RunDetailTab }
  | { name: 'project-scenarios'; projectId: string }
  | { name: 'project-scenario'; projectId: string; scenarioId: string }
  | { name: 'project-readiness'; projectId: string }
  | { name: 'project-settings'; projectId: string; section: ProjectSettingSection }
  | { name: 'not-found'; pathname: string };

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[^/]{1,200}$/u;

export function parseAppPath(input: string): AppRoute {
  const pathname = normalizePathname(input);
  const segments = splitPath(pathname);
  if (!segments) return { name: 'not-found', pathname };
  if (segments.length === 0) return { name: 'workspace' };
  if (segments.length === 1) {
    if (segments[0] === 'login') return { name: 'login' };
    if (segments[0] === 'workspace') return { name: 'workspace' };
    if (segments[0] === 'projects') return { name: 'projects' };
    if (segments[0] === 'system') return { name: 'system' };
    if (segments[0] === 'account') return { name: 'account' };
  }
  if (segments[0] === 'settings' && segments.length === 2) {
    const section = member(globalSettingSections, segments[1]);
    if (section) return { name: 'global-settings', section };
  }
  if (segments[0] !== 'projects') return { name: 'not-found', pathname };
  if (segments.length === 2 && segments[1] === 'new') return { name: 'project-new' };
  const projectId = segments[1];
  if (!projectId || !PROJECT_ID.test(projectId)) return { name: 'not-found', pathname };
  if (segments.length === 3) {
    if (segments[2] === 'overview') return { name: 'project-overview', projectId };
    if (segments[2] === 'test') return { name: 'project-test', projectId };
    if (segments[2] === 'runs') return { name: 'project-runs', projectId };
    if (segments[2] === 'scenarios') return { name: 'project-scenarios', projectId };
    if (segments[2] === 'readiness') return { name: 'project-readiness', projectId };
  }
  if (segments[2] === 'runs' && (segments.length === 4 || segments.length === 5)) {
    const runId = resourceId(segments[3]);
    const tab = segments.length === 5 ? member(runDetailTabs, segments[4]) : 'summary';
    if (runId && tab) return { name: 'project-run', projectId, runId, tab };
  }
  if (segments[2] === 'scenarios' && segments.length === 4) {
    const scenarioId = resourceId(segments[3]);
    if (scenarioId) return { name: 'project-scenario', projectId, scenarioId };
  }
  if (segments[2] === 'settings' && segments.length === 4) {
    const section = member(projectSettingSections, segments[3]);
    if (section) return { name: 'project-settings', projectId, section };
  }
  return { name: 'not-found', pathname };
}

export function appPath(route: Exclude<AppRoute, { name: 'not-found' }>): string {
  switch (route.name) {
    case 'login':
      return '/login';
    case 'workspace':
      return '/workspace';
    case 'projects':
      return '/projects';
    case 'project-new':
      return '/projects/new';
    case 'system':
      return '/system';
    case 'global-settings':
      return `/settings/${route.section}`;
    case 'account':
      return '/account';
    case 'project-overview':
      return projectPath(route.projectId, 'overview');
    case 'project-test':
      return projectPath(route.projectId, 'test');
    case 'project-runs':
      return projectPath(route.projectId, 'runs');
    case 'project-run': {
      const base = `${projectPath(route.projectId, 'runs')}/${encodedResourceId(route.runId)}`;
      return route.tab === 'summary' ? base : `${base}/${route.tab}`;
    }
    case 'project-scenarios':
      return projectPath(route.projectId, 'scenarios');
    case 'project-scenario':
      return `${projectPath(route.projectId, 'scenarios')}/${encodedResourceId(route.scenarioId)}`;
    case 'project-readiness':
      return projectPath(route.projectId, 'readiness');
    case 'project-settings':
      return `${projectPath(route.projectId, 'settings')}/${route.section}`;
  }
}

export function legacyHashRedirect(hash: string): string | null {
  const match = /^#\/projects\/([^/?#]+)\/?$/.exec(hash);
  if (!match) return null;
  const projectId = decodeSegment(match[1]);
  return projectId && PROJECT_ID.test(projectId)
    ? appPath({ name: 'project-overview', projectId })
    : null;
}

function normalizePathname(input: string): string {
  const value = input.split(/[?#]/, 1)[0] || '/';
  if (!value.startsWith('/')) return `/${value}`;
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function splitPath(pathname: string): string[] | null {
  const raw = pathname.split('/').slice(1);
  const result: string[] = [];
  for (const segment of raw) {
    if (!segment) continue;
    const decoded = decodeSegment(segment);
    if (decoded === null || decoded.includes('/')) return null;
    result.push(decoded);
  }
  return result;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function resourceId(value: string | undefined): string | null {
  if (!value || value === '.' || value === '..' || !RESOURCE_ID.test(value)) return null;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return null;
  }
  return value;
}

function member<const Values extends readonly string[]>(
  values: Values,
  value: string | undefined,
): Values[number] | null {
  return value && values.includes(value) ? (value as Values[number]) : null;
}

function projectPath(projectId: string, page: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('项目 ID 无效');
  return `/projects/${projectId}/${page}`;
}

function encodedResourceId(value: string): string {
  if (!resourceId(value)) throw new Error('资源 ID 无效');
  return encodeURIComponent(value);
}
