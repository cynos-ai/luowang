import { describe, expect, it, vi } from 'vitest';
import { collectRunCapabilities, checkEnvironmentAccess } from '../src/server/runs/capabilities.js';
import { createTestDataManager, createTestDataTools } from '../src/server/runs/test-data.js';
import { createHttpTestDataCleanupAdapter } from '../src/server/runs/http-test-data-cleanup.js';

const runId = '01K00000000000000000000000';
const token = 'synthetic-controlled-cleanup-token-123456789';
const endpoint = 'http://fixture.test/api/luowang/test-data';

describe('current Run capability facts', () => {
  it.each([404, 403, 200])(
    'checks storage before registration without claiming functional evidence (%s)',
    async (status) => {
      const fetcher = vi.fn(async () =>
        status === 200
          ? Response.json({ runId, accounts: 0, argon2id: 0, other: 0 })
          : new Response(token, { status }),
      );
      const manager = createTestDataManager({
        cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, { get: () => token }, fetcher),
      });
      const facts = await collectRunCapabilities({
        runId,
        baseUrl: 'http://fixture.test',
        browserConfigured: true,
        testData: manager,
        configuration: { projectId: 'project-a', revision: 3 },
        now: () => new Date('2026-10-03T00:00:00Z'),
      });
      expect(facts.configuration).toEqual({ projectId: 'project-a', revision: 3 });
      expect(facts.browser).toEqual({ configured: true, verification: 'not_checked' });
      expect(facts.environment.status).toBe('unknown');
      expect(facts.accountStorage).toMatchObject({
        status: status === 200 ? 'available' : 'unavailable',
        reason:
          status === 200
            ? 'verified_contract'
            : status === 404
              ? 'unsupported_endpoint'
              : 'access_denied',
      });
      expect(JSON.stringify(facts)).not.toContain(token);
      expect(JSON.stringify(facts)).not.toContain('accounts');
      expect(fetcher).toHaveBeenCalledTimes(1);
      const capture = vi.fn(async () => 'operation-1.json');
      const tools = createTestDataTools(manager, runId, undefined, capture, facts.accountStorage);
      expect(tools.some((t) => t.name === 'inspect_test_account_storage')).toBe(status === 200);
      // Availability isn't permission to inspect unregistered data or passing evidence.
      if (status === 200) {
        await expect(manager.inspectStorage!(runId)).rejects.toThrow('尚未登记');
        expect(fetcher).toHaveBeenCalledTimes(1);
      }
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it('does not invent adapter capability and rejects wrong-Run responses', async () => {
    const absent = createTestDataManager();
    expect(await absent.checkStorageCapability!(runId)).toMatchObject({
      status: 'unavailable',
      reason: 'not_configured',
    });
    const manager = createTestDataManager({
      cleanupAdapter: createHttpTestDataCleanupAdapter(endpoint, { get: () => token }, async () =>
        Response.json({ runId: 'another', accounts: 0, argon2id: 0, other: 0 }),
      ),
    });
    expect(await manager.checkStorageCapability!(runId)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('cancels the actual storage probe without recording a false dependency failure', async () => {
    const controller = new AbortController();
    const manager = createTestDataManager({
      cleanupAdapter: createHttpTestDataCleanupAdapter(
        endpoint,
        { get: () => token },
        async (_url, init) => {
          expect(init?.signal).toBeDefined();
          controller.abort();
          init!.signal!.throwIfAborted();
          return Response.json({});
        },
      ),
    });
    await expect(manager.checkStorageCapability!(runId, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('uses fresh configured-environment observations without interpreting HTTP as business success', async () => {
    const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toEqual({ accept: '*/*' });
      return new Response('private ignored body', { status: 401 });
    });
    expect(await checkEnvironmentAccess('http://fixture.test', request)).toMatchObject({
      status: 'reachable',
      statusCode: 401,
    });
    expect(
      await checkEnvironmentAccess(
        'http://fixture.test',
        async () => new Response('', { status: 503 }),
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'server_error' });
    expect(
      await checkEnvironmentAccess('http://fixture.test', async () => {
        throw new Error('auth network private');
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'request_failed' });
    expect(await checkEnvironmentAccess('http://user:secret@fixture.test', request)).toMatchObject({
      reason: 'invalid_url',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
