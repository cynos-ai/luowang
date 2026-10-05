import { strict as assert } from 'node:assert';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { chromium } from 'playwright';

import { it } from 'vitest';

import { createRunOriginProxy } from '../src/server/browser/playwright-mcp.js';

it('allows only the current Run origin across HTTP, redirects, CONNECT and WebSocket', async () => {
  let blockedHits = 0;
  const blocked = createServer((_request, response) => {
    blockedHits += 1;
    response.end('foreign');
  });
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${portOf(blocked)}/foreign` });
      response.end();
      return;
    }
    response.end('allowed');
  });
  allowed.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    socket.end();
  });
  await Promise.all([listen(blocked), listen(allowed)]);
  const proxy = await createRunOriginProxy(`http://127.0.0.1:${portOf(allowed)}`);
  try {
    assert.deepEqual(await proxyGet(proxy.port, `http://127.0.0.1:${portOf(allowed)}/ok`), {
      status: 200,
      body: 'allowed',
      location: undefined,
    });
    const redirect = await proxyGet(proxy.port, `http://127.0.0.1:${portOf(allowed)}/redirect`);
    assert.equal(redirect.status, 403);
    assert.equal(blockedHits, 0);
    assert.match(
      await rawProxyRequest(
        proxy.port,
        `CONNECT 127.0.0.1:${portOf(blocked)} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
      ),
      /^HTTP\/1\.1 403 Forbidden/,
    );
    assert.match(
      await rawProxyRequest(
        proxy.port,
        `GET ws://127.0.0.1:${portOf(allowed)}/socket HTTP/1.1\r\nHost: 127.0.0.1:${portOf(allowed)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      ),
      /^HTTP\/1\.1 101 Switching Protocols/,
    );
  } finally {
    await proxy.close();
    await Promise.all([close(blocked), close(allowed)]);
  }
});

it('keeps a real browser on the Run origin when the application redirects elsewhere', async () => {
  let blockedHits = 0;
  const blocked = createServer((_request, response) => {
    blockedHits += 1;
    response.end('foreign');
  });
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${portOf(blocked)}/foreign` });
      response.end();
      return;
    }
    response.end('allowed');
  });
  await Promise.all([listen(blocked), listen(allowed)]);
  const proxy = await createRunOriginProxy(`http://127.0.0.1:${portOf(allowed)}`);
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
  });
  try {
    const page = await browser.newPage();
    assert.equal(
      await page
        .goto(`http://127.0.0.1:${portOf(allowed)}/ok`)
        .then((response) => response?.status()),
      200,
    );
    assert.equal(
      await page
        .goto(`http://127.0.0.1:${portOf(allowed)}/redirect`)
        .then((response) => response?.status()),
      403,
    );
    assert.equal(page.url(), `http://127.0.0.1:${portOf(allowed)}/redirect`);
    assert.equal(blockedHits, 0);
  } finally {
    await browser.close();
    await proxy.close();
    await Promise.all([close(blocked), close(allowed)]);
  }
});

it('allows configured additional origins while continuing to block unlisted origins', async () => {
  const primary = createServer((_request, response) => response.end('primary'));
  const additional = createServer((_request, response) => response.end('additional'));
  const blocked = createServer((_request, response) => response.end('blocked'));
  await Promise.all([listen(primary), listen(additional), listen(blocked)]);
  const proxy = await createRunOriginProxy(`http://127.0.0.1:${portOf(primary)}`, [
    `http://127.0.0.1:${portOf(additional)}`,
  ]);
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
  });
  try {
    assert.equal(
      (await proxyGet(proxy.port, `http://127.0.0.1:${portOf(additional)}/asset`)).body,
      'additional',
    );
    assert.equal(
      (await proxyGet(proxy.port, `http://127.0.0.1:${portOf(blocked)}/asset`)).status,
      403,
    );
    const page = await browser.newPage();
    assert.equal(
      await page
        .goto(`http://127.0.0.1:${portOf(additional)}/asset`)
        .then((response) => response?.status()),
      200,
    );
    assert.equal(
      await page
        .goto(`http://127.0.0.1:${portOf(blocked)}/asset`)
        .then((response) => response?.status()),
      403,
    );
  } finally {
    await browser.close();
    await proxy.close();
    await Promise.all([close(primary), close(additional), close(blocked)]);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function portOf(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server has no port');
  return address.port;
}

function proxyGet(
  proxyPort: number,
  url: string,
): Promise<{ status: number; body: string; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: url },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            location: response.headers.location,
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function rawProxyRequest(proxyPort: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(payload));
    let value = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      value += chunk;
      if (value.includes('\r\n\r\n')) socket.end();
    });
    socket.on('end', () => resolve(value));
    socket.on('error', reject);
  });
}
