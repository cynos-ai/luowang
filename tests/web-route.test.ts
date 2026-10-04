import { strict as assert } from 'node:assert';

import { it } from 'vitest';

import {
  appPath,
  legacyHashRedirect,
  legacySettingsRedirect,
  parseAppPath,
  type AppRoute,
} from '../src/web/app/route.js';

const projectId = '11111111-1111-4111-8111-111111111111';

it('parses every frozen v0.7.0 console route', () => {
  const cases: Array<[string, AppRoute]> = [
    ['/', { name: 'workspace' }],
    ['/login', { name: 'login' }],
    ['/workspace', { name: 'workspace' }],
    ['/projects', { name: 'projects' }],
    ['/projects/new', { name: 'project-new' }],
    ['/system', { name: 'system' }],
    ['/settings/models', { name: 'global-settings', section: 'models' }],
    ['/settings/browser', { name: 'global-settings', section: 'browser' }],
    ['/settings/object-storage', { name: 'global-settings', section: 'object-storage' }],
    ['/settings/local-data', { name: 'global-settings', section: 'local-data' }],
    ['/settings/credentials', { name: 'global-settings', section: 'models' }],
    ['/account', { name: 'account' }],
    [`/projects/${projectId}/overview`, { name: 'project-overview', projectId }],
    [`/projects/${projectId}/test`, { name: 'project-test', projectId }],
    [`/projects/${projectId}/runs`, { name: 'project-runs', projectId }],
    [
      `/projects/${projectId}/runs/01K00000000000000000000001`,
      {
        name: 'project-run',
        projectId,
        runId: '01K00000000000000000000001',
        tab: 'summary',
      },
    ],
    [
      `/projects/${projectId}/runs/01K00000000000000000000001/evidence`,
      {
        name: 'project-run',
        projectId,
        runId: '01K00000000000000000000001',
        tab: 'evidence',
      },
    ],
    [`/projects/${projectId}/scenarios`, { name: 'project-scenarios', projectId }],
    [
      `/projects/${projectId}/scenarios/AUTH-%E7%99%BB%E5%BD%95-001`,
      { name: 'project-scenario', projectId, scenarioId: 'AUTH-登录-001' },
    ],
    [`/projects/${projectId}/readiness`, { name: 'project-readiness', projectId }],
    [
      `/projects/${projectId}/settings/environment`,
      { name: 'project-settings', projectId, section: 'environment' },
    ],
  ];

  for (const [path, expected] of cases) assert.deepEqual(parseAppPath(path), expected, path);
});

it('canonicalizes the removed global credentials page without affecting project credentials', () => {
  assert.equal(legacySettingsRedirect('/settings/credentials'), '/settings/models');
  assert.equal(legacySettingsRedirect('/settings/credentials/'), '/settings/models');
  assert.equal(legacySettingsRedirect(`/projects/${projectId}/settings/credentials`), null);
});

it('generates canonical paths that round-trip through the parser', () => {
  const routes: Array<Exclude<AppRoute, { name: 'not-found' }>> = [
    { name: 'login' },
    { name: 'workspace' },
    { name: 'projects' },
    { name: 'project-new' },
    { name: 'system' },
    { name: 'global-settings', section: 'object-storage' },
    { name: 'account' },
    { name: 'project-overview', projectId },
    { name: 'project-test', projectId },
    { name: 'project-runs', projectId },
    {
      name: 'project-run',
      projectId,
      runId: '01K00000000000000000000001',
      tab: 'summary',
    },
    {
      name: 'project-run',
      projectId,
      runId: '01K00000000000000000000001',
      tab: 'report',
    },
    { name: 'project-scenarios', projectId },
    { name: 'project-scenario', projectId, scenarioId: 'AUTH-登录-001' },
    { name: 'project-readiness', projectId },
    { name: 'project-settings', projectId, section: 'automation' },
  ];

  for (const route of routes) assert.deepEqual(parseAppPath(appPath(route)), route);
});

it('rejects unknown sections, malformed IDs, encoded separators, and extra segments', () => {
  const invalid = [
    '/settings/unknown',
    '/settings',
    '/projects/not-a-uuid/overview',
    `/projects/${projectId}`,
    `/projects/${projectId}/unknown`,
    `/projects/${projectId}/runs/../evidence`,
    `/projects/${projectId}/runs/RUN%2FOTHER`,
    `/projects/${projectId}/runs/RUN-1/unknown`,
    `/projects/${projectId}/scenarios/%E0%A4%A`,
    `/projects/${projectId}/settings/unknown`,
    `/projects/${projectId}/readiness/extra`,
  ];

  for (const path of invalid) assert.equal(parseAppPath(path).name, 'not-found', path);
  assert.throws(
    () => appPath({ name: 'project-overview', projectId: 'not-a-uuid' }),
    /项目 ID 无效/,
  );
  assert.throws(
    () => appPath({ name: 'project-run', projectId, runId: '', tab: 'summary' }),
    /资源 ID 无效/,
  );
});

it('maps only the old project hash to the stable overview URL', () => {
  assert.equal(legacyHashRedirect(`#/projects/${projectId}`), `/projects/${projectId}/overview`);
  assert.equal(legacyHashRedirect(`#/projects/${projectId}/`), `/projects/${projectId}/overview`);
  assert.equal(legacyHashRedirect('#/projects/not-a-uuid'), null);
  assert.equal(legacyHashRedirect(`#/projects/${projectId}/runs`), null);
  assert.equal(legacyHashRedirect('#/workspace'), null);
});

it('ignores search and hash fragments when parsing a pathname', () => {
  assert.deepEqual(parseAppPath('/workspace?from=login#section'), { name: 'workspace' });
  assert.deepEqual(parseAppPath(`/projects/${projectId}/overview/`), {
    name: 'project-overview',
    projectId,
  });
});
