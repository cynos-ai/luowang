import type Database from 'better-sqlite3';
import { readInstanceId } from './instance-id.js';

export type ExecutionLocation = {
  id: string;
  revision: number;
  kind: 'local' | 'ssh';
  serverId: string | null;
  capacity: number;
  healthStatus: 'unverified' | 'ready' | 'unavailable' | 'changed';
};

export function resolveProjectExecutionLocation(
  database: Database.Database,
  projectId: string,
): ExecutionLocation {
  const row = database
    .prepare(
      `SELECT s.server_id, s.revision, s.capacity, s.health_status
    FROM project_resource_bindings b LEFT JOIN execution_servers s ON s.server_id = b.execution_server_id
    WHERE b.project_id = ?`,
    )
    .get(projectId) as
    | {
        server_id: string | null;
        revision: number | null;
        capacity: number | null;
        health_status: ExecutionLocation['healthStatus'] | null;
      }
    | undefined;
  if (!row?.server_id) {
    const configured = database
      .prepare("SELECT value FROM system_metadata WHERE key = 'runtime_max_concurrent_projects'")
      .get() as { value: string } | undefined;
    const capacity = Number(configured?.value ?? 2);
    return {
      id: `local:${readInstanceId(database)}`,
      revision: 1,
      kind: 'local',
      serverId: null,
      capacity: Number.isInteger(capacity) ? capacity : 2,
      healthStatus: 'ready',
    };
  }
  return {
    id: `server:${row.server_id}`,
    revision: row.revision!,
    kind: 'ssh',
    serverId: row.server_id,
    capacity: row.capacity!,
    healthStatus: row.health_status!,
  };
}

export function parseExecutionLocationId(value: string): {
  kind: 'local' | 'ssh';
  identity: string;
} {
  const match = /^(local|server):([0-9a-f-]{36})$/i.exec(value);
  if (!match) throw new Error('执行位置身份无效');
  return { kind: match[1] === 'local' ? 'local' : 'ssh', identity: match[2].toLowerCase() };
}
