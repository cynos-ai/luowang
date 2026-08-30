import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe('Phase 1 secure console', () => {
  it('does not provide anonymous setup when the admin password is missing', async () => {
    const { app } = await makeApp();

    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.deepEqual(status.json(), { configured: false, authenticated: false });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'this-password-is-not-configured' },
    });
    assert.equal(login.statusCode, 401);

    const anonymousConfig = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(anonymousConfig.statusCode, 401);
  });

  it('initializes Argon2id, protects configuration, and encrypts secrets', async () => {
    const password = 'phase1-admin-password!';
    const masterKey = 'phase1-master-key-material';
    const { app, database } = await makeApp({ password, masterKey });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password },
    });
    assert.equal(login.statusCode, 200);
    const cookie = readSessionCookie(login.headers['set-cookie']);
    assert.ok(cookie);
    assert.match(cookie, /^luowang_session=/);
    assert.match(login.headers['set-cookie'] ?? '', /HttpOnly/);
    assert.match(login.headers['set-cookie'] ?? '', /SameSite=Strict/);
    assert.equal(login.body.includes(password), false);

    const configBefore = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie },
    });
    assert.equal(configBefore.statusCode, 200);
    assert.equal(configBefore.json().repository.scenarioBranch, 'scenario-testing');

    const secretId = 'synthetic-oss-access-id';
    const secretValue = 'synthetic-oss-secret-value';
    const update = await app.inject({
      method: 'PUT',
      url: '/api/config/harness',
      headers: { cookie },
      payload: {
        provider: 'test-provider',
        oss: {
          endpoint: 'https://object-storage.example.test',
          bucket: 'test-bucket',
        },
        secrets: { ossAccessKeyId: secretId, ossAccessKeySecret: secretValue },
      },
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.body.includes(secretId), false);
    assert.equal(update.body.includes(secretValue), false);
    assert.equal(update.json().secrets.ossAccessKeyId.configured, true);
    assert.equal(update.json().secrets.ossAccessKeySecret.masked, '••••••••');

    const emptyOverwrite = await app.inject({
      method: 'PUT',
      url: '/api/config/harness',
      headers: { cookie },
      payload: { secrets: { ossAccessKeySecret: '' } },
    });
    assert.equal(emptyOverwrite.statusCode, 200);
    assert.equal(emptyOverwrite.json().secrets.ossAccessKeySecret.configured, true);

    const secretMetadata = await app.inject({
      method: 'GET',
      url: '/api/secrets',
      headers: { cookie },
    });
    assert.equal(secretMetadata.statusCode, 200);
    assert.equal(secretMetadata.body.includes(secretId), false);
    assert.equal(secretMetadata.body.includes(secretValue), false);

    const storedSecret = database.sqlite
      .prepare('SELECT nonce, ciphertext, auth_tag FROM secret_entries WHERE key = ?')
      .get('ossAccessKeySecret') as { nonce: string; ciphertext: string; auth_tag: string };
    assert.ok(storedSecret);
    assert.notEqual(storedSecret.ciphertext, secretValue);
    assert.equal(JSON.stringify(storedSecret).includes(secretValue), false);

    const wrongOrigin = await app.inject({
      method: 'PUT',
      url: '/api/config/repository',
      headers: { cookie, origin: 'https://evil.example.test' },
      payload: { repository: 'https://github.com/example/project' },
    });
    assert.equal(wrongOrigin.statusCode, 403);
    assert.equal(wrongOrigin.json().error.code, 'ORIGIN_FORBIDDEN');

    const checks = await app.inject({
      method: 'GET',
      url: '/api/connectivity/checks',
      headers: { cookie },
    });
    assert.equal(checks.statusCode, 200);
    assert.equal(
      checks.json().checks.find((item: { id: string }) => item.id === 'oss').result.status,
      'not_available',
    );

    const unregisteredCheck = await app.inject({
      method: 'POST',
      url: '/api/connectivity/checks/oss',
      headers: { cookie },
    });
    assert.equal(unregisteredCheck.statusCode, 501);
    assert.equal(unregisteredCheck.json().result.message, '对应能力尚未提供');

    const adminRow = database.sqlite
      .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
      .get() as { password_hash: string };
    assert.match(adminRow.password_hash, /^\$argon2id\$/);
    assert.equal(adminRow.password_hash.includes(password), false);

    const newPassword = 'phase1-new-admin-password!';
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } })).statusCode,
      401,
    );

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password },
    });
    assert.equal(oldLogin.statusCode, 401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: newPassword },
    });
    assert.equal(newLogin.statusCode, 200);
    const newCookie = readSessionCookie(newLogin.headers['set-cookie']);
    database.sqlite
      .prepare('UPDATE auth_sessions SET expires_at = ?')
      .run('2000-01-01T00:00:00.000Z');
    const expiredConfig = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie: newCookie },
    });
    assert.equal(expiredConfig.statusCode, 401);

    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: newPassword },
    });
    const secondCookie = readSessionCookie(secondLogin.headers['set-cookie']);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: secondCookie },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/config', headers: { cookie: secondCookie } }))
        .statusCode,
      401,
    );
  });

  it('does not let a changed bootstrap environment password replace the stored password', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'luowang-password-'));
    cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
    const oldPassword = 'phase1-old-password!';
    const newPassword = 'phase1-env-password!';
    const firstConfig = loadConfig({
      NODE_ENV: 'test',
      LUOWANG_DATA_DIR: dataDir,
      LUOWANG_ADMIN_PASSWORD: oldPassword,
      LUOWANG_MASTER_KEY: 'phase1-master-key-material',
    });
    const firstDatabase = initializeDatabase(firstConfig);
    const firstApp = await createApp({
      config: firstConfig,
      database: firstDatabase,
      logger: pino({ level: 'silent' }),
    });
    await firstApp.ready();
    await firstApp.close();

    const secondConfig = loadConfig({
      NODE_ENV: 'test',
      LUOWANG_DATA_DIR: dataDir,
      LUOWANG_ADMIN_PASSWORD: newPassword,
      LUOWANG_MASTER_KEY: 'phase1-master-key-material',
    });
    const secondDatabase = initializeDatabase(secondConfig);
    const secondApp = await createApp({
      config: secondConfig,
      database: secondDatabase,
      logger: pino({ level: 'silent' }),
    });
    cleanup.push(async () => secondApp.close());

    const oldLogin = await secondApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: oldPassword },
    });
    assert.equal(oldLogin.statusCode, 200);
    const newLogin = await secondApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: newPassword },
    });
    assert.equal(newLogin.statusCode, 401);
  });

  it('enforces the login rate limiter', async () => {
    const { app } = await makeApp({ password: 'phase1-rate-limit-password!' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'wrong-password-for-rate-limit' },
      });
      assert.equal(response.statusCode, 401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase1-rate-limit-password!' },
    });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers['retry-after']);
  });

  it('checks a configured test environment and distinguishes unavailable adapters', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    cleanup.push(
      async () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    const { app } = await makeApp({
      password: 'phase1-connectivity-password!',
      masterKey: 'phase1-master-key-material',
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'phase1-connectivity-password!' },
    });
    const cookie = readSessionCookie(login.headers['set-cookie']);
    const save = await app.inject({
      method: 'PUT',
      url: '/api/config/repository',
      headers: { cookie },
      payload: { baseUrl: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(save.statusCode, 200);

    const result = await app.inject({
      method: 'POST',
      url: '/api/connectivity/checks/test-environment-url',
      headers: { cookie },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().result.status, 'ok');
    assert.equal(result.json().result.message, '测试环境可访问');
  });
});

async function makeApp(options: { password?: string; masterKey?: string } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase1-'));
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_ADMIN_PASSWORD: options.password,
    LUOWANG_MASTER_KEY: options.masterKey,
  });
  const database = initializeDatabase(config);
  const app = await createApp({ config, database, logger: pino({ level: 'silent' }) });
  cleanup.push(async () => app.close());
  return { app, database };
}

function readSessionCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}
