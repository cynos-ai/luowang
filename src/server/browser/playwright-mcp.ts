import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import type { ConnectivityResult } from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';

export const PI_MCP_ADAPTER_VERSION = '2.31.0';
export const PLAYWRIGHT_MCP_VERSION = '0.0.79';
export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright';

const REQUIRED_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_take_screenshot',
] as const;
const EXCLUDED_TOOL_NAMES = [
  'browser_evaluate',
  'browser_run_code',
  'browser_run_code_unsafe',
] as const;
const FORBIDDEN_TOOL_NAMES = ['browser_run_code_unsafe'] as const;
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
  serverDefinition(evidenceDirectory: string): PlaywrightMcpServerDefinition;
  extension(evidenceDirectory: string): InlineExtension;
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

  serverDefinition(evidenceDirectory: string): PlaywrightMcpServerDefinition {
    const mcp = this.configuration.getHarness().mcp;
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    return {
      command,
      args: [
        '--yes',
        `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
        // Phase 4 never allows a headed or persistent browser session. Keep
        // this invariant here instead of trusting the mutable console value.
        '--headless',
        '--isolated',
        `--output-dir=${evidenceDirectory}`,
        `--browser=${mcp.browser}`,
        '--snapshot-mode=full',
        '--codegen=none',
      ],
      env: safeBrowserEnvironment(),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      lifecycle: 'lazy',
      directTools: false,
      excludeTools: [...EXCLUDED_TOOL_NAMES],
      requestTimeoutMs: Math.max(100, mcp.timeoutMs),
    };
  }

  extension(evidenceDirectory: string): InlineExtension {
    const definition = this.serverDefinition(evidenceDirectory);
    return {
      name: `luowang-playwright-mcp-${PLAYWRIGHT_MCP_VERSION}`,
      hidden: true,
      factory: async (pi) => {
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
        await install(pi);
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
      const missing = REQUIRED_TOOL_NAMES.filter((name) => !names.has(name));
      if (missing.length > 0) {
        return {
          status: 'failed',
          message: 'Playwright MCP 工具发现不完整，缺少 snapshot/ref 或 screenshot 能力',
          checkedAt: this.now().toISOString(),
          latencyMs: Date.now() - startedAt,
        };
      }
      const missingExclusions = FORBIDDEN_TOOL_NAMES.filter(
        (name) => !definition.excludeTools.includes(name),
      );
      if (missingExclusions.length > 0) {
        return {
          status: 'failed',
          message: 'Playwright MCP 接入层未排除被禁止的任意代码工具',
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

export function browserNeedsVision(plan: string): boolean {
  return /视觉|截图\s*(?:差异|对比|一致性|核对|判断)|(?:核对|比较|对比).{0,20}(?:截图|图像|图片)|布局|canvas|pixel|visual(?:\s+(?:check|comparison|assertion|regression))?/i.test(
    plan,
  );
}

export function browserScenarioRequested(plan: string): boolean {
  return /浏览器|页面|网页|UI|登录|点击|填充|导航|Playwright|browser|web|snapshot|screenshot/i.test(
    plan,
  );
}

export function supportsVision(model: { input?: readonly string[] }): boolean {
  return model.input?.some((value) => value.toLowerCase() === 'image') ?? false;
}
