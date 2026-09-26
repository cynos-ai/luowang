import type Database from 'better-sqlite3';

import { createProjectTestRequestQueue, type TestRequestRecord } from './queue.js';

const CURSOR_KEY = 'last_scheduled_project_id';

/** One global execution slot with a persisted round-robin cursor across active projects. */
export function createProjectQueueCoordinator(database: Database.Database): {
  claimNext(): TestRequestRecord | null;
} {
  return {
    claimNext() {
      return database.transaction(() => {
        if (
          database
            .prepare("SELECT 1 FROM test_request_queue WHERE status = 'running' LIMIT 1")
            .get()
        ) {
          return null;
        }
        const allProjects = database
          .prepare('SELECT project_id FROM projects ORDER BY created_at, project_id')
          .all() as Array<{ project_id: string }>;
        const eligible = new Set(
          (
            database
              .prepare(
                `SELECT p.project_id FROM projects p
                 WHERE p.status = 'active'
                   AND EXISTS (
                     SELECT 1 FROM test_request_queue q
                     WHERE q.project_id = p.project_id AND q.status = 'queued'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM test_request_queue q
                     WHERE q.project_id = p.project_id AND q.status = 'waiting_archive'
                   )`,
              )
              .all() as Array<{ project_id: string }>
          ).map((row) => row.project_id),
        );
        if (eligible.size === 0) return null;
        const last = database
          .prepare('SELECT value FROM system_metadata WHERE key = ?')
          .get(CURSOR_KEY) as { value: string } | undefined;
        const previousIndex = allProjects.findIndex((item) => item.project_id === last?.value);
        for (let offset = 1; offset <= allProjects.length; offset += 1) {
          const index = (previousIndex + offset) % allProjects.length;
          const projectId = allProjects[index].project_id;
          if (!eligible.has(projectId)) continue;
          const claimed = createProjectTestRequestQueue(database, projectId).claimNext();
          if (!claimed) continue;
          const now = new Date().toISOString();
          database
            .prepare(
              `INSERT INTO system_metadata (key, value, created_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(CURSOR_KEY, projectId, now, now);
          return claimed;
        }
        return null;
      })();
    },
  };
}
