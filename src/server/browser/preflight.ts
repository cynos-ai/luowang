import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  getAgentDir,
  ModelRuntime,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { buildSessionInput, createPiAgentSessionFactory } from '../runs/agent-session.js';
import {
  EXCLUDED_TOOL_NAMES,
  PLAYWRIGHT_MCP_SERVER_NAME,
  SESSION_REPLAY_TOOL_NAMES,
  type BrowserMcpAdapter,
} from './playwright-mcp.js';

const TMPFS_MAGIC = 0x01021994;
const MARKER = 'LuoWang native MCP preflight';

/** Operator-only readiness check, never exposed as a Run tool or model prompt. */
export async function runBrowserPreflight(
  browser: BrowserMcpAdapter,
  target?: { url: string; expectedText: string },
) {
  const checks: Record<string, boolean> = {};
  const receipts: { operation: string; sha256: string }[] = [];
  let tools: string[] = [];
  let diagnostic: { operation: string; message: string } | undefined;
  let stage = 'state-directory';
  let directory: string | undefined;
  let session:
    Awaited<ReturnType<ReturnType<typeof createPiAgentSessionFactory>['create']>> | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<html><title>${MARKER}</title><body><h1>${MARKER}</h1></body></html>`);
  });
  let failure: { stage: string; code: string } | undefined;
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir || !isAbsolute(agentDir) || getAgentDir() !== agentDir)
      throw new Error('EXPLICIT_STATE_DIRECTORY_REQUIRED');
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(agentDir, 'preflight-'));
    await writeFile(join(directory, 'write-probe'), MARKER, { flag: 'wx' });
    if ((await readFile(join(directory, 'write-probe'), 'utf8')) !== MARKER)
      throw new Error('STATE_WRITE_NOT_CONFIRMED');
    checks.stateDirectoryWritable = true;
    stage = 'tmpfs';
    for (const [name, path] of [
      ['state', agentDir],
      ['temporary', '/tmp'],
      ['npm', '/home/node/.npm'],
      ['browserConfig', '/home/node/.config'],
      ['browserCache', '/home/node/.cache'],
      ['browserPki', '/home/node/.pki'],
    ] as const) {
      const info = await statfs(path);
      if (info.type !== TMPFS_MAGIC || info.bavail * info.bsize < 16 * 1024 * 1024)
        throw new Error('WRITABLE_TMPFS_REQUIRED');
      const probe = await mkdtemp(join(path, 'luowang-write-probe-'));
      try {
        await writeFile(join(probe, 'probe'), MARKER, { flag: 'wx' });
        if ((await readFile(join(probe, 'probe'), 'utf8')) !== MARKER)
          throw new Error('TMPFS_WRITE_NOT_CONFIRMED');
      } finally {
        await rm(probe, { recursive: true, force: true });
      }
      checks[`${name}Tmpfs`] = true;
    }
    stage = 'native-mcp';
    if (!browser.isEnabled()) throw new Error('MCP_DISABLED');
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    // Metadata only. No credentials, prompt, stream or inference is used.
    const model = runtime.getModels().find((candidate) => !candidate.reasoning);
    if (!model) throw new Error('OFFLINE_MODEL_METADATA_MISSING');
    const extension = browser.extension(directory);
    const install = typeof extension === 'function' ? extension : extension.factory;
    let proxy: Pick<ToolDefinition, 'execute'> | undefined;
    let context: ExtensionContext | undefined;
    const factory = createPiAgentSessionFactory({
      provider: {
        getRuntime: async () => runtime,
        resolveModel: async () => model,
        listModels: async () => [],
        checkConnectivity: async () => {
          throw new Error('MODEL_NETWORK_FORBIDDEN');
        },
      },
    });
    session = await factory.create(
      buildSessionInput(
        'runner',
        'runner-execution',
        { model: model.id, thinking: 'off' },
        directory,
        [],
        MARKER,
        '',
        [],
        [
          {
            name: 'native-mcp-preflight',
            factory: async (pi) => {
              await install({
                ...pi,
                registerTool: (tool) => {
                  if (tool.name === 'mcp')
                    proxy = { execute: tool.execute as ToolDefinition['execute'] };
                  pi.registerTool(tool);
                },
              });
              pi.on('session_start', (_event, ctx) => {
                context = ctx;
              });
              // Defense in depth: an accidental turn cannot reach a model provider.
              pi.on('before_provider_request', () => {
                throw new Error('MODEL_NETWORK_FORBIDDEN');
              });
            },
          },
        ],
      ),
    );
    async function call(operation: string, args: Record<string, unknown>) {
      if (!proxy || !context) throw new Error('NATIVE_MCP_NOT_BOUND');
      const result = await proxy.execute(
        'preflight',
        args,
        AbortSignal.timeout(30_000),
        undefined,
        context,
      );
      const text = JSON.stringify(result);
      receipts.push({ operation, sha256: createHash('sha256').update(text).digest('hex') });
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.error || details?.isError) {
        diagnostic = {
          operation,
          message: result.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
            .slice(0, 2048),
        };
        throw new Error('MCP_OPERATION_FAILED');
      }
      return text;
    }
    await call('connect', { connect: 'playwright' });
    const inventory = JSON.parse(await call('tool-list', { server: 'playwright' })) as {
      details?: { tools?: unknown };
    };
    if (
      !Array.isArray(inventory.details?.tools) ||
      !inventory.details.tools.every((name) => typeof name === 'string')
    )
      throw new Error('MCP_TOOL_INVENTORY_MISSING');
    tools = inventory.details.tools;
    // Verify the real adapter surface, not only the configured definition: the
    // approved cookie read/restore tools must exist and every excluded tool
    // must stay hidden from the model.
    const prefixed = (name: string) => `${PLAYWRIGHT_MCP_SERVER_NAME}_${name}`;
    if (SESSION_REPLAY_TOOL_NAMES.some((name) => !tools.includes(prefixed(name))))
      throw new Error('SESSION_REPLAY_TOOLS_MISSING');
    if (EXCLUDED_TOOL_NAMES.some((name) => tools.includes(prefixed(name))))
      throw new Error('UNAUTHORIZED_TOOLS_VISIBLE');
    checks.sessionReplayTools = true;
    checks.excludedToolsHidden = true;
    checks.nativeMcpBound = true;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LOCAL_PROBE_UNAVAILABLE');
    await call('navigate-local', {
      server: 'playwright',
      tool: 'browser_navigate',
      args: { url: `http://127.0.0.1:${address.port}` },
    });
    await call('local-ready', {
      server: 'playwright',
      tool: 'browser_wait_for',
      args: { text: MARKER },
    });
    const snapshot = await call('snapshot', {
      server: 'playwright',
      tool: 'browser_snapshot',
      args: {},
    });
    if (!snapshot.includes(MARKER)) throw new Error('SNAPSHOT_NOT_CONFIRMED');
    checks.browserNavigationAndSnapshot = true;
    if (target) {
      const { url, expectedText } = target;
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !expectedText
      )
        throw new Error('INVALID_PREFLIGHT_URL');
      await call('navigate-target', {
        server: 'playwright',
        tool: 'browser_navigate',
        args: { url },
      });
      await call('target-ready', {
        server: 'playwright',
        tool: 'browser_wait_for',
        args: { text: expectedText },
      });
      const targetSnapshot = await call('snapshot-target', {
        server: 'playwright',
        tool: 'browser_snapshot',
        args: {},
      });
      if (!targetSnapshot.includes(expectedText)) throw new Error('TARGET_NOT_READY');
      checks.targetNavigation = true;
    }
    await call('screenshot', {
      server: 'playwright',
      tool: 'browser_take_screenshot',
      args: { filename: 'preflight.png', type: 'png' },
    });
    const png = await readFile(join(directory, 'preflight.png'));
    if (png.length < 128 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      throw new Error('SCREENSHOT_NOT_CONFIRMED');
    receipts.push({
      operation: 'screenshot-file',
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    checks.screenshotFile = true;
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : ((error as NodeJS.ErrnoException).code ?? 'PREFLIGHT_FAILED');
    failure = { stage, code };
  } finally {
    try {
      if (session) {
        await session.dispose();
        checks.sessionDisposed = true;
      }
    } catch {
      failure ??= { stage: 'shutdown', code: 'MCP_SHUTDOWN_FAILED' };
    }
    server.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return {
    status: failure ? ('failed' as const) : ('passed' as const),
    modelRequests: 0,
    checks,
    receipts,
    tools,
    diagnostic: diagnostic ?? null,
    failure: failure ?? null,
  };
}
