import { strict as assert } from 'node:assert';

import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { it } from 'vitest';

import type { AuthService } from '../src/server/security/auth.js';
import { registerProjectConsoleRoutes } from '../src/server/projects/console-routes.js';
import type { ProjectConsoleService } from '../src/server/projects/console-service.js';

const auth: AuthService = {
  isConfigured: () => true,
  login: async () => null,
  authenticate: (token) => token === 'valid-session',
  logout: () => {},
  changePassword: async () => false,
  revokeAll: () => {},
};

it('protects every console route and accepts only fixed system checks', async () => {
  const calls: string[] = [];
  const service: ProjectConsoleService = {
    workspace: async () => {
      calls.push('workspace');
      return {
        fetchedAt: '2026-09-27T00:00:00.000Z',
        activeRun: null,
        queue: [],
        projects: [],
        recentRuns: [],
        attention: [],
        partialErrors: [],
      };
    },
    systemStatus: () => {
      calls.push('status');
      return {
        fetchedAt: '2026-09-27T00:00:00.000Z',
        service: { name: 'luowang', version: 'test', build: null },
        database: 'ok',
        secretStore: 'available',
        scheduler: {
          running: true,
          lastPollAt: null,
          nextPollAt: null,
          lastArchiveAt: null,
          nextArchiveAt: null,
          lastIndexerAt: null,
          nextIndexerAt: null,
          lastCleanupAt: null,
          nextCleanupAt: null,
          lastCronKey: null,
          lastError: null,
        },
        dependencies: [],
        recovery: { guideId: 'multi-project-recovery', available: true },
      };
    },
    resources: async () => {
      calls.push('resources');
      return {
        fetchedAt: '2026-09-27T00:00:00.000Z',
        instanceId: 'fixture',
        projects: [],
        containers: [],
        images: [],
        candidateImageBytes: 0,
      };
    },
    runSystemCheck: async (id) => {
      calls.push(`check:${id}`);
      return {
        check: {
          id,
          label: id,
          status: 'ok',
          message: '通过',
          checkedAt: '2026-09-27T00:00:00.000Z',
          lastSucceededAt: '2026-09-27T00:00:00.000Z',
          settingsSection:
            id === 'provider' ? 'models' : id === 'browser' ? 'browser' : 'object-storage',
        },
        result: {
          status: 'ok',
          message: '通过',
          checkedAt: '2026-09-27T00:00:00.000Z',
          latencyMs: 12,
        },
      };
    },
  };
  const app = Fastify();
  await app.register(fastifyCookie);
  await registerProjectConsoleRoutes(app, { auth, console: service });
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/workspace' });
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(calls, []);

    const headers = { cookie: 'luowang_session=valid-session' };
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/workspace', headers })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/system/status', headers })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/system/resources', headers })).statusCode,
      200,
    );
    const checked = await app.inject({
      method: 'POST',
      url: '/api/system/checks/provider',
      headers,
    });
    assert.equal(checked.statusCode, 200);
    assert.equal(checked.json().check.id, 'provider');
    assert.equal(checked.json().result.message, '通过');
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/system/checks/https:%2F%2Fexample.test',
      headers,
    });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(calls, ['workspace', 'status', 'resources', 'check:provider']);
  } finally {
    await app.close();
  }
});

it('fails the whole resource preview closed without leaking an inventory error', async () => {
  const app = Fastify();
  await app.register(fastifyCookie);
  await registerProjectConsoleRoutes(app, {
    auth,
    console: {
      workspace: async () => {
        throw new Error('unused');
      },
      systemStatus: () => {
        throw new Error('unused');
      },
      resources: async () => {
        throw new Error('/home/private/docker.sock ownership mismatch');
      },
      runSystemCheck: async () => {
        throw new Error('unused');
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/resources',
      headers: { cookie: 'luowang_session=valid-session' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('/home/private'), false);
    assert.equal(response.body.includes('ownership mismatch'), false);
  } finally {
    await app.close();
  }
});
