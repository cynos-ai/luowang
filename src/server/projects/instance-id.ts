import type Database from 'better-sqlite3';

const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readInstanceId(database: Database.Database): string {
  const row = database
    .prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'")
    .get() as { value: string } | undefined;
  if (!row || !INSTANCE_ID.test(row.value)) throw new Error('数据库实例 ID 缺失或无效');
  return row.value;
}
