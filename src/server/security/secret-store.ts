import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { SecretKey, SecretMetadata, SecretMetadataMap } from '../../shared/types.js';

const CIPHER = 'aes-256-gcm';
const NONCE_BYTES = 12;
const DERIVATION_SALT = 'luowang-secret-store-v1';
const MASK = '••••••••';

export const SECRET_KEYS: readonly SecretKey[] = [
  'providerApiKey',
  'gitToken',
  'testUsername',
  'testPassword',
  'ossAccessKeyId',
  'ossAccessKeySecret',
];

export class SecretStoreError extends Error {
  readonly code: 'MASTER_KEY_NOT_CONFIGURED' | 'SECRET_DECRYPTION_FAILED';

  constructor(code: 'MASTER_KEY_NOT_CONFIGURED' | 'SECRET_DECRYPTION_FAILED', message: string) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

export interface SecretStore {
  isAvailable(): boolean;
  set(key: SecretKey, value: string): void;
  get(key: SecretKey): string | undefined;
  has(key: SecretKey): boolean;
  delete(key: SecretKey): void;
  metadata(): SecretMetadataMap;
}

interface SecretRow {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

export function isSecretKey(value: string): value is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(value);
}

export function createSecretStore(
  database: Database.Database,
  masterKey: string | undefined,
): SecretStore {
  return new SqliteSecretStore(database, masterKey);
}

class SqliteSecretStore implements SecretStore {
  private readonly encryptionKey: Buffer | undefined;

  constructor(
    private readonly database: Database.Database,
    masterKey: string | undefined,
  ) {
    this.encryptionKey =
      masterKey === undefined ? undefined : scryptSync(masterKey, DERIVATION_SALT, 32);
  }

  isAvailable(): boolean {
    return this.encryptionKey !== undefined;
  }

  set(key: SecretKey, value: string): void {
    if (value.length === 0) {
      return;
    }

    const encryptionKey = this.requireEncryptionKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, encryptionKey, nonce);
    cipher.setAAD(Buffer.from(key, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
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
        key,
        nonce.toString('base64url'),
        ciphertext.toString('base64url'),
        authTag.toString('base64url'),
        now,
        now,
      );
  }

  get(key: SecretKey): string | undefined {
    const row = this.database
      .prepare('SELECT nonce, ciphertext, auth_tag FROM secret_entries WHERE key = ?')
      .get(key) as SecretRow | undefined;
    if (!row) {
      return undefined;
    }

    const encryptionKey = this.requireEncryptionKey();
    try {
      const decipher = createDecipheriv(CIPHER, encryptionKey, Buffer.from(row.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(key, 'utf8'));
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

  has(key: SecretKey): boolean {
    const row = this.database
      .prepare('SELECT 1 AS configured FROM secret_entries WHERE key = ?')
      .get(key) as { configured: number } | undefined;
    return row?.configured === 1;
  }

  delete(key: SecretKey): void {
    this.database.prepare('DELETE FROM secret_entries WHERE key = ?').run(key);
  }

  metadata(): SecretMetadataMap {
    return Object.fromEntries(
      SECRET_KEYS.map((key) => [key, this.metadataFor(key)]),
    ) as SecretMetadataMap;
  }

  private metadataFor(key: SecretKey): SecretMetadata {
    return {
      configured: this.has(key),
      masked: this.has(key) ? MASK : null,
    };
  }

  private requireEncryptionKey(): Buffer {
    if (!this.encryptionKey) {
      throw new SecretStoreError('MASTER_KEY_NOT_CONFIGURED', 'Secret store is not configured');
    }
    return this.encryptionKey;
  }
}
