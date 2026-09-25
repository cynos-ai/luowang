import { randomBytes } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createTextResult } from './agent-session.js';

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_RESPONSE_BYTES = 8192;
const BODY_TOKENS = new Set([
  '__RUN_PASSWORD__',
  '__TEST_PASSWORD__',
  '__WRONG_PASSWORD__',
  '__SHORT_PASSWORD__',
]);

export interface ControlledHttpOptions {
  baseUrl: string;
  cleanupUrl?: string;
  runId: string;
  getTestPassword: () => string | undefined;
  getCleanupToken: () => string | undefined;
  registerSensitiveValue: (value: string) => void;
  redact: (value: string) => string;
  capture: (record: Record<string, unknown>) => Promise<string>;
  request?: typeof fetch;
}

/** Same-origin application requests and current-Run cleanup probes; no arbitrary URL or header input. */
export function createControlledHttpTools(options: ControlledHttpOptions): ToolDefinition[] {
  const base = parseConfiguredUrl(options.baseUrl);
  const cleanup = options.cleanupUrl ? parseConfiguredUrl(options.cleanupUrl) : null;
  if (!RUN_ID.test(options.runId)) throw new Error('当前 Run ID 无效');
  const request = options.request ?? fetch;
  const runPassword = `synthetic-${randomBytes(20).toString('hex')}`;
  const wrongPassword = `wrong-${randomBytes(20).toString('hex')}`;
  options.registerSensitiveValue(runPassword);
  options.registerSensitiveValue(wrongPassword);
  const clients = new Map<string, Map<string, string>>();

  const requestParameters = Type.Object({
    clientId: Type.String({ description: '隔离的 HTTP 会话名称；不同名称不共享 Cookie' }),
    method: Type.Union([Type.Literal('GET'), Type.Literal('POST'), Type.Literal('DELETE')]),
    path: Type.String({ description: '配置的非生产应用内的绝对路径，不含域名、查询或片段' }),
    body: Type.Optional(
      Type.String({
        description:
          'JSON 对象文本；口令值只用 __RUN_PASSWORD__、__TEST_PASSWORD__、__WRONG_PASSWORD__ 或 __SHORT_PASSWORD__ 占位符',
      }),
    ),
  });
  const cleanupParameters = Type.Object({
    method: Type.Union([Type.Literal('GET'), Type.Literal('DELETE')]),
    resource: Type.Union([Type.Literal('account-count'), Type.Literal('storage')]),
    authorization: Type.Union([
      Type.Literal('configured'),
      Type.Literal('invalid'),
      Type.Literal('none'),
    ]),
    invalidRunId: Type.Optional(
      Type.Boolean({ description: '仅测试固定非法 ID；绝不允许指定其他真实 Run ID' }),
    ),
  });

  const capture = async (record: Record<string, unknown>) => {
    try {
      return await options.capture(record);
    } catch {
      throw new Error('HTTP 观察证据保存失败；不能引用该请求判定');
    }
  };
  const perform = async (
    url: URL,
    method: 'GET' | 'POST' | 'DELETE',
    headers: Record<string, string>,
    body?: string,
  ) => {
    const response = await request(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0];
      const index = pair?.indexOf('=') ?? -1;
      const value = index < 1 ? '' : pair!.slice(index + 1);
      if (value) options.registerSensitiveValue(value);
    }
    const responseBody = await readBoundedResponse(response);
    return { response, responseBody: options.redact(responseBody) };
  };

  return [
    {
      name: 'request_test_http',
      label: '请求非生产应用',
      description:
        '仅请求本项目配置的非生产应用同源路径；不跟随重定向、不接收自选域名或请求头。每个 clientId 独立保存 Cookie，返回状态、脱敏响应与证据 ID，不返回 Cookie 值。JSON 口令仅使用受控占位符；创建账号后立即登记测试数据。',
      parameters: requestParameters,
      execute: async (_id, params: Static<typeof requestParameters>) => {
        try {
          if (
            !CLIENT_ID.test(params.clientId) ||
            (clients.size >= 32 && !clients.has(params.clientId))
          )
            throw new Error('HTTP 会话名称无效或数量超限');
          const url = resolveAppPath(base, params.path);
          if (params.method === 'GET' && params.body !== undefined)
            throw new Error('GET 不接受请求体');
          const body =
            params.body === undefined
              ? undefined
              : resolveBody(params.body, options, runPassword, wrongPassword);
          const jar = clients.get(params.clientId) ?? new Map<string, string>();
          clients.set(params.clientId, jar);
          const headers: Record<string, string> = {};
          if (body !== undefined) headers['content-type'] = 'application/json';
          if (jar.size)
            headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
          const { response, responseBody } = await perform(url, params.method, headers, body);
          const setCookieNames = updateCookies(jar, response.headers.getSetCookie());
          const result = {
            method: params.method,
            path: url.pathname,
            clientId: params.clientId,
            status: response.status,
            contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
            body: responseBody,
            cookieNames: [...jar.keys()],
            setCookieNames,
          };
          const evidenceId = await capture({ source: 'controlled-test-http', ...result });
          return createTextResult(JSON.stringify({ ...result, evidenceId }));
        } catch (error) {
          return createTextResult(safeError(error), { error: true });
        }
      },
    },
    ...(cleanup
      ? [
          {
            name: 'probe_run_cleanup',
            label: '核对当前 Run 清理端点',
            description:
              '只访问项目配置的清理端点和当前 Run ID；configured 在服务端注入受控 Token，不向模型显示。可验证无效凭据、只读存储及本 Run 删除；DELETE 只能针对当前 Run，最终 Harness 仍独立清理核验。',
            parameters: cleanupParameters,
            execute: async (_id: string, params: Static<typeof cleanupParameters>) => {
              try {
                if (params.resource === 'storage' && params.method !== 'GET')
                  throw new Error('存储观察仅允许 GET');
                const runSegment = params.invalidRunId ? 'INVALID' : options.runId;
                const url = new URL(
                  `${cleanup.href.replace(/\/$/, '')}/${runSegment}${params.resource === 'storage' ? '/storage' : ''}`,
                );
                const headers: Record<string, string> = {};
                if (params.authorization === 'configured') {
                  const token = options.getCleanupToken();
                  if (!token || token.length < 32) throw new Error('当前项目清理凭据不可用');
                  headers.authorization = `Bearer ${token}`;
                } else if (params.authorization === 'invalid') {
                  headers.authorization = 'Bearer invalid-synthetic-test-token';
                }
                const { response, responseBody } = await perform(url, params.method, headers);
                const result = {
                  method: params.method,
                  resource: params.resource,
                  authorization: params.authorization,
                  runIdKind: params.invalidRunId ? 'invalid' : 'current',
                  status: response.status,
                  body: responseBody,
                  cacheControl: response.headers.get('cache-control'),
                };
                const evidenceId = await capture({
                  source: 'controlled-run-cleanup-http',
                  ...result,
                });
                return createTextResult(JSON.stringify({ ...result, evidenceId }));
              } catch (error) {
                return createTextResult(safeError(error), { error: true });
              }
            },
          } satisfies ToolDefinition,
        ]
      : []),
  ];
}

function parseConfiguredUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('非生产 HTTP 地址无效');
  return url;
}

function resolveAppPath(base: URL, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 512 || /[?#\\\s]/.test(path))
    throw new Error('只能请求不含查询或片段的应用路径');
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.pathname !== path || url.username || url.password)
    throw new Error('请求路径越出配置的应用来源');
  return url;
}

function resolveBody(
  body: string,
  options: ControlledHttpOptions,
  runPassword: string,
  wrongPassword: string,
): string {
  if (Buffer.byteLength(body) > 4096) throw new Error('HTTP 请求体超限');
  if (
    [options.getTestPassword(), options.getCleanupToken()].some(
      (secret) => secret && body.includes(secret),
    )
  )
    throw new Error('敏感值不能直接写入 HTTP 工具参数');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('请求体必须是 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('请求体必须是 JSON 对象');
  const values = parsed as Record<string, unknown>;
  if (Object.keys(values).length > 32) throw new Error('请求体字段过多');
  for (const [key, value] of Object.entries(values)) {
    if (/password|passwd|token|secret|authorization|cookie/i.test(key)) {
      if (typeof value !== 'string' || !BODY_TOKENS.has(value))
        throw new Error('敏感字段只接受受控占位符');
      if (value === '__TEST_PASSWORD__') {
        const password = options.getTestPassword();
        if (!password) throw new Error('本项目测试口令不可用');
        values[key] = password;
      } else if (value === '__RUN_PASSWORD__') values[key] = runPassword;
      else if (value === '__WRONG_PASSWORD__') values[key] = wrongPassword;
      else values[key] = 'short';
    } else if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null
    ) {
      throw new Error('请求体仅支持扁平标量字段');
    }
  }
  return JSON.stringify(values);
}

function updateCookies(jar: Map<string, string>, headers: string[]): string[] {
  const changed: string[] = [];
  for (const header of headers) {
    const [pair] = header.split(';', 1);
    const index = pair?.indexOf('=') ?? -1;
    if (index < 1) continue;
    const name = pair!.slice(0, index);
    const value = pair!.slice(index + 1);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || /[\r\n;]/.test(value)) continue;
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(header)) jar.delete(name);
    else jar.set(name, value);
    changed.push(name);
  }
  return changed;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('HTTP 响应体超限');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeError(error: unknown): string {
  return error instanceof Error &&
    /^(HTTP |GET |请求|只能|敏感|非生产|当前|存储|证据)/.test(error.message)
    ? error.message
    : '受控 HTTP 请求失败，未取得可确认的响应';
}
