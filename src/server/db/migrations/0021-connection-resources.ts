import type Database from 'better-sqlite3';

import { migrateRunTelemetry } from './0020-run-telemetry.js';

export const CONNECTION_RESOURCES_VERSION = '0021_connection_resources';

export function migrateConnectionResources(database: Database.Database): void {
  migrateRunTelemetry(database);
  if (
    database
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(CONNECTION_RESOURCES_VERSION)
  )
    return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE github_credentials (
        credential_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE execution_servers (
        server_id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private-key')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_resource_bindings (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        github_credential_id TEXT REFERENCES github_credentials(credential_id) ON DELETE RESTRICT,
        execution_server_id TEXT REFERENCES execution_servers(server_id) ON DELETE RESTRICT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX project_resource_bindings_github_idx
        ON project_resource_bindings(github_credential_id);
      CREATE INDEX project_resource_bindings_server_idx
        ON project_resource_bindings(execution_server_id);
      CREATE TABLE project_managed_files (
        file_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );
      CREATE INDEX project_managed_files_project_idx
        ON project_managed_files(project_id);
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(CONNECTION_RESOURCES_VERSION, new Date().toISOString());
  })();
}
