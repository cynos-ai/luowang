import type Database from 'better-sqlite3';

const VERSION = '0015_project_image_state';

/** Staged with the v0.6.1 offline cutover; never run on the old runtime alone. */
export function migrateProjectImageState(database: Database.Database): void {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION)) return;
  if (
    !database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0009_project_identity'")
      .get()
  ) {
    throw new Error('项目身份迁移尚未完成');
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE project_execution_images (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        target_commit TEXT NOT NULL,
        dockerfile_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
        image_id TEXT,
        failure_code TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, target_commit, dockerfile_path),
        CHECK ((status = 'ready' AND image_id IS NOT NULL AND failure_code IS NULL)
          OR (status = 'failed' AND image_id IS NULL AND failure_code IS NOT NULL)
          OR (status = 'preparing' AND image_id IS NULL AND failure_code IS NULL))
      );
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, new Date().toISOString());
  })();
}
