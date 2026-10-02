import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'vitest';
import { startLocalModelProtocol } from './acceptance/local-model-protocol.js';
import { createPlaywrightMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import type { ConfigurationStore } from '../src/server/configuration.js';

it('aborts an actual production Pi streaming HTTP request and disposes its isolated Session', async () => {
  const model = await startLocalModelProtocol('stall');
  const cwd = await mkdtemp(join(tmpdir(), 'luowang-stop-sdk-'));
  const controller = new AbortController();
  const session = await model.sessionFactory.create({
    role: 'main-a',
    sessionKind: 'main-planning',
    config: { model: 'deterministic-tool-model', thinking: 'off' },
    cwd,
    toolNames: [],
    customTools: [],
    systemPrompt: 'Wait for this controlled local protocol.',
    userMessage: 'test',
    roleInstructionVersions: [],
    signal: controller.signal,
  });
  try {
    const prompt = session.prompt('test');
    const rejected = assert.rejects(prompt);
    const deadline = Date.now() + 5000;
    while (model.requestCount === 0 && Date.now() < deadline) await delay(5);
    assert.equal(model.requestCount, 1);
    controller.abort();
    await rejected;
    while (model.abortedRequests === 0 && Date.now() < deadline) await delay(5);
    assert.equal(model.abortedRequests, 1, 'the HTTP stream must actually close');
    await session.dispose();
    await session.dispose();
    assert.equal(model.sessions[0].disposed, true);
    assert.equal(model.requestCount, 1, 'no retry/model continuation after stop');
  } finally {
    controller.abort();
    await session.dispose();
    await model.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'linux')(
  'closes the actual owned MCP/browser process while a second production Session remains active',
  async () => {
    const model = await startLocalModelProtocol('browser-stall');
    const roots = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), 'luowang-stop-mcp-'))));
    const controllers = roots.map(() => new AbortController());
    const browser = createPlaywrightMcpAdapter({
      getHarness: () => ({ mcp: { enabled: true, browser: 'chromium', timeoutMs: 10000 } }),
    } as ConfigurationStore);
    const sessions = await Promise.all(
      roots.map((cwd, i) =>
        model.sessionFactory.create({
          role: 'runner',
          sessionKind: 'runner-execution',
          config: { model: 'deterministic-tool-model', thinking: 'off' },
          cwd,
          toolNames: [],
          customTools: [],
          systemPrompt: 'Controlled local native stop check',
          userMessage: 'test',
          roleInstructionVersions: [],
          signal: controllers[i].signal,
          extensionFactories: [browser.extension(cwd)],
        }),
      ),
    );
    const rejected = sessions.map((session) => assert.rejects(session.prompt('test')));
    try {
      const deadline = Date.now() + 20000;
      while (model.requestCount < 4 && Date.now() < deadline) await delay(20);
      assert.equal(model.requestCount, 4, JSON.stringify([...model.observedToolResults]));
      assert.ok(
        [...model.observedToolResults].every((value) => !value.includes('Error:')),
        JSON.stringify([...model.observedToolResults]),
      );
      const owned = await Promise.all(
        roots.map(async (root) => {
          const ids: number[] = [];
          for (const pid of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
            const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
            if (command.includes(root) && command.includes('/cli.js')) ids.push(Number(pid));
          }
          assert.equal(ids.length, 1, 'one real MCP process per Session');
          return ids[0];
        }),
      );
      const processes = await Promise.all(
        (await readdir('/proc'))
          .filter((name) => /^\d+$/.test(name))
          .map(async (pid) => {
            const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
            return {
              pid: Number(pid),
              parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
              status,
            };
          }),
      );
      const descendants = new Set([owned[0]]);
      for (let count = -1; count !== descendants.size;) {
        count = descendants.size;
        for (const proc of processes) if (descendants.has(proc.parent)) descendants.add(proc.pid);
      }
      assert.ok(
        descendants.size > 1,
        'capture the real browser subprocesses as well as the MCP server',
      );
      controllers[0].abort();
      await rejected[0];
      await sessions[0].dispose();
      assert.equal(
        await readFile(`/proc/${owned[0]}/cmdline`, 'utf8').catch(() => ''),
        '',
        'A child has actually exited',
      );
      for (const pid of descendants) {
        const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
        assert.ok(!status || /^State:\s+Z/m.test(status), `owned process ${pid} must have exited`);
      }
      assert.ok(
        (await readFile(`/proc/${owned[1]}/cmdline`, 'utf8')).includes(roots[1]),
        'B child remains running',
      );
      assert.equal(model.requestCount, 4, 'stop must not retry or continue a model');
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(rejected);
      await Promise.all(sessions.map((session) => session.dispose()));
      await model.close();
      await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
    }
  },
  45000,
);
