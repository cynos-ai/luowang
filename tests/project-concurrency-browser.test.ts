import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { it } from 'vitest';
import { createPlaywrightMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import type { ConfigurationStore } from '../src/server/configuration.js';

it('isolates two live MCP browsers and same-name screenshots; closing A leaves B usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-parallel-browser-'));
  const server = createServer((request, response) => {
    const marker = request.url?.includes('project-a') ? 'project-a' : 'project-b';
    response.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': `project=${marker}; Path=/`,
    });
    response.end(
      `<h1>${marker}</h1><input value="${marker}"><script>document.body.append(document.cookie)</script>`,
    );
  });
  const adapter = createPlaywrightMcpAdapter({
    getHarness: () => ({ mcp: { enabled: true, browser: 'chromium', timeoutMs: 15000 } }),
  } as ConfigurationStore);
  const clients: Array<{ client: Client; transport: StdioClientTransport; directory: string }> = [];
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const name of ['a', 'b']) {
      const directory = await mkdtemp(join(root, name));
      const definition = adapter.serverDefinition(directory);
      const transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args,
        env: definition.env,
        cwd: directory,
        stderr: 'pipe',
      });
      const client = new Client({ name: `parallel-${name}`, version: '1.0.0' });
      clients.push({ client, transport, directory });
      await client.connect(transport);
    }
    await Promise.all(
      clients.map(async ({ client }, index) => {
        const own = index === 0 ? 'project-a' : 'project-b';
        const other = index === 0 ? 'project-b' : 'project-a';
        assert.ok(
          !(
            await client.callTool({
              name: 'browser_navigate',
              arguments: { url: `http://127.0.0.1:${address.port}/${own}` },
            })
          ).isError,
        );
        const snapshot = JSON.stringify(
          await client.callTool({ name: 'browser_snapshot', arguments: {} }),
        );
        assert.ok(snapshot.includes(own));
        assert.ok(!snapshot.includes(other));
        assert.ok(
          !(
            await client.callTool({
              name: 'browser_take_screenshot',
              arguments: { filename: 'same-scenario.png' },
            })
          ).isError,
        );
      }),
    );
    const images = await Promise.all(
      clients.map(({ directory }) => readFile(join(directory, 'same-scenario.png'))),
    );
    assert.ok(images.every((bytes) => bytes.length > 100));
    assert.ok(!images[0].equals(images[1]));
    await clients[0].client.close();
    const surviving = await clients[1].client.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.ok(!surviving.isError);
    assert.match(JSON.stringify(surviving), /project-b/);
    assert.ok((await readFile(join(clients[1].directory, 'same-scenario.png'))).equals(images[1]));
  } finally {
    await Promise.all(
      clients.map(async ({ client, transport }) => {
        await client.close();
        await transport.close();
      }),
    );
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
