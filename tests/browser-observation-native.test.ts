import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createPlaywrightMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import type { ConfigurationStore } from '../src/server/configuration.js';
import { createBrowserObservationExtension } from '../src/server/runs/browser-observation.js';
import { createRunEvidenceStore } from '../src/server/runs/evidence.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';

it.each(['mcp', 'mcp__playwright'])(
  'captures real SDK/%s cookie replay and the actual request header with zero model requests',
  async (proxyName) => {
    const directory = await mkdtemp(join(tmpdir(), 'luowang-native-observation-'));
    const cookie = 'synthetic-native-session-evidence';
    let observedCookie: string | undefined;
    const server = createServer((request, response) => {
      if (request.url === '/login')
        response.setHeader('set-cookie', `session=${cookie}; Path=/; HttpOnly`);
      if (request.url === '/logout')
        response.setHeader('set-cookie', 'session=; Path=/; Max-Age=0');
      if (request.url === '/me') {
        observedCookie = request.headers.cookie;
        response.statusCode = 401;
      }
      response.setHeader('content-type', 'text/html');
      response.end(
        '<h1>Local replay fixture</h1><input aria-label="Account" value="native-form-account"><input aria-label="Passphrase" type="password" value="native-form-passphrase">',
      );
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const workspace = new RunWorkspace('01K00000000000000000000000', directory);
      await workspace.create();
      const transport = localEvidenceTransport();
      const store = createRunEvidenceStore(workspace, transport.oss);
      store.allowBrowserRecords!();
      const browser = createPlaywrightMcpAdapter({
        getHarness: () => ({ mcp: { enabled: true, browser: 'chromium', timeoutMs: 15000 } }),
      } as ConfigurationStore);
      const browserExtension = browser.extension(workspace.evidenceDirectory);
      const install =
        typeof browserExtension === 'function' ? browserExtension : browserExtension.factory;
      const proxies = new Map<string, ToolDefinition>();
      let failures = 0;
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const model = runtime.getModels().find((candidate) => !candidate.reasoning)!;
      const settings = SettingsManager.inMemory({
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: 'Local native evidence check',
        extensionFactories: [
          {
            name: 'test-native-proxy',
            factory: async (pi) => {
              await install({
                ...pi,
                registerTool: (tool) => {
                  proxies.set(tool.name, tool as ToolDefinition);
                  pi.registerTool(tool);
                },
              });
              pi.on('before_provider_request', () => {
                throw new Error('Model requests forbidden');
              });
            },
          },
          createBrowserObservationExtension({
            store,
            targetCommit: 'fixed-native-target',
            now: () => new Date(),
            operationContext: () => ({ scenarioId: 'SESSION' }),
            onFailure: () => {
              failures++;
            },
          }),
        ],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd: directory,
        model,
        modelRuntime: runtime,
        thinkingLevel: 'off',
        sessionManager: SessionManager.inMemory(directory),
        settingsManager: settings,
        resourceLoader: loader,
        noTools: 'builtin',
      }));
      await session.bindExtensions({ mode: 'print' });
      // Lazy discovery registers the namespace proxy as well as the generic gateway.
      await proxies
        .get('mcp')!
        .execute(
          'connect-native',
          { connect: 'playwright' },
          AbortSignal.timeout(20000),
          undefined,
          session.extensionRunner.createContext(),
        );
      let sequence = 0;
      const call = async (tool: string, args: Record<string, unknown>) => {
        const proxy = proxies.get(proxyName);
        assert.ok(proxy && session);
        const toolCallId = `native-${++sequence}`;
        const input = proxyName === 'mcp' ? { server: 'playwright', tool, args } : { tool, args };
        const blocked = await session.extensionRunner.emitToolCall({
          type: 'tool_call',
          toolName: proxyName,
          toolCallId,
          input,
        });
        assert.ok(!blocked?.block);
        const result = await proxy.execute(
          toolCallId,
          input,
          AbortSignal.timeout(20000),
          undefined,
          session.extensionRunner.createContext(),
        );
        assert.ok(
          !(result.details as Record<string, unknown>)?.error,
          JSON.stringify(result.content),
        );
        const observed = await session.extensionRunner.emitToolResult({
          type: 'tool_result',
          toolName: proxyName,
          toolCallId,
          input,
          content: result.content,
          details: result.details,
          isError: false,
        });
        return (observed?.content ?? result.content)
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
      };
      const page = await call('browser_navigate', { url: `${baseUrl}/login` });
      assert.doesNotMatch(page, /native-form-account|native-form-passphrase/);
      const snapshotText = await call('browser_snapshot', {});
      assert.match(snapshotText, /Local replay fixture/);
      assert.doesNotMatch(snapshotText, /native-form-account|native-form-passphrase/);
      assert.equal(
        store.redactText!('native-form-account / native-form-passphrase'),
        '[REDACTED] / [REDACTED]',
      );
      await call('browser_cookie_get', { name: 'session' });
      await call('browser_navigate', { url: `${baseUrl}/logout` });
      await call('browser_cookie_set', {
        name: 'session',
        value: cookie,
        domain: '127.0.0.1',
        path: '/',
      });
      await call('browser_navigate', { url: `${baseUrl}/me` });
      const requests = await call('browser_network_requests', { static: true });
      const index = requests.match(/^(\d+)\. \[GET\] [^\r\n]*\/me\b/m)?.[1];
      assert.ok(index, requests);
      await call('browser_network_request', { index: Number(index) });
      await call('browser_network_request', { index: Number(index), part: 'request-headers' });
      assert.equal(observedCookie, `session=${cookie}`);
      assert.equal(failures, 0);
      const uploaded = await store.uploadAll();
      assert.deepEqual(uploaded.failures, []);
      const observations = await Promise.all(
        store
          .commandEvidenceIds()
          .map(async (id) => JSON.parse(await store.readCommandEvidence(id)).observation),
      );
      const get = observations.find((record) => record.tool === 'browser_cookie_get');
      const snapshot = observations.find((record) => record.tool === 'browser_snapshot');
      assert.match(snapshot.output, /Local replay fixture/);
      assert.doesNotMatch(snapshot.output, /native-form-account|native-form-passphrase/);
      const set = observations.find((record) => record.tool === 'browser_cookie_set');
      const network = observations.find((record) => record.tool === 'browser_network_request');
      assert.equal(get.credentialReferences.length, 1, JSON.stringify(get));
      assert.equal(set.credentialReferences[0].reference, get.credentialReferences[0].reference);
      assert.equal(network.credentialReferences.length, 1, JSON.stringify(network));
      assert.equal(
        network.credentialReferences[0].reference,
        get.credentialReferences[0].reference,
      );
      assert.match(network.output, /401/);
      const headers = observations
        .filter((record) => record.tool === 'browser_network_request')
        .at(-1)!;
      assert.equal(
        headers.credentialReferences[0].reference,
        get.credentialReferences[0].reference,
      );
      for (const body of transport.objects.values()) {
        assert.ok(!body.toString().includes(cookie));
        assert.doesNotMatch(body.toString(), /native-form-account|native-form-passphrase/);
      }
    } finally {
      if (session) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
