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
  return new SqliteAutomationStateStore(
    database,
    options.now ?? (() => new Date().toISOString()),
    null,
  );
}

export function createProjectAutomationStateStore(
  database: Database.Database,
  projectId: string,
  options: { now?: () => string } = {},
): AutomationStateStore {
  if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
    throw new Error('自动化状态项目不存在');
  }
  return new SqliteAutomationStateStore(
    database,
    options.now ?? (() => new Date().toISOString()),
    projectId,
  );
}

class SqliteAutomationStateStore implements AutomationStateStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
    private readonly projectId: string | null,
  ) {}

  get(key: string): string | null {
    const row = this.database
      .prepare(
        `SELECT value FROM ${this.projectId === null ? 'automation_state WHERE key = ?' : 'project_automation_state WHERE project_id = ? AND key = ?'}`,
      )
      .get(...(this.projectId === null ? [key] : [this.projectId, key])) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO ${this.projectId === null ? 'automation_state (key, value, updated_at)' : 'project_automation_state (project_id, key, value, updated_at)'}
         VALUES (${this.projectId === null ? '' : '?, '}?, ?, ?)
         ON CONFLICT(${this.projectId === null ? 'key' : 'project_id, key'}) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(...(this.projectId === null ? [] : [this.projectId]), key, value, this.now());
  }

  delete(key: string): void {
    this.database
      .prepare(
        `DELETE FROM ${this.projectId === null ? 'automation_state WHERE key = ?' : 'project_automation_state WHERE project_id = ? AND key = ?'}`,
      )
      .run(...(this.projectId === null ? [key] : [this.projectId, key]));
  }
}
