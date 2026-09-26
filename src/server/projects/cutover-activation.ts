import type Database from 'better-sqlite3';

const CUTOVER_KEY = 'v061_legacy_cutover_project_id';
const ACTIVATED_KEY = 'v061_legacy_project_activated';

/** An offline upgrade needs one explicit resume before background work may start. */
export function awaitsCutoverActivation(database: Database.Database, projectId: string): boolean {
  const cutover = database
    .prepare('SELECT value FROM system_metadata WHERE key = ?')
    .get(CUTOVER_KEY) as { value: string } | undefined;
  if (cutover?.value !== projectId) return false;
  const activated = database
    .prepare('SELECT value FROM system_metadata WHERE key = ?')
    .get(ACTIVATED_KEY) as { value: string } | undefined;
  return activated?.value !== projectId;
}

/** Called in the same transaction as a successful readiness-checked resume. */
export function activateCutoverProject(
  database: Database.Database,
  projectId: string,
  at: string,
): void {
  if (!awaitsCutoverActivation(database, projectId)) return;
  database
    .prepare(
      `INSERT INTO system_metadata (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(ACTIVATED_KEY, projectId, at, at);
}
