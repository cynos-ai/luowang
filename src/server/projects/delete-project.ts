import type Database from 'better-sqlite3';

import { AppError } from '../errors.js';

/** Remove console data only. External Git, storage and Docker assets are not deleted here. */
export function deleteProject(database: Database.Database, projectId: string): void {
  database.transaction(() => {
    if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在', 404);
    }
    const pending = database
      .prepare(
        `SELECT 1 FROM test_request_queue
         WHERE project_id = ? AND (
           status IN ('queued', 'running', 'waiting_archive')
           OR (status = 'completed' AND archive_status IN ('failed', 'partial'))
         ) LIMIT 1`,
      )
      .get(projectId);
    if (pending) {
      throw new AppError(
        'PROJECT_DELETE_CONFLICT',
        '项目仍有待处理任务，请先停止测试并完成归档',
        409,
      );
    }
    if (
      database
        .prepare(
          `SELECT 1 FROM execution_resource_ledger
           WHERE project_id = ? AND state <> 'released' LIMIT 1`,
        )
        .get(projectId) ||
      database
        .prepare(
          `SELECT 1 FROM execution_image_cache
           WHERE project_id = ? AND status = 'preparing' LIMIT 1`,
        )
        .get(projectId) ||
      database
        .prepare(
          `SELECT 1 FROM project_execution_images
           WHERE project_id = ? AND status = 'preparing' LIMIT 1`,
        )
        .get(projectId) ||
      database.prepare('SELECT 1 FROM active_run_snapshots WHERE project_id = ?').get(projectId)
    ) {
      throw new AppError(
        'PROJECT_DELETE_CONFLICT',
        '项目仍在准备或有未回收的运行资源，请稍后重试',
        409,
      );
    }

    // Secrets have explicit scope keys rather than foreign keys. Shared connection credentials stay.
    database
      .prepare(
        `DELETE FROM secret_entries WHERE key IN (
           SELECT 'resource:project-file:' || file_id || ':content'
           FROM project_managed_files WHERE project_id = ?
         )`,
      )
      .run(projectId);
    const prefix = `project:${projectId}:`;
    database
      .prepare('DELETE FROM secret_entries WHERE substr(key, 1, length(?)) = ?')
      .run(prefix, prefix);

    // Child tables precede their parents; Run artifacts and Issue cache cascade with Run rows.
    for (const table of [
      'execution_resource_ledger',
      'run_execution_context',
      'active_run_snapshots',
      'project_run_images',
      'project_execution_images',
      'execution_image_cache',
      'project_managed_files',
      'project_resource_bindings',
      'run_store_progress',
      'run_store_runs',
      'interrupted_run_records',
      'test_request_queue',
      'indexed_reports',
      'indexed_scenarios',
      'repository_index_errors',
      'repository_index_state',
      'project_connectivity_check_results',
      'project_automation_state',
      'project_config',
    ]) {
      database.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    }
    database.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);
  })();
}
