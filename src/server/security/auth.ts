import { createHash, randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import type Database from 'better-sqlite3';

export const SESSION_COOKIE_NAME = 'luowang_session';
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

export class AuthError extends Error {
  readonly code: 'WEAK_PASSWORD' | 'INVALID_PASSWORD';

  constructor(code: 'WEAK_PASSWORD' | 'INVALID_PASSWORD', message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthService {
  isConfigured(): boolean;
  login(password: string): Promise<string | null>;
  authenticate(token: string | undefined): boolean;
  logout(token: string | undefined): void;
  changePassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean>;
  revokeAll(): void;
}

interface PasswordRow {
  password_hash: string;
}

interface SessionRow {
  token_hash: string;
}

export function validatePassword(password: unknown): asserts password is string {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new AuthError(
      'WEAK_PASSWORD',
      `密码长度必须在 ${MIN_PASSWORD_LENGTH} 到 ${MAX_PASSWORD_LENGTH} 个字符之间`,
    );
  }
}

export async function createAuthService(
  database: Database.Database,
  initialAdminPassword?: string,
): Promise<AuthService> {
  const current = database
    .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
    .get() as PasswordRow | undefined;

  if (!current && initialAdminPassword !== undefined) {
    validatePassword(initialAdminPassword);
    const passwordHash = await hashPassword(initialAdminPassword);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT OR IGNORE INTO admin_credentials
          (id, password_hash, created_at, updated_at)
         VALUES (1, ?, ?, ?)`,
      )
      .run(passwordHash, now, now);
  }

  return new SqliteAuthService(database);
}

class SqliteAuthService implements AuthService {
  constructor(private readonly database: Database.Database) {}

  isConfigured(): boolean {
    const row = this.database
      .prepare('SELECT 1 AS configured FROM admin_credentials WHERE id = 1')
      .get() as { configured: number } | undefined;
    return row?.configured === 1;
  }

  async login(password: string): Promise<string | null> {
    const row = this.database
      .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
      .get() as PasswordRow | undefined;
    if (!row || typeof password !== 'string') {
      return null;
    }

    let valid = false;
    try {
      valid = await argon2.verify(row.password_hash, password);
    } catch {
      valid = false;
    }
    if (!valid) {
      return null;
    }

    this.deleteExpiredSessions();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    this.database
      .prepare(
        `INSERT INTO auth_sessions (token_hash, created_at, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(hashToken(token), now.toISOString(), expiresAt.toISOString());
    return token;
  }

  authenticate(token: string | undefined): boolean {
    if (!token) {
      return false;
    }

    const now = new Date().toISOString();
    this.deleteExpiredSessions(now);
    const row = this.database
      .prepare(
        `SELECT token_hash FROM auth_sessions
         WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(hashToken(token), now) as SessionRow | undefined;
    return row?.token_hash !== undefined;
  }

  logout(token: string | undefined): void {
    if (!token) {
      return;
    }
    this.database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token));
  }

  async changePassword(
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    if (!this.authenticate(token)) {
      return false;
    }

    const row = this.database
      .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
      .get() as PasswordRow | undefined;
    if (!row) {
      return false;
    }

    let currentPasswordMatches = false;
    try {
      currentPasswordMatches = await argon2.verify(row.password_hash, currentPassword);
    } catch {
      currentPasswordMatches = false;
    }
    if (!currentPasswordMatches) {
      return false;
    }

    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE admin_credentials
           SET password_hash = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(passwordHash, now);
      this.database.prepare('DELETE FROM auth_sessions').run();
    })();
    return true;
  }

  revokeAll(): void {
    this.database.prepare('DELETE FROM auth_sessions').run();
  }

  private deleteExpiredSessions(now = new Date().toISOString()): void {
    this.database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  }
}

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
