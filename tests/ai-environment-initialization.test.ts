import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { startComposeApplication } from '../src/server/projects/application-runtime.js';
import { normalizeComposeDefinition } from '../src/server/projects/compose-contract.js';
import type { DockerRuntime } from '../src/server/projects/execution-container.js';

for (const fail of [false, true, 'check'] as const)
  it(`runs initialization before application health and ${fail ? 'stops on failure' : 'reinitializes recreated environments'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-init-'));
    const calls: string[][] = [];
    let initialized = 0;
    const server = createServer((_req, res) => {
      assert.ok(initialized > 0);
      res.end('ready');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const ids: Record<string, string> = {
      app: 'a'.repeat(64),
      db: 'b'.repeat(64),
      tools: 'c'.repeat(64),
    };
    const image = 'sha256:' + 'd'.repeat(64);
    const docker: DockerRuntime = {
      async run(args, options) {
        calls.push(args);
        if (args[0] === 'compose' && args.includes('ps'))
          return { stdout: ids[args.at(-1)!] ?? '', stderr: '', exitCode: 0 };
        if (args[0] === 'inspect') return { stdout: image, stderr: '', exitCode: 0 };
        if (args[0] === 'exec') {
          assert.equal(options.timeoutMs, 30_000);
          if (args.at(-1) === 'verify-login')
            return {
              stdout: '',
              stderr: 'synthetic-secret-must-not-leak',
              exitCode: fail === 'check' ? 1 : 0,
            };
          initialized++;
          return { stdout: '', stderr: '', exitCode: fail === true ? 1 : 0 };
        }
        if (args[0] === 'compose' && args.includes('port'))
          return { stdout: '127.0.0.1:1234', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const definition = normalizeComposeDefinition({
      source: `services:\n  app:\n    image: ${image}\n  db:\n    image: ${image}\n  tools:\n    image: ${image}\n`,
      instanceId: 'i',
      projectId: 'p',
      attemptId: '01K00000000000000000000001',
      enabledServices: ['app', 'db', 'tools'],
      applicationService: 'app',
      commandService: 'tools',
      servicePort: 3000,
    });
    const start = () =>
      startComposeApplication({
        docker,
        definition,
        buildSourceDirectory: root,
        commandSourceDirectory: root,
        targetCommit: 'a'.repeat(40),
        resolveBaseUrl: async () => ({
          baseUrl: `http://127.0.0.1:${address.port}`,
          async close() {},
        }),
        runtime: {
          workingDirectory: '.',
          prepareCommand: [],
          startCommand: [],
          servicePort: 3000,
          healthPath: '/',
          healthTimeoutSeconds: 5,
          composeFile: 'compose.yml',
          composeServices: ['app', 'db', 'tools'],
          applicationService: 'app',
          commandService: 'tools',
          preparationChecks: [
            {
              kind: 'account',
              label: '验证登录',
              service: 'tools',
              command: 'verify-login',
              timeoutSeconds: 30,
            },
          ],
          initializationSteps: [
            { service: 'tools', command: 'seed && verify', timeoutSeconds: 30 },
          ],
        },
      });
    try {
      if (fail === 'check') {
        await assert.rejects(start(), (error: Error) => {
          assert.match(error.message, /测试账号核验未通过/);
          assert.ok(!error.message.includes('synthetic-secret'));
          return true;
        });
        assert.ok(calls.some((args) => args.includes('down')));
      } else if (fail) {
        await assert.rejects(start(), /初始化步骤失败/);
        assert.equal(
          calls.some((args) => args.includes('start') && args.at(-1) === 'app'),
          false,
        );
        assert.ok(calls.some((args) => args.includes('down')));
      } else {
        const first = await start();
        await first.close();
        const second = await start();
        await second.close();
        assert.equal(initialized, 2);
        const initIndex = calls.findIndex((args) => args[0] === 'exec');
        const startIndex = calls.findIndex(
          (args) => args.includes('start') && args.at(-1) === 'app',
        );
        assert.ok(initIndex >= 0 && startIndex > initIndex);
        const checkIndex = calls.findIndex((args) => args.at(-1) === 'verify-login');
        assert.ok(checkIndex > startIndex);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
