import type Database from 'better-sqlite3';

import type { Migration } from './0000-foundation.js';

const LEGACY_TARGET_ERROR =
  '旧请求包含任意 target，未自动升级为 merge 授权；请通过 merge-source 入口重新提交';
const MISSING_ARCHIVE_RUN_ERROR = '等待归档的旧队列请求缺少 Run ID，未重新调度';

export const closureMergeQueueMigration: Migration = {
  version: '0006_closure_merge_queue',
  apply(database: Database.Database) {
    addColumn(database, 'test_request_queue', 'request_kind', 'TEXT');
    addColumn(database, 'test_request_queue', 'source_ref', 'TEXT');
    addColumn(database, 'test_request_queue', 'prepared_merge_commit', 'TEXT');
    addColumn(database, 'test_request_queue', 'prepared_merge_mode', 'TEXT');
    addColumn(database, 'test_request_queue', 'resolved_target_commit', 'TEXT');

    database
      .prepare(
        `UPDATE test_request_queue
         SET request_kind = CASE
           WHEN trigger IN ('git', 'schedule') THEN 'automatic-head'
           ELSE 'manual-current-head'
         END
         WHERE request_kind IS NULL`,
      )
      .run();

    database
      .prepare(
        `UPDATE test_request_queue
         SET resolved_target_commit = COALESCE(
           (SELECT target_commit FROM run_store_runs WHERE run_store_runs.run_id = test_request_queue.run_id),
           (SELECT target_commit FROM interrupted_run_records WHERE interrupted_run_records.run_id = test_request_queue.run_id)
         )
         WHERE run_id IS NOT NULL AND resolved_target_commit IS NULL`,
      )
      .run();

    database
      .prepare(
        `UPDATE test_request_queue
         SET status = 'failed', completed_at = COALESCE(completed_at, updated_at), error_message = ?
         WHERE status = 'waiting_archive' AND run_id IS NULL`,
      )
      .run(MISSING_ARCHIVE_RUN_ERROR);

    database
      .prepare(
        `UPDATE test_request_queue
         SET status = 'failed', completed_at = COALESCE(completed_at, updated_at), error_message = ?
         WHERE status IN ('queued', 'running')
           AND run_id IS NULL
           AND trigger IN ('manual', 'api')
           AND target_ref IS NOT NULL`,
      )
      .run(LEGACY_TARGET_ERROR);

    database.exec(`
      UPDATE test_request_queue
      SET status = 'queued', claimed_at = NULL
      WHERE status = 'running'
        AND run_id IS NULL
        AND NOT (trigger IN ('manual', 'api') AND target_ref IS NOT NULL);
    `);
  },
};

function addColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
