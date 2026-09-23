import type Database from 'better-sqlite3';

const VERSION = '0014_project_queue_context';

/** Staged offline migration. Queue context is fixed before project scheduling is enabled. */
export function migrateProjectQueueContext(database: Database.Database): boolean {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION)) {
    return false;
  }
  if (
    !database
      .prepare(
        "SELECT 1 FROM schema_migrations WHERE version = '0012_project_configuration_ownership'",
      )
      .get()
  ) {
    throw new Error('项目配置迁移必须先于队列上下文');
  }
  database.transaction(() => {
    database.exec(`
      ALTER TABLE test_request_queue ADD COLUMN config_revision INTEGER;
      ALTER TABLE test_request_queue ADD COLUMN github_repository_id TEXT;
      ALTER TABLE test_request_queue ADD COLUMN config_snapshot_json TEXT;
    `);
    database.exec(`
      UPDATE test_request_queue
      SET config_revision = (SELECT config_revision FROM projects WHERE project_id = test_request_queue.project_id),
          github_repository_id = (SELECT github_repository_id FROM projects WHERE project_id = test_request_queue.project_id),
          config_snapshot_json = (SELECT value FROM project_config WHERE project_id = test_request_queue.project_id);
    `);
    const incomplete = database
      .prepare(
        `SELECT count(*) AS count FROM test_request_queue
         WHERE project_id IS NULL OR config_revision IS NULL OR github_repository_id IS NULL
            OR config_snapshot_json IS NULL OR NOT json_valid(config_snapshot_json)`,
      )
      .get() as { count: number };
    if (incomplete.count > 0) throw new Error('旧队列上下文无法完整归属项目');
    database.exec(`
      CREATE TRIGGER test_request_queue_context_insert
      BEFORE INSERT ON test_request_queue
      WHEN NEW.config_revision IS NULL OR NEW.config_revision < 1
        OR NEW.github_repository_id IS NULL OR NEW.config_snapshot_json IS NULL
        OR NOT json_valid(NEW.config_snapshot_json)
        OR NOT EXISTS (
          SELECT 1 FROM projects
          WHERE project_id = NEW.project_id
            AND github_repository_id = NEW.github_repository_id
            AND config_revision = NEW.config_revision
        )
      BEGIN SELECT RAISE(ABORT, 'project queue context required'); END;

      CREATE TRIGGER test_request_queue_context_update
      BEFORE UPDATE OF project_id, config_revision, github_repository_id, config_snapshot_json
      ON test_request_queue
      WHEN NEW.project_id IS NOT OLD.project_id
        OR NEW.config_revision IS NOT OLD.config_revision
        OR NEW.github_repository_id IS NOT OLD.github_repository_id
        OR NEW.config_snapshot_json IS NOT OLD.config_snapshot_json
      BEGIN SELECT RAISE(ABORT, 'project queue context is immutable'); END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, new Date().toISOString());
  })();
  return true;
}
