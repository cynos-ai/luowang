import type Database from 'better-sqlite3';

const VERSION = '0016_project_run_image';

/** The image recorded here is the one whose Run container actually started. */
export function migrateProjectRunImage(database: Database.Database): void {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION)) return;
  if (
    !database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0015_project_image_state'")
      .get()
  ) {
    throw new Error('项目镜像状态迁移尚未完成');
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE project_run_images (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        target_commit TEXT NOT NULL,
        dockerfile_path TEXT NOT NULL,
        image_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (project_id, target_commit, dockerfile_path)
          REFERENCES project_execution_images(project_id, target_commit, dockerfile_path)
      );
      CREATE INDEX project_run_images_project_idx ON project_run_images(project_id);
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, new Date().toISOString());
  })();
}
