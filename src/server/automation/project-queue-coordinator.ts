import type Database from 'better-sqlite3';

import {
  configureProjectQueueConcurrency,
  createProjectTestRequestQueue,
  type TestRequestRecord,
} from './queue.js';

const CURSOR_KEY = 'last_scheduled_project_id';

/** Bounded execution slots with a persisted round-robin cursor across active projects. */
export function createProjectQueueCoordinator(
  database: Database.Database,
  maxConcurrentProjects = 2,
): {
  claimNext(): TestRequestRecord | null;
  setLimit(limit: number): void;
} {
  let currentLimit = maxConcurrentProjects;
  configureProjectQueueConcurrency(database, maxConcurrentProjects);
  return {
    claimNext() {
      return database.transaction(() => {
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
                     WHERE q.project_id = p.project_id AND q.status IN ('running', 'waiting_archive')
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
          const runtimeSchema = Boolean(
            database
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_ledger'",
              )
              .get(),
          );
          if (runtimeSchema) {
            const candidate = database
              .prepare(
                `SELECT execution_location_id AS locationId, execution_location_revision AS revision
              FROM test_request_queue WHERE project_id = ? AND status = 'queued' ORDER BY queue_id LIMIT 1`,
              )
              .get(projectId) as { locationId: string | null; revision: number | null } | undefined;
            if (
              !candidate?.locationId ||
              !candidate.revision ||
              !locationHasCapacity(database, candidate.locationId, candidate.revision, currentLimit)
            )
              continue;
          }
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
    setLimit(limit) {
      configureProjectQueueConcurrency(database, limit);
      currentLimit = limit;
    },
  };
}

export function locationHasCapacity(
  database: Database.Database,
  locationId: string,
  revision: number,
  globalLimit: number,
): boolean {
  const running = (
    database
      .prepare("SELECT count(*) AS count FROM test_request_queue WHERE status = 'running'")
      .get() as { count: number }
  ).count;
  const unknown = (
    database
      .prepare(
        `SELECT count(*) AS count FROM execution_resource_ledger l
    WHERE l.occupies_slot = 1 AND l.state <> 'released' AND (l.queue_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM test_request_queue q WHERE q.queue_id = l.queue_id AND q.status = 'running'))`,
      )
      .get() as { count: number }
  ).count;
  if (running + unknown >= globalLimit) return false;
  const local = locationId.startsWith('local:');
  let capacity = globalLimit;
  if (!local) {
    const serverId = locationId.slice('server:'.length);
    const server = database
      .prepare(
        'SELECT revision, capacity, health_status FROM execution_servers WHERE server_id = ?',
      )
      .get(serverId) as { revision: number; capacity: number; health_status: string } | undefined;
    if (!server || server.revision !== revision || server.health_status !== 'ready') return false;
    capacity = server.capacity;
  }
  const active = (
    database
      .prepare(
        "SELECT count(*) AS count FROM test_request_queue WHERE status = 'running' AND execution_location_id = ?",
      )
      .get(locationId) as { count: number }
  ).count;
  const retained = (
    database
      .prepare(
        `SELECT count(*) AS count FROM execution_resource_ledger l WHERE l.execution_location_id = ?
    AND l.occupies_slot = 1 AND l.state <> 'released' AND (l.queue_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM test_request_queue q WHERE q.queue_id = l.queue_id AND q.status = 'running'))`,
      )
      .get(locationId) as { count: number }
  ).count;
  return active + retained < capacity;
}
