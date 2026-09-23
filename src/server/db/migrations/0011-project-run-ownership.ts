import type Database from 'better-sqlite3';

const VERSION = '0011_project_run_ownership';
const OWNER_KEY = 'legacy_run_owner_project_id';

/** Staged offline migration. The final cutover must wrap this and the index migration together. */
export function migrateLegacyRunOwnership(
  database: Database.Database,
  legacyProjectId: string,
): boolean {
  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(VERSION);
  if (applied) {
    const owner = database
      .prepare('SELECT value FROM system_metadata WHERE key = ?')
      .get(OWNER_KEY) as { value: string } | undefined;
    if (owner?.value !== legacyProjectId) throw new Error('旧 Run 迁移归属与已有记录不一致');
    return false;
  }
  if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(legacyProjectId)) {
    throw new Error('旧 Run 迁移的项目不存在');
  }
  database.transaction(() => {
    database.exec(`
      ALTER TABLE run_store_runs
        ADD COLUMN project_id TEXT REFERENCES projects(project_id);
      ALTER TABLE test_request_queue
        ADD COLUMN project_id TEXT REFERENCES projects(project_id);
      ALTER TABLE interrupted_run_records
        ADD COLUMN project_id TEXT REFERENCES projects(project_id);
    `);
    for (const table of [
      'run_store_runs',
      'test_request_queue',
      'interrupted_run_records',
    ] as const) {
      database.prepare(`UPDATE ${table} SET project_id = ?`).run(legacyProjectId);
      // SQLite cannot add a dynamic NOT NULL default to populated tables.
      // These triggers require a valid owner and prevent later reassignment.
      database.exec(`
        CREATE TRIGGER ${table}_project_insert
        BEFORE INSERT ON ${table}
        WHEN NEW.project_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM projects WHERE project_id = NEW.project_id)
        BEGIN SELECT RAISE(ABORT, 'project owner required'); END;

        CREATE TRIGGER ${table}_project_update
        BEFORE UPDATE OF project_id ON ${table}
        WHEN NEW.project_id IS NOT OLD.project_id
        BEGIN SELECT RAISE(ABORT, 'project owner is immutable'); END;
      `);
      database.exec(`CREATE INDEX ${table}_project_idx ON ${table} (project_id)`);
    }

    database.exec(`
      CREATE TABLE run_store_progress_v061 (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(project_id),
        last_completed_target TEXT,
        run_id TEXT,
        updated_at TEXT
      );
    `);
    database
      .prepare(
        `INSERT INTO run_store_progress_v061
           (project_id, last_completed_target, run_id, updated_at)
         SELECT ?, last_completed_target, run_id, updated_at
         FROM run_store_progress`,
      )
      .run(legacyProjectId);
    database.exec(`
      DROP TABLE run_store_progress;
      ALTER TABLE run_store_progress_v061 RENAME TO run_store_progress;
    `);

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO system_metadata (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(OWNER_KEY, legacyProjectId, now, now);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, now);
  })();
  return true;
}
