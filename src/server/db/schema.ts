import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const systemMetadata = sqliteTable('system_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const adminCredentials = sqliteTable('admin_credentials', {
  id: integer('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const appConfig = sqliteTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const secretEntries = sqliteTable('secret_entries', {
  key: text('key').primaryKey(),
  nonce: text('nonce').notNull(),
  ciphertext: text('ciphertext').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const connectivityCheckResults = sqliteTable('connectivity_check_results', {
  checkId: text('check_id').primaryKey(),
  status: text('status').notNull(),
  message: text('message').notNull(),
  checkedAt: text('checked_at').notNull(),
  latencyMs: integer('latency_ms'),
});
