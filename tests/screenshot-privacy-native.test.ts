import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { it } from 'vitest';
import { createPlaywrightMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import type { ConfigurationStore } from '../src/server/configuration.js';

it('native MCP refuses populated text fields before producing pixels and permits empty forms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-screenshot-guard-'));
  const sentinel = 'synthetic-field-value';
  const pages: Record<string, string> = {
    '/text': `<input aria-label="Account" value="${sentinel}">`,
    '/email': `<input type="email" aria-label="Account" value="${sentinel}">`,
    '/password': `<input type="password" value="${sentinel}">`,
    '/readonly': `<input readonly value="${sentinel}">`,
    '/textarea': `<textarea>${sentinel}</textarea>`,
    '/editable': `<div contenteditable="true">${sentinel}</div>`,
    '/shadow': `<div id="host"></div><script>host.attachShadow({mode:'open'}).innerHTML='<input value="${sentinel}">';</script>`,
    '/frame': '<iframe src="/text"></iframe>',
    '/empty': '<h1>Login</h1><input aria-label="Account"><input type="password">',
    '/hidden': `<input style="display:none" value="${sentinel}"><h1>Visible area</h1>`,
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(pages[request.url ?? ''] ?? 'missing');
  });
  const browser = createPlaywrightMcpAdapter({
    getHarness: () => ({ mcp: { enabled: true, browser: 'chromium', timeoutMs: 15000 } }),
  } as ConfigurationStore);
  const definition = browser.serverDefinition(directory);
  const transport = new StdioClientTransport({
    command: definition.command,
    args: definition.args,
    env: definition.env,
    cwd: directory,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'screenshot-guard-test', version: '1.0.0' });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await client.connect(transport);
    for (const name of [
      'text',
      'email',
      'password',
      'readonly',
      'textarea',
      'editable',
      'shadow',
      'frame',
    ]) {
      await client.callTool({
        name: 'browser_navigate',
        arguments: { url: `http://127.0.0.1:${address.port}/${name}` },
      });
      const blocked = await client.callTool({
        name: 'browser_take_screenshot',
        arguments: { filename: `${name}.png`, fullPage: true },
      });
      assert.equal(blocked.isError, true, name);
      assert.match(JSON.stringify(blocked), /Screenshot blocked/);
      assert.doesNotMatch(JSON.stringify(blocked), new RegExp(sentinel));
      assert.ok(!blocked.content.some((part) => part.type === 'image'));
      assert.ok(!(await readdir(directory)).some((file) => file.endsWith('.png')), name);
    }
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: `http://127.0.0.1:${address.port}/text` },
    });
    const inline = await client.callTool({ name: 'browser_take_screenshot', arguments: {} });
    assert.equal(inline.isError, true);
    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.match(
      JSON.stringify(snapshot),
      new RegExp(sentinel),
      'guard must not clear or mask page state',
    );
    for (const name of ['empty', 'hidden']) {
      await client.callTool({
        name: 'browser_navigate',
        arguments: { url: `http://127.0.0.1:${address.port}/${name}` },
      });
      const allowed = await client.callTool({
        name: 'browser_take_screenshot',
        arguments: { filename: `${name}.png` },
      });
      assert.ok(!allowed.isError, JSON.stringify(allowed));
      const png = await readFile(join(directory, `${name}.png`));
      assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    }
  } finally {
    await client.close();
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
