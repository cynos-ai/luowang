import { createHash } from 'node:crypto';
import { readScreenshotReceipt } from '../src/server/runs/screenshot-inspection.js';
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

it('native MCP captures populated forms without changing state and labels detection outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-screenshot-guard-'));
  const sentinel = 'synthetic-field-value';
  const pages: Record<string, string> = {
    '/unknown':
      '<h1>Unchanged</h1><script>Element.prototype.checkVisibility = () => { throw new Error("fixture"); };</script><input value="field">',
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
    '/stable-error': `<h1>Login rejected</h1><input aria-label="Account" value="${sentinel}"><input aria-label="Passphrase" type="password" value="${sentinel}">`,
    '/dependent-error': `<h1 id="result">Login rejected</h1><input aria-label="Account" value="${sentinel}" oninput="document.getElementById('result').textContent='Form changed'"><input aria-label="Passphrase" type="password" value="${sentinel}">`,
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
      'empty',
      'hidden',
      'stable-error',
      'dependent-error',
      'unknown',
    ]) {
      await client.callTool({
        name: 'browser_navigate',
        arguments: { url: 'http://127.0.0.1:' + address.port + '/' + name },
      });
      const before = JSON.stringify(
        await client.callTool({ name: 'browser_snapshot', arguments: {} }),
      );
      const captured = await client.callTool({
        name: 'browser_take_screenshot',
        arguments: { filename: name + '.png', fullPage: true },
      });
      assert.ok(!captured.isError, JSON.stringify(captured));
      const text = captured.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      const receipt = readScreenshotReceipt(text);
      const expected =
        name === 'unknown'
          ? 'unknown'
          : ['empty', 'hidden'].includes(name)
            ? 'not_detected'
            : 'detected';
      assert.equal(receipt.inspection.status, expected, name);
      assert.doesNotMatch(text, new RegExp(sentinel));
      const png = await readFile(join(directory, name + '.png'));
      assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
      assert.equal(receipt.inspection.sha256, createHash('sha256').update(png).digest('hex'));
      const after = JSON.stringify(
        await client.callTool({ name: 'browser_snapshot', arguments: {} }),
      );
      assert.equal(after, before, name + ': capture must not alter state');
      if (name.endsWith('-error')) {
        assert.match(after, /Login rejected/);
        assert.ok(after.includes(sentinel));
      }
    }
    const invalid = await client.callTool({
      name: 'browser_take_screenshot',
      arguments: { fullPage: true, target: 'missing-ref' },
    });
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /LUOWANG_SCREENSHOT_CAPTURE/);
  } finally {
    await client.close();
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
