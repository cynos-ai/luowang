import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as connectSocket } from 'node:net';
import type { Duplex } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ConnectivityResult } from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import { assertBrowserEvidenceCoverage } from './evidence-policy.js';

export const PI_MCP_ADAPTER_VERSION = '2.31.0';
export const PLAYWRIGHT_MCP_VERSION = '0.0.79';
export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';

const REQUIRED_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_take_screenshot',
] as const;
// Controlled session evidence: read the current cookies and restore an already
// captured value after logout so a Run can prove the original Session was
// revoked. This is the only approved storage surface. Arbitrary script
// execution, storage-state export/import and local/session storage mutation
// stay outside the boundary.
export const SESSION_REPLAY_TOOL_NAMES = [
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_cookie_set',
] as const;
// Playwright MCP only ships these under --caps=storage; enable the group and
// hide everything except the approved cookie surface above.
export const EXCLUDED_TOOL_NAMES = [
  'browser_evaluate',
  'browser_run_code',
  'browser_run_code_unsafe',
  'browser_cookie_delete',
  'browser_cookie_clear',
  'browser_storage_state',
  'browser_set_storage_state',
  'browser_localstorage_clear',
  'browser_localstorage_delete',
  'browser_localstorage_get',
  'browser_localstorage_list',
  'browser_localstorage_set',
  'browser_sessionstorage_clear',
  'browser_sessionstorage_delete',
  'browser_sessionstorage_get',
  'browser_sessionstorage_list',
  'browser_sessionstorage_set',
] as const;
const SAFE_ENVIRONMENT_KEYS = [
  'CI',
  'ComSpec',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'Path',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;

export interface PlaywrightMcpServerDefinition {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  lifecycle: 'lazy' | 'keep-alive' | 'lazy-keep-alive' | 'eager';
  directTools: false;
  excludeTools: readonly string[];
  requestTimeoutMs: number;
}

export interface PlaywrightProbeResult {
  toolNames: string[];
}

export interface PlaywrightMcpAdapterOptions {
  probe?: (definition: PlaywrightMcpServerDefinition) => Promise<PlaywrightProbeResult>;
  now?: () => Date;
  timeoutMs?: number;
  cwd?: string;
}

export interface BrowserMcpAdapter {
  isEnabled(): boolean;
  serverDefinition(
    evidenceDirectory: string,
    targetBaseUrl?: string | null,
  ): PlaywrightMcpServerDefinition;
  extension(evidenceDirectory: string, targetBaseUrl?: string | null): InlineExtension;
  checkConnectivity(): Promise<ConnectivityResult>;
}

export function createPlaywrightMcpAdapter(
  configuration: ConfigurationStore,
  options: PlaywrightMcpAdapterOptions = {},
): BrowserMcpAdapter {
  return new DefaultPlaywrightMcpAdapter(configuration, options);
}

class DefaultPlaywrightMcpAdapter implements BrowserMcpAdapter {
  constructor(
    private readonly configuration: ConfigurationStore,
    private readonly options: PlaywrightMcpAdapterOptions,
  ) {}

  isEnabled(): boolean {
    return this.configuration.getHarness().mcp.enabled;
  }

  serverDefinition(
    evidenceDirectory: string,
    targetBaseUrl?: string | null,
  ): PlaywrightMcpServerDefinition {
    const mcp = this.configuration.getHarness().mcp;
    // Resolve from the Harness module, never the target or evidence cwd.
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    return {
      command: process.execPath,
      args: [
        cli,
        // Phase 4 never allows a headed or persistent browser session. Keep
        // this invariant here instead of trusting the mutable console value.
        '--headless',
        '--isolated',
        `--output-dir=${evidenceDirectory}`,
        `--browser=${mcp.browser}`,
        '--snapshot-mode=full',
        '--codegen=none',
        // Cookie read/restore for session-revocation evidence. The adapter
        // hides every other storage tool through excludeTools below.
        '--caps=storage',
        ...(targetBaseUrl ? [`--allowed-origins=${new URL(targetBaseUrl).origin}`] : []),
      ],
      env: safeBrowserEnvironment(),
      // Playwright MCP resolves explicit screenshot filenames relative to its
      // process cwd. Keep that cwd inside this Run's evidence directory unless
      // a caller deliberately supplied an isolated development cwd.
      cwd: this.options.cwd ?? evidenceDirectory,
      lifecycle: 'lazy',
      directTools: false,
      excludeTools: [...EXCLUDED_TOOL_NAMES],
      requestTimeoutMs: Math.max(100, mcp.timeoutMs),
    };
  }

  extension(evidenceDirectory: string, targetBaseUrl?: string | null): InlineExtension {
    const definition = this.serverDefinition(evidenceDirectory, targetBaseUrl);
    return {
      name: `luowang-playwright-mcp-${PLAYWRIGHT_MCP_VERSION}`,
      hidden: true,
      factory: async (pi) => {
        const originProxy = targetBaseUrl ? await createRunOriginProxy(targetBaseUrl) : null;
        if (originProxy) {
          definition.args.push(
            `--proxy-server=http://127.0.0.1:${originProxy.port}`,
            '--proxy-bypass=<-loopback>',
          );
          pi.on('session_shutdown', () => originProxy.close());
        }
        // Load the adapter only inside the isolated Pi session. This keeps the
        // MCP extension out of Main and Reviewer sessions and prevents any
        // project-provided extension from changing the browser tool boundary.
        const { createMcpAdapter } = await loadPiMcpAdapter();
        const install = createMcpAdapter({
          config: {
            mcpServers: {
              [PLAYWRIGHT_MCP_SERVER_NAME]: {
                command: definition.command,
                args: definition.args,
                env: definition.env,
                ...(definition.cwd ? { cwd: definition.cwd } : {}),
                lifecycle: definition.lifecycle,
                directTools: false,
                excludeTools: [...definition.excludeTools],
                requestTimeoutMs: definition.requestTimeoutMs,
                exposeResources: false,
              },
            },
            settings: {
              directTools: false,
              scriptMode: false,
              disableProxyTool: false,
              outputGuard: true,
              toolPrefix: 'server',
              requestTimeoutMs: definition.requestTimeoutMs,
            },
          },
        });
        try {
          await install(pi);
        } catch (error) {
          await originProxy?.close();
          throw error;
        }
      },
    };
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    const startedAt = Date.now();
    const mcp = this.configuration.getHarness().mcp;
    if (!mcp.enabled) {
      return {
        status: 'not_configured',
        message: 'Playwright MCP 尚未启用',
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    }

    let evidenceDirectory: string | undefined;
    try {
      evidenceDirectory = await mkdtemp(join(tmpdir(), 'luowang-mcp-check-'));
      const definition = this.serverDefinition(evidenceDirectory);
      const probe = this.options.probe ?? probeWithMcpClient;
      const result = await withTimeout(
        probe(definition),
        Math.max(definition.requestTimeoutMs, this.options.timeoutMs ?? 15_000),
      );
      const names = new Set(result.toolNames);
      try {
        assertBrowserEvidenceCoverage(
          result.toolNames.filter((name) => !definition.excludeTools.includes(name)),
        );
      } catch {
        return {
          status: 'failed',
          message: 'Playwright MCP 存在未配置证据采集/读取规则的工具',
          checkedAt: this.now().toISOString(),
          latencyMs: Date.now() - startedAt,
        };
      }
      const missing = [...REQUIRED_TOOL_NAMES, ...SESSION_REPLAY_TOOL_NAMES].filter(
        (name) => !names.has(name),
      );
      if (missing.length > 0) {
        return {
          status: 'failed',
          message:
            'Playwright MCP 工具发现不完整，缺少 snapshot/ref、screenshot 或 Cookie 会话重放能力',
          checkedAt: this.now().toISOString(),
          latencyMs: Date.now() - startedAt,
        };
      }
      const missingExclusions = EXCLUDED_TOOL_NAMES.filter(
        (name) => !definition.excludeTools.includes(name),
      );
      if (missingExclusions.length > 0) {
        return {
          status: 'failed',
          message: 'Playwright MCP 接入层未排除未获授权的工具',
          checkedAt: this.now().toISOString(),
          latencyMs: Date.now() - startedAt,
        };
      }
      return {
        status: 'ok',
        message: `Playwright MCP 已启动并发现 ${result.toolNames.length} 个受控工具`,
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return {
        status: timedOut ? 'timeout' : 'failed',
        message: timedOut
          ? 'Playwright MCP 启动或工具发现超时'
          : 'Playwright MCP 启动或工具发现失败',
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      if (evidenceDirectory) await rm(evidenceDirectory, { recursive: true, force: true });
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

export async function createRunOriginProxy(targetBaseUrl: string): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const allowed = new URL(targetBaseUrl);
  if (!['http:', 'https:'].includes(allowed.protocol) || allowed.username || allowed.password)
    throw new Error('浏览器目标 origin 无效');
  const connections = new Set<Duplex>();
  const server = createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? '', allowed.origin);
      assertAllowedProxyTarget(target, allowed);
    } catch {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Run browser origin blocked');
      return;
    }
    const upstreamTarget = normalizeWebSocketUrl(target);
    const upstream = (upstreamTarget.protocol === 'https:' ? httpsRequest : httpRequest)(
      upstreamTarget,
      {
        method: request.method,
        headers: forwardedHeaders(request, upstreamTarget),
      },
      (upstreamResponse) => {
        const location = upstreamResponse.headers.location;
        if (
          location &&
          (upstreamResponse.statusCode ?? 0) >= 300 &&
          (upstreamResponse.statusCode ?? 0) < 400
        ) {
          try {
            assertAllowedProxyTarget(new URL(location, target), allowed);
          } catch {
            upstreamResponse.resume();
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Run browser redirect blocked');
            return;
          }
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.on('connect', (request, clientSocket, head) => {
    const authority = request.url ?? '';
    if (authority !== allowed.host) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connectSocket(
      Number(allowed.port || (allowed.protocol === 'https:' ? 443 : 80)),
      allowed.hostname,
      () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
    closePairOnError(clientSocket, upstream);
  });
  server.on('upgrade', (request, clientSocket, head) => {
    let target: URL;
    try {
      target = new URL(request.url ?? '', allowed.origin);
      assertAllowedProxyTarget(target, allowed);
    } catch {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstreamTarget = normalizeWebSocketUrl(target);
    const upstream = (upstreamTarget.protocol === 'https:' ? httpsRequest : httpRequest)(
      upstreamTarget,
      {
        method: request.method,
        headers: forwardedHeaders(request, upstreamTarget),
      },
    );
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      clientSocket.write(
        `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}\r\n`,
      );
      for (const [name, value] of Object.entries(upstreamResponse.headers))
        if (value !== undefined)
          clientSocket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
      clientSocket.write('\r\n');
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      closePairOnError(clientSocket, upstreamSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Run 浏览器代理端口无效');
  return {
    port: address.port,
    close: () => {
      for (const connection of connections) connection.destroy();
      return new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

function assertAllowedProxyTarget(target: URL, allowed: URL): void {
  if (normalizeWebSocketUrl(target).origin !== allowed.origin || target.username || target.password)
    throw new Error('Run browser origin blocked');
}

function normalizeWebSocketUrl(target: URL): URL {
  const normalized = new URL(target);
  if (normalized.protocol === 'ws:') normalized.protocol = 'http:';
  if (normalized.protocol === 'wss:') normalized.protocol = 'https:';
  if (!['http:', 'https:'].includes(normalized.protocol))
    throw new Error('Run browser protocol blocked');
  return normalized;
}

function forwardedHeaders(
  request: IncomingMessage,
  target: URL,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['proxy-authorization', 'proxy-connection'].includes(name)) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  return headers;
}

function closePairOnError(first: Duplex, second: Duplex): void {
  first.on('error', () => second.destroy());
  second.on('error', () => first.destroy());
}

async function probeWithMcpClient(
  definition: PlaywrightMcpServerDefinition,
): Promise<PlaywrightProbeResult> {
  const server: StdioServerParameters = {
    command: definition.command,
    args: definition.args,
    env: definition.env,
    ...(definition.cwd ? { cwd: definition.cwd } : {}),
    stderr: 'ignore',
    maxBufferSize: 16 * 1024 * 1024,
  };
  const transport = new StdioClientTransport(server);
  const client = new Client({ name: 'luowang-connectivity-check', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return { toolNames: result.tools.map((tool) => tool.name) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function safeBrowserEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  environment.NPM_CONFIG_FUND = 'false';
  environment.NPM_CONFIG_AUDIT = 'false';
  environment.NPM_CONFIG_USERCONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return environment;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Operation timed out', 'AbortError')),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

interface PiMcpAdapterModule {
  createMcpAdapter(options: {
    config: Record<string, unknown>;
  }): (pi: unknown) => void | Promise<void>;
}

async function loadPiMcpAdapter(): Promise<PiMcpAdapterModule> {
  const bundledPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../vendor/pi-mcp-adapter.mjs',
  );
  if (existsSync(bundledPath)) {
    return (await import(pathToFileURL(bundledPath).href)) as PiMcpAdapterModule;
  }

  // The source package is loaded by tsx during development/tests. Production
  // uses the build-time bundle above because Node intentionally refuses to
  // strip TypeScript files under node_modules.
  const packageName = 'pi-mcp-adapter';
  return (await import(packageName)) as PiMcpAdapterModule;
}

export function supportsVision(model: { input?: readonly string[] }): boolean {
  return model.input?.some((value) => value.toLowerCase() === 'image') ?? false;
}
