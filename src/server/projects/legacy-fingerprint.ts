import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

/** Logical SQLite snapshot digest for comparing a stopped instance with its offline backup. */
export function fingerprintLegacyDatabase(database: Database.Database): string {
  const objects = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const hash = createHash('sha256');
  for (const object of objects) {
    const rows =
      object.type === 'table'
        ? database
            .prepare(`SELECT * FROM "${object.name.replaceAll('"', '""')}" ORDER BY rowid`)
            .all()
        : null;
    hash.update(JSON.stringify([object.type, object.name, object.sql, rows]));
  }
  return hash.digest('hex');
}
