import { describe, expect, it, vi } from 'vitest';

import { createControlledHttpTools } from '../src/server/runs/controlled-http.js';

const RUN_ID = '01M3BK39NM6M44Q0VD1QBAPR8Q';

function toolResult(
  result: Awaited<ReturnType<ReturnType<typeof createControlledHttpTools>[number]['execute']>>,
) {
  return JSON.parse(result.content.find((item) => item.type === 'text')!.text);
}

describe('controlled non-production HTTP tools', () => {
  it('uses isolated cookie clients, bounded same-origin paths, and secret placeholders', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const captured: Record<string, unknown>[] = [];
    const secrets: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      if (String(input).endsWith('/api/auth/login')) {
        return new Response(
          JSON.stringify({ user: { displayName: 'tester' }, echoedCookie: 'private-session' }),
          {
            status: 201,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'sid=private-session; HttpOnly; Path=/',
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          authenticated: Boolean((init?.headers as Record<string, string>)?.cookie),
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const tools = createControlledHttpTools({
      baseUrl: 'http://app.test:3100',
      runId: RUN_ID,
      getTestPassword: () => 'configured-test-password',
      getCleanupToken: () => undefined,
      registerSensitiveValue: (value) => secrets.push(value),
      redact: (value) =>
        secrets
          .reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value)
          .replaceAll('configured-test-password', '[REDACTED]'),
      capture: async (record) => {
        captured.push(record);
        return `operation-${captured.length}.json`;
      },
      request,
    });
    const http = tools.find((tool) => tool.name === 'request_test_http')!;
    const login = toolResult(
      await http.execute('1', {
        clientId: 'alice',
        method: 'POST',
        path: '/api/auth/login',
        body: JSON.stringify({ email: 'synthetic@example.test', password: '__TEST_PASSWORD__' }),
      }),
    );
    expect(login).toMatchObject({
      status: 201,
      cookieNames: ['sid'],
      evidenceId: 'operation-1.json',
    });
    expect(JSON.parse(String(calls[0]!.init.body)).password).toBe('configured-test-password');
    expect(JSON.stringify(login)).not.toContain('private-session');
    expect(JSON.stringify(captured)).not.toContain('private-session');
    expect(JSON.stringify(captured)).not.toContain('configured-test-password');
    expect(
      toolResult(
        await http.execute('2', { clientId: 'alice', method: 'GET', path: '/api/auth/status' }),
      ).body,
    ).toContain('true');
    expect(
      toolResult(
        await http.execute('3', { clientId: 'bob', method: 'GET', path: '/api/auth/status' }),
      ).body,
    ).toContain('false');
    expect((calls[1]!.init.headers as Record<string, string>).cookie).toBe('sid=private-session');
    expect((calls[2]!.init.headers as Record<string, string>).cookie).toBeUndefined();
    expect(secrets).toHaveLength(3);

    const attempted = request.mock.calls.length;
    for (const path of [
      'https://other.test/',
      '//other.test/',
      '/a/../api/auth/status',
      '/api/auth/status?token=x',
    ]) {
      expect(
        (await http.execute('4', { clientId: 'alice', method: 'GET', path })).details?.error,
      ).toBe(true);
    }
    expect(request).toHaveBeenCalledTimes(attempted);
    expect(
      (
        await http.execute('5', {
          clientId: 'alice',
          method: 'POST',
          path: '/api/auth/login',
          body: JSON.stringify({ password: 'raw-secret' }),
        })
      ).details?.error,
    ).toBe(true);
    expect(
      (
        await http.execute('6', {
          clientId: 'alice',
          method: 'POST',
          path: '/api/auth/login',
          body: JSON.stringify({ password: 'configured-test-password' }),
        })
      ).details?.error,
    ).toBe(true);
  });

  it('limits configured cleanup credentials and deletion to the current Run', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const captured: Record<string, unknown>[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return new Response(JSON.stringify({ runId: RUN_ID, remaining: 0, accounts: 0 }), {
        status: init?.headers && (init.headers as Record<string, string>).authorization ? 200 : 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    });
    const tools = createControlledHttpTools({
      baseUrl: 'http://app.test:3100',
      cleanupUrl: 'http://cleanup.test:3100/api/luowang/test-data',
      runId: RUN_ID,
      getTestPassword: () => undefined,
      getCleanupToken: () => 'secret-cleanup-token-long-enough-123456',
      registerSensitiveValue: () => {},
      redact: (value) => value,
      capture: async (record) => {
        captured.push(record);
        return `operation-${captured.length}.json`;
      },
      request,
    });
    const probe = tools.find((tool) => tool.name === 'probe_run_cleanup')!;
    const storage = toolResult(
      await probe.execute('1', {
        method: 'GET',
        resource: 'storage',
        authorization: 'configured',
      }),
    );
    expect(storage).toMatchObject({ status: 200, resource: 'storage', cacheControl: 'no-store' });
    expect(calls[0]!.url).toBe(`http://cleanup.test:3100/api/luowang/test-data/${RUN_ID}/storage`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toContain(
      'secret-cleanup-token',
    );
    expect(JSON.stringify(storage)).not.toContain('secret-cleanup-token');
    expect(JSON.stringify(captured)).not.toContain('secret-cleanup-token');
    toolResult(
      await probe.execute('2', {
        method: 'DELETE',
        resource: 'account-count',
        authorization: 'configured',
      }),
    );
    expect(calls[1]!.url).toBe(`http://cleanup.test:3100/api/luowang/test-data/${RUN_ID}`);
    toolResult(
      await probe.execute('3', {
        method: 'GET',
        resource: 'account-count',
        authorization: 'none',
        invalidRunId: true,
      }),
    );
    expect(calls[2]!.url).toBe('http://cleanup.test:3100/api/luowang/test-data/INVALID');
    expect((calls[2]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(
      (
        await probe.execute('4', {
          method: 'DELETE',
          resource: 'storage',
          authorization: 'configured',
        })
      ).details?.error,
    ).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('never follows redirects and treats missing evidence as an unverified request', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      expect(_input).toBeDefined();
      expect(_init).toBeDefined();
      return new Response('redirect body', {
        status: 302,
        headers: { location: 'https://elsewhere.test/private' },
      });
    });
    const tool = createControlledHttpTools({
      baseUrl: 'http://app.test:3100',
      runId: RUN_ID,
      getTestPassword: () => undefined,
      getCleanupToken: () => undefined,
      registerSensitiveValue: () => {},
      redact: (value) => value,
      capture: async () => {
        throw new Error('storage failed');
      },
      request,
    }).find((item) => item.name === 'request_test_http')!;
    const result = await tool.execute('1', { clientId: 'one', method: 'GET', path: '/home' });
    expect(result.details?.error).toBe(true);
    expect(JSON.stringify(result)).toContain('证据保存失败');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('checks only a new disposable control Run and removes it after the comparison', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const captured: Record<string, unknown>[] = [];
    const secrets: string[] = [];
    const counts = new Map([[RUN_ID, 1]]);
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init!.method!;
      calls.push({ url, method });
      if (url.endsWith('/api/auth/register')) {
        const body = JSON.parse(String(init!.body)) as { email: string; password: string };
        const controlRunId = body.email.match(/^luowang-([0-9a-z]{26})-scope@/)?.[1]?.toUpperCase();
        expect(controlRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(body.password).toHaveLength(58);
        counts.set(controlRunId!, 1);
        return new Response('{}', { status: 201 });
      }
      expect((init!.headers as Record<string, string>).authorization).toBe(
        'Bearer secret-cleanup-token-long-enough-123456',
      );
      const identity = url.split('/').at(-1)!;
      expect(counts.has(identity)).toBe(true);
      const before = counts.get(identity)!;
      if (method === 'DELETE') counts.set(identity, 0);
      return new Response(
        JSON.stringify({
          runId: identity,
          deleted: method === 'DELETE' ? before : 0,
          remaining: counts.get(identity),
        }),
        { status: 200 },
      );
    });
    const tool = createControlledHttpTools({
      baseUrl: 'http://app.test:3100',
      cleanupUrl: 'http://app.test:3100/api/luowang/test-data',
      runId: RUN_ID,
      getTestPassword: () => undefined,
      getCleanupToken: () => 'secret-cleanup-token-long-enough-123456',
      registerSensitiveValue: (value) => secrets.push(value),
      redact: (value) =>
        secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value),
      capture: async (record) => {
        captured.push(record);
        return `operation-${captured.length}.json`;
      },
      request,
    }).find((item) => item.name === 'verify_run_cleanup_scope')!;
    const result = toolResult(await tool.execute('1', {}));
    expect(result).toMatchObject({
      passed: true,
      before: { current: 1, control: 1 },
      currentCleanup: 0,
      after: { current: 0, control: 1 },
      controlCleanup: 0,
      controlRemaining: 0,
      evidenceId: 'operation-1.json',
    });
    expect(result.controlRunId).not.toBe(RUN_ID);
    expect(counts.get(result.controlRunId)).toBe(0);
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
      { url: `http://app.test:3100/api/luowang/test-data/${RUN_ID}`, method: 'DELETE' },
      {
        url: `http://app.test:3100/api/luowang/test-data/${result.controlRunId}`,
        method: 'DELETE',
      },
    ]);
    expect(JSON.stringify({ result, captured })).not.toContain('secret-cleanup-token');
    expect(JSON.stringify({ result, captured })).not.toContain('synthetic-');
  });

  it('never reports scope success when the comparison or evidence fails', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init!.method!;
      calls.push({ url, method });
      if (url.endsWith('/api/auth/register')) return new Response('{}', { status: 201 });
      const identity = url.split('/').at(-1)!;
      return new Response(
        JSON.stringify({ runId: identity, remaining: identity === RUN_ID ? 1 : 0 }),
        {
          status: 200,
        },
      );
    });
    const tool = createControlledHttpTools({
      baseUrl: 'http://app.test:3100',
      cleanupUrl: 'http://app.test:3100/api/luowang/test-data',
      runId: RUN_ID,
      getTestPassword: () => undefined,
      getCleanupToken: () => 'secret-cleanup-token-long-enough-123456',
      registerSensitiveValue: () => {},
      redact: (value) => value,
      capture: async () => {
        throw new Error('evidence unavailable');
      },
      request,
    }).find((item) => item.name === 'verify_run_cleanup_scope')!;
    const response = await tool.execute('1', {});
    const result = toolResult(response);
    expect(response.details?.error).toBe(true);
    expect(result).toMatchObject({
      passed: false,
      error: 'HTTP 观察证据保存失败；不能引用该请求判定',
    });
    expect(result.controlRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      calls.some(
        (call) => call.url.endsWith(`/${result.controlRunId}`) && call.method === 'DELETE',
      ),
    ).toBe(true);
  });
});
