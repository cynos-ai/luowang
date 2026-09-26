import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { SecretKey, SecretMetadata, SecretMetadataMap } from '../../shared/types.js';
import { SecretStoreError } from './secret-store.js';

const DEPLOYMENT_KEYS = ['providerApiKey', 'ossAccessKeyId', 'ossAccessKeySecret'] as const;
const PROJECT_KEYS = ['gitToken', 'testUsername', 'testPassword', 'testDataCleanupToken'] as const;
const NONCE_BYTES = 12;
const MASK = '••••••••';
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeploymentSecretKey = (typeof DEPLOYMENT_KEYS)[number];
export type ProjectSecretKey = (typeof PROJECT_KEYS)[number];

export interface BoundSecretStore<K extends SecretKey> {
  isAvailable(): boolean;
  set(key: K, value: string): void;
  get(key: K): string | undefined;
  has(key: K): boolean;
  delete(key: K): void;
  metadata(): Pick<SecretMetadataMap, K>;
}

export interface ScopedSecretStore {
  deployment(): BoundSecretStore<DeploymentSecretKey>;
  project(projectId: string): BoundSecretStore<ProjectSecretKey>;
}

export function createScopedSecretStore(
  database: Database.Database,
  masterKey: string | undefined,
): ScopedSecretStore {
  const encryptionKey =
    masterKey === undefined ? undefined : scryptSync(masterKey, 'luowang-secret-store-v1', 32);
  return {
    deployment: () =>
      new BoundSqliteSecretStore(database, encryptionKey, 'deployment', null, DEPLOYMENT_KEYS),
    project(projectId) {
      if (!PROJECT_ID_PATTERN.test(projectId)) throw new TypeError('项目 ID 无效');
      return new BoundSqliteSecretStore(
        database,
        encryptionKey,
        'project',
        projectId,
        PROJECT_KEYS,
      );
    },
  };
}

interface SecretRow {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

class BoundSqliteSecretStore<K extends SecretKey> implements BoundSecretStore<K> {
  constructor(
    private readonly database: Database.Database,
    private readonly encryptionKey: Buffer | undefined,
    private readonly scope: 'deployment' | 'project',
    private readonly projectId: string | null,
    private readonly allowedKeys: readonly K[],
  ) {}

  isAvailable(): boolean {
    return this.encryptionKey !== undefined;
  }

  set(key: K, value: string): void {
    const storageKey = this.storageKey(key);
    const encryptionKey = this.requireEncryptionKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(this.aad(key));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO secret_entries
           (key, nonce, ciphertext, auth_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           nonce = excluded.nonce,
           ciphertext = excluded.ciphertext,
           auth_tag = excluded.auth_tag,
           updated_at = excluded.updated_at`,
      )
      .run(
        storageKey,
        nonce.toString('base64url'),
        ciphertext.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        now,
        now,
      );
  }

  get(key: K): string | undefined {
    const row = this.database
      .prepare('SELECT nonce, ciphertext, auth_tag FROM secret_entries WHERE key = ?')
      .get(this.storageKey(key)) as SecretRow | undefined;
    if (!row) return undefined;
    const encryptionKey = this.requireEncryptionKey();
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(row.nonce, 'base64url'),
      );
      decipher.setAAD(this.aad(key));
      decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new SecretStoreError(
        'SECRET_DECRYPTION_FAILED',
        'Secret store could not decrypt the configured value',
      );
    }
  }

  has(key: K): boolean {
    const row = this.database
      .prepare('SELECT 1 AS configured FROM secret_entries WHERE key = ?')
      .get(this.storageKey(key)) as { configured: number } | undefined;
    return row?.configured === 1;
  }

  delete(key: K): void {
    this.database.prepare('DELETE FROM secret_entries WHERE key = ?').run(this.storageKey(key));
  }

  metadata(): Pick<SecretMetadataMap, K> {
    return Object.fromEntries(
      this.allowedKeys.map((key) => [
        key,
        { configured: this.has(key), masked: this.has(key) ? MASK : null } satisfies SecretMetadata,
      ]),
    ) as Pick<SecretMetadataMap, K>;
  }

  private storageKey(key: K): string {
    this.assertAllowed(key);
    return this.scope === 'deployment' ? `deployment:${key}` : `project:${this.projectId}:${key}`;
  }

  private aad(key: K): Buffer {
    this.assertAllowed(key);
    return Buffer.from(JSON.stringify(['luowang-secret-v2', this.scope, this.projectId, key]));
  }

  private assertAllowed(key: K): void {
    if (!this.allowedKeys.includes(key)) throw new TypeError('Secret 不属于当前作用域');
  }

  private requireEncryptionKey(): Buffer {
    if (!this.encryptionKey) {
      throw new SecretStoreError('MASTER_KEY_NOT_CONFIGURED', 'Secret store is not configured');
    }
    return this.encryptionKey;
  }
}
