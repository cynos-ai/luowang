import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore, SecretStoreError } from '../src/server/security/secret-store.js';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

describe('project-bound encrypted Secrets', () => {
  it('keeps deployment, project A, project B, and old keys separate', () => {
    const database = makeDatabase();
    try {
      const old = createSecretStore(database, 'synthetic-master-key');
      old.set('gitToken', 'old-token');
      const scoped = createScopedSecretStore(database, 'synthetic-master-key');
      const deployment = scoped.deployment();
      const a = scoped.project(PROJECT_A);
      const b = scoped.project(PROJECT_B);
      assert.equal(a.get('gitToken'), undefined);
      assert.equal(b.get('gitToken'), undefined);
      a.set('gitToken', 'token-a');
      b.set('gitToken', 'token-b');
      deployment.set('providerApiKey', 'provider-key');
      assert.equal(a.get('gitToken'), 'token-a');
      assert.equal(b.get('gitToken'), 'token-b');
      assert.equal(deployment.get('providerApiKey'), 'provider-key');
      assert.equal(old.get('gitToken'), 'old-token');
      assert.equal(a.metadata().gitToken.configured, true);
      assert.equal(b.metadata().testPassword.configured, false);
      assert.throws(() => a.get('providerApiKey' as 'gitToken'), /作用域/);
      assert.throws(() => scoped.project('../other'), /项目 ID/);
      const raw = database.prepare('SELECT key, ciphertext FROM secret_entries').all() as Array<{
        key: string;
        ciphertext: string;
      }>;
      assert.equal(raw.length, 4);
      assert.ok(raw.every((row) => !row.ciphertext.includes('token-')));
    } finally {
      database.close();
    }
  });

  it('rejects ciphertext transplanted to another project or scope', () => {
    const database = makeDatabase();
    try {
      const scoped = createScopedSecretStore(database, 'synthetic-master-key');
      const a = scoped.project(PROJECT_A);
      const b = scoped.project(PROJECT_B);
      a.set('gitToken', 'token-a');
      b.set('gitToken', 'token-b');
      const source = database
        .prepare('SELECT nonce, ciphertext, auth_tag FROM secret_entries WHERE key = ?')
        .get(`project:${PROJECT_A}:gitToken`) as {
        nonce: string;
        ciphertext: string;
        auth_tag: string;
      };
      database
        .prepare('UPDATE secret_entries SET nonce = ?, ciphertext = ?, auth_tag = ? WHERE key = ?')
        .run(source.nonce, source.ciphertext, source.auth_tag, `project:${PROJECT_B}:gitToken`);
      assert.throws(
        () => b.get('gitToken'),
        (error: unknown) =>
          error instanceof SecretStoreError && error.code === 'SECRET_DECRYPTION_FAILED',
      );
      assert.equal(a.get('gitToken'), 'token-a');
    } finally {
      database.close();
    }
  });
});

function makeDatabase(): Database.Database {
  const database = new Database(':memory:');
  runMigrations(database);
  return database;
}
