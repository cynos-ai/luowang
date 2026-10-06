import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { SecretMetadata } from '../../shared/types.js';
import { SecretStoreError } from './secret-store.js';

const DEPLOYMENT_KEYS = ['providerApiKey', 'ossAccessKeyId', 'ossAccessKeySecret'] as const;
const PROJECT_KEYS = ['gitToken', 'testUsername', 'testPassword', 'testDataCleanupToken'] as const;
const RESOURCE_KEYS = [
  'token',
  'password',
  'privateKey',
  'privateKeyPassphrase',
  'content',
] as const;
const NONCE_BYTES = 12;
const MASK = '••••••••';
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeploymentSecretKey = (typeof DEPLOYMENT_KEYS)[number];
export type ProjectSecretKey = (typeof PROJECT_KEYS)[number];
export type ResourceSecretKey = (typeof RESOURCE_KEYS)[number];
export type ResourceSecretScope = 'github-credential' | 'execution-server' | 'project-file';

export interface BoundSecretStore<K extends string> {
  isAvailable(): boolean;
  set(key: K, value: string): void;
  get(key: K): string | undefined;
  has(key: K): boolean;
  delete(key: K): void;
  metadata(): Record<K, SecretMetadata>;
}

export interface ScopedSecretStore {
  deployment(): BoundSecretStore<DeploymentSecretKey>;
  project(projectId: string): BoundSecretStore<ProjectSecretKey>;
  resource(scope: ResourceSecretScope, resourceId: string): BoundSecretStore<ResourceSecretKey>;
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
      const direct = new BoundSqliteSecretStore(
        database,
        encryptionKey,
        'project',
        projectId,
        PROJECT_KEYS,
      );
      const selectedCredential = () => {
        if (!tableExists(database, 'project_resource_bindings')) return null;
        return (
          database
            .prepare(
              'SELECT github_credential_id FROM project_resource_bindings WHERE project_id = ?',
            )
            .get(projectId) as { github_credential_id: string | null } | undefined
        )?.github_credential_id;
      };
      const resourceToken = () => {
        const credentialId = selectedCredential();
        if (!credentialId) return undefined;
        return new BoundSqliteSecretStore(
          database,
          encryptionKey,
          'github-credential',
          credentialId,
          RESOURCE_KEYS,
        ).get('token');
      };
      return {
        isAvailable: () => direct.isAvailable(),
        set: (key, value) => direct.set(key, value),
        get: (key) => (key === 'gitToken' ? (resourceToken() ?? direct.get(key)) : direct.get(key)),
        has: (key) =>
          key === 'gitToken' ? resourceToken() !== undefined || direct.has(key) : direct.has(key),
        delete: (key) => direct.delete(key),
        metadata() {
          const metadata = direct.metadata();
          if (resourceToken() !== undefined) {
            metadata.gitToken = { configured: true, masked: MASK };
          }
          return metadata;
        },
      };
    },
    resource(scope, resourceId) {
      if (!PROJECT_ID_PATTERN.test(resourceId)) throw new TypeError('连接资源 ID 无效');
      return new BoundSqliteSecretStore(database, encryptionKey, scope, resourceId, RESOURCE_KEYS);
    },
  };
}

interface SecretRow {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

class BoundSqliteSecretStore<K extends string> implements BoundSecretStore<K> {
  constructor(
    private readonly database: Database.Database,
    private readonly encryptionKey: Buffer | undefined,
    private readonly scope: 'deployment' | 'project' | ResourceSecretScope,
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

  metadata(): Record<K, SecretMetadata> {
    return Object.fromEntries(
      this.allowedKeys.map((key) => [
        key,
        { configured: this.has(key), masked: this.has(key) ? MASK : null } satisfies SecretMetadata,
      ]),
    ) as Record<K, SecretMetadata>;
  }

  private storageKey(key: K): string {
    this.assertAllowed(key);
    if (this.scope === 'deployment') return `deployment:${key}`;
    if (this.scope === 'project') return `project:${this.projectId}:${key}`;
    return `resource:${this.scope}:${this.projectId}:${key}`;
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

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}
