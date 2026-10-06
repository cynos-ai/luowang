import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type ExecutionResourceState =
  'planned' | 'created' | 'cleanup_pending' | 'unknown' | 'released';
export type ExecutionResourceRecord = {
  resourceId: string;
  projectId: string;
  queueId: number | null;
  attemptId: string;
  runId: string | null;
  executionLocationId: string;
  executionLocationRevision: number;
  resourceType: string;
  externalId: string | null;
  state: ExecutionResourceState;
  occupiesSlot: boolean;
  createdAt: string;
  updatedAt: string;
};

export function createExecutionResourceLedger(
  database: Database.Database,
  instanceId: string,
  now = () => new Date().toISOString(),
) {
  const get = (resourceId: string): ExecutionResourceRecord => {
    const row = database
      .prepare('SELECT * FROM execution_resource_ledger WHERE resource_id = ?')
      .get(resourceId) as LedgerRow | undefined;
    if (!row) throw new Error('执行资源登记不存在');
    return fromRow(row);
  };
  return {
    plan(input: {
      projectId: string;
      queueId?: number | null;
      attemptId: string;
      runId?: string | null;
      executionLocationId: string;
      executionLocationRevision: number;
      resourceType: string;
      ownerLabels: Record<string, string>;
      occupiesSlot?: boolean;
    }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.resourceType) || !input.attemptId)
        throw new Error('执行资源登记参数无效');
      const resourceId = randomUUID();
      const timestamp = now();
      database
        .prepare(
          `INSERT INTO execution_resource_ledger
        (resource_id, instance_id, project_id, queue_id, attempt_id, run_id, execution_location_id, execution_location_revision,
         resource_type, external_id, owner_labels_json, state, occupies_slot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'planned', ?, ?, ?)`,
        )
        .run(
          resourceId,
          instanceId,
          input.projectId,
          input.queueId ?? null,
          input.attemptId,
          input.runId ?? null,
          input.executionLocationId,
          input.executionLocationRevision,
          input.resourceType,
          JSON.stringify(input.ownerLabels),
          input.occupiesSlot === false ? 0 : 1,
          timestamp,
          timestamp,
        );
      return get(resourceId);
    },
    transition(
      resourceId: string,
      from: ExecutionResourceState | ExecutionResourceState[],
      to: ExecutionResourceState,
      externalId?: string | null,
      errorCode?: string | null,
    ) {
      const allowed: Record<ExecutionResourceState, ExecutionResourceState[]> = {
        planned: ['created', 'unknown', 'released'],
        created: ['cleanup_pending', 'unknown', 'released'],
        cleanup_pending: ['unknown', 'released'],
        unknown: ['created', 'cleanup_pending', 'released'],
        released: [],
      };
      const current = get(resourceId);
      const expected = Array.isArray(from) ? from : [from];
      if (!expected.includes(current.state) || !allowed[current.state].includes(to))
        throw new Error('执行资源状态转换无效');
      const result = database
        .prepare(
          `UPDATE execution_resource_ledger SET state = ?, external_id = COALESCE(?, external_id),
        last_error_code = ?, updated_at = ? WHERE resource_id = ? AND state = ?`,
        )
        .run(to, externalId ?? null, errorCode ?? null, now(), resourceId, current.state);
      if (result.changes !== 1) throw new Error('执行资源状态已变化');
      return get(resourceId);
    },
    get,
    unresolved(locationId?: string) {
      const rows = database
        .prepare(
          `SELECT * FROM execution_resource_ledger WHERE state <> 'released'${locationId ? ' AND execution_location_id = ?' : ''} ORDER BY created_at`,
        )
        .all(...(locationId ? [locationId] : [])) as LedgerRow[];
      return rows.map(fromRow);
    },
  };
}

type LedgerRow = {
  resource_id: string;
  project_id: string;
  queue_id: number | null;
  attempt_id: string;
  run_id: string | null;
  execution_location_id: string;
  execution_location_revision: number;
  resource_type: string;
  external_id: string | null;
  state: ExecutionResourceState;
  occupies_slot: number;
  created_at: string;
  updated_at: string;
};
function fromRow(row: LedgerRow): ExecutionResourceRecord {
  return {
    resourceId: row.resource_id,
    projectId: row.project_id,
    queueId: row.queue_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    executionLocationId: row.execution_location_id,
    executionLocationRevision: row.execution_location_revision,
    resourceType: row.resource_type,
    externalId: row.external_id,
    state: row.state,
    occupiesSlot: row.occupies_slot === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
