import type Database from 'better-sqlite3';

export interface AutomationStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function createAutomationStateStore(
  database: Database.Database,
  options: { now?: () => string } = {},
): AutomationStateStore {
  return new SqliteAutomationStateStore(database, options.now ?? (() => new Date().toISOString()));
}

class SqliteAutomationStateStore implements AutomationStateStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
  ) {}

  get(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM automation_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO automation_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.now());
  }

  delete(key: string): void {
    this.database.prepare('DELETE FROM automation_state WHERE key = ?').run(key);
  }
}
