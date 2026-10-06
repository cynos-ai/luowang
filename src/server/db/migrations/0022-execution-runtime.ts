import type Database from 'better-sqlite3';

import { migrateConnectionResources } from './0021-connection-resources.js';

export const EXECUTION_RUNTIME_VERSION = '0022_execution_runtime';

/** Offline schema change. 0021 is immutable; this migration only adds new facts. */
export function migrateExecutionRuntime(database: Database.Database): void {
  migrateConnectionResources(database);
  if (
    database
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(EXECUTION_RUNTIME_VERSION)
  )
    return;

  database.transaction(() => {
    database.exec(`
      ALTER TABLE execution_servers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE execution_servers ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 64);
      ALTER TABLE execution_servers ADD COLUMN host_fingerprint TEXT;
      ALTER TABLE execution_servers ADD COLUMN fingerprint_confirmed_at TEXT;
      ALTER TABLE execution_servers ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (health_status IN ('unverified', 'ready', 'unavailable', 'changed'));
      ALTER TABLE execution_servers ADD COLUMN capabilities_json TEXT;
      ALTER TABLE execution_servers ADD COLUMN checked_at TEXT;

      ALTER TABLE project_managed_files ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE project_managed_files ADD COLUMN service_name TEXT;

      ALTER TABLE test_request_queue ADD COLUMN execution_location_id TEXT;
      ALTER TABLE test_request_queue ADD COLUMN execution_location_revision INTEGER;
      ALTER TABLE test_request_queue ADD COLUMN managed_files_snapshot_json TEXT;

      CREATE TABLE execution_image_cache (
        execution_location_id TEXT NOT NULL,
        execution_location_revision INTEGER NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        target_commit TEXT NOT NULL,
        build_definition_hash TEXT NOT NULL,
        platform TEXT NOT NULL,
        image_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
        failure_code TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (execution_location_id, execution_location_revision, project_id,
                     target_commit, build_definition_hash, platform)
      );

      CREATE TABLE execution_resource_ledger (
        resource_id TEXT PRIMARY KEY NOT NULL,
        instance_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        queue_id INTEGER REFERENCES test_request_queue(queue_id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL,
        run_id TEXT,
        execution_location_id TEXT NOT NULL,
        execution_location_revision INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        external_id TEXT,
        owner_labels_json TEXT NOT NULL CHECK (json_valid(owner_labels_json)),
        state TEXT NOT NULL CHECK (state IN ('planned', 'created', 'cleanup_pending', 'unknown', 'released')),
        occupies_slot INTEGER NOT NULL DEFAULT 1 CHECK (occupies_slot IN (0, 1)),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX execution_resource_location_state_idx
        ON execution_resource_ledger(execution_location_id, state, occupies_slot);
      CREATE INDEX execution_resource_project_state_idx
        ON execution_resource_ledger(project_id, state, occupies_slot);

      CREATE TABLE execution_location_checks (
        execution_location_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unverified', 'ready', 'unavailable', 'changed')),
        capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
        checked_at TEXT NOT NULL
      );
      CREATE TABLE run_execution_context (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        execution_location_id TEXT NOT NULL,
        execution_location_revision INTEGER NOT NULL,
        config_revision INTEGER NOT NULL,
        target_commit TEXT NOT NULL,
        start_type TEXT NOT NULL CHECK (start_type IN ('single-container','compose')),
        build_definition_hash TEXT NOT NULL,
        image_id TEXT,
        scenario_patch_sha256 TEXT,
        runtime_environment_json TEXT,
        cleanup_state TEXT NOT NULL DEFAULT 'planned' CHECK (cleanup_state IN ('planned','created','cleanup_pending','unknown','released')),
        recorded_at TEXT NOT NULL
      );
    `);

    const rows = database.prepare('SELECT project_id, value FROM project_config').all() as Array<{
      project_id: string;
      value: string;
    }>;
    const update = database.prepare('UPDATE project_config SET value = ? WHERE project_id = ?');
    for (const row of rows) {
      const value = JSON.parse(row.value) as Record<string, unknown>;
      if (value.runtimeMode === undefined) value.runtimeMode = 'external';
      if (value.startType === undefined) value.startType = 'single-container';
      update.run(JSON.stringify(value), row.project_id);
    }

    // Preserve already queued work as the historical local/external execution contract.
    // New queue rows receive the same facts from queue.ts at enqueue time.
    database.exec(`
      DROP TRIGGER test_request_queue_context_update;

      UPDATE test_request_queue
      SET execution_location_id = 'local:' || (
            SELECT value FROM system_metadata WHERE key = 'instance_id'
          ),
          execution_location_revision = 1,
          managed_files_snapshot_json = '[]',
          config_snapshot_json = json_set(
            json_set(config_snapshot_json, '$.runtimeMode', 'external'),
            '$.startType', COALESCE(json_extract(config_snapshot_json, '$.startType'), 'single-container')
          )
      WHERE project_id IS NOT NULL;

      CREATE TRIGGER test_request_queue_context_update
      BEFORE UPDATE OF project_id, config_revision, github_repository_id, config_snapshot_json
      ON test_request_queue
      WHEN NEW.project_id IS NOT OLD.project_id
        OR NEW.config_revision IS NOT OLD.config_revision
        OR NEW.github_repository_id IS NOT OLD.github_repository_id
        OR NEW.config_snapshot_json IS NOT OLD.config_snapshot_json
      BEGIN SELECT RAISE(ABORT, 'project queue context is immutable'); END;

      CREATE TRIGGER test_request_queue_runtime_context_insert
      BEFORE INSERT ON test_request_queue
      WHEN NEW.project_id IS NOT NULL AND (
        NEW.execution_location_id IS NULL
        OR NEW.execution_location_revision IS NULL
        OR NEW.execution_location_revision < 1
        OR NEW.managed_files_snapshot_json IS NULL
        OR NOT json_valid(NEW.managed_files_snapshot_json)
      )
      BEGIN SELECT RAISE(ABORT, 'execution runtime queue context required'); END;

      CREATE TRIGGER test_request_queue_runtime_context_update
      BEFORE UPDATE OF execution_location_id, execution_location_revision, managed_files_snapshot_json
      ON test_request_queue
      WHEN NEW.execution_location_id IS NOT OLD.execution_location_id
        OR NEW.execution_location_revision IS NOT OLD.execution_location_revision
        OR NEW.managed_files_snapshot_json IS NOT OLD.managed_files_snapshot_json
      BEGIN SELECT RAISE(ABORT, 'execution runtime queue context is immutable'); END;
    `);

    const incompleteQueue = database
      .prepare(
        `
      SELECT count(*) AS count FROM test_request_queue
      WHERE project_id IS NOT NULL AND (
        execution_location_id IS NULL
        OR execution_location_revision IS NULL
        OR managed_files_snapshot_json IS NULL
        OR NOT json_valid(managed_files_snapshot_json)
      )
    `,
      )
      .get() as { count: number };
    if (incompleteQueue.count > 0) throw new Error('旧队列执行上下文无法完整迁移');

    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(EXECUTION_RUNTIME_VERSION, new Date().toISOString());
  })();
}
