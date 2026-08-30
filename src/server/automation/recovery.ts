import type Database from 'better-sqlite3';

import type { RunSummary } from '../../shared/types.js';

export interface InterruptedRunRecord extends RunSummary {
  status: 'interrupted';
  phase: 'interrupted';
  interruptedAt: string;
  runningDirectory: string | null;
}

export interface RunRecoveryStore {
  record(
    run: RunSummary,
    options?: { interruptedAt?: string; runningDirectory?: string | null },
  ): void;
  get(runId: string): InterruptedRunRecord | null;
  list(): InterruptedRunRecord[];
  remove(runId: string): void;
}

export function createRunRecoveryStore(
  database: Database.Database,
  options: { now?: () => string } = {},
): RunRecoveryStore {
  return new SqliteRunRecoveryStore(database, options.now ?? (() => new Date().toISOString()));
}

class SqliteRunRecoveryStore implements RunRecoveryStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
  ) {}

  record(
    run: RunSummary,
    options: { interruptedAt?: string; runningDirectory?: string | null } = {},
  ): void {
    if (run.status !== 'interrupted') return;
    const timestamp = options.interruptedAt ?? this.now();
    const runningDirectory = options.runningDirectory ?? null;
    this.database
      .prepare(
        `INSERT INTO interrupted_run_records
         (run_id, trigger, request, base_commit, target_commit, included_commits_json,
          started_at, interrupted_at, running_directory, artifact_names_json, error_message,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           trigger = excluded.trigger,
           request = excluded.request,
           base_commit = excluded.base_commit,
           target_commit = excluded.target_commit,
           included_commits_json = excluded.included_commits_json,
           interrupted_at = excluded.interrupted_at,
           running_directory = excluded.running_directory,
           artifact_names_json = excluded.artifact_names_json,
           error_message = excluded.error_message,
           updated_at = excluded.updated_at`,
      )
      .run(
        run.runId,
        run.trigger,
        run.request,
        run.baseCommit,
        run.targetCommit,
        JSON.stringify(run.includedCommits),
        run.startedAt,
        timestamp,
        runningDirectory,
        JSON.stringify(run.artifactNames),
        run.errorMessage ?? '进程重启时 Run 尚在 running 目录，未恢复 Agent 会话',
        timestamp,
        timestamp,
      );
  }

  get(runId: string): InterruptedRunRecord | null {
    const row = this.database
      .prepare('SELECT * FROM interrupted_run_records WHERE run_id = ?')
      .get(runId) as RecoveryRow | undefined;
    return row ? toInterruptedRun(row) : null;
  }

  list(): InterruptedRunRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM interrupted_run_records ORDER BY interrupted_at DESC, run_id DESC')
        .all() as RecoveryRow[]
    ).map(toInterruptedRun);
  }

  remove(runId: string): void {
    this.database.prepare('DELETE FROM interrupted_run_records WHERE run_id = ?').run(runId);
  }
}

interface RecoveryRow {
  run_id: string;
  trigger: string;
  request: string;
  base_commit: string | null;
  target_commit: string | null;
  included_commits_json: string;
  started_at: string;
  interrupted_at: string;
  running_directory: string | null;
  artifact_names_json: string;
  error_message: string;
}

function toInterruptedRun(row: RecoveryRow): InterruptedRunRecord {
  return {
    runId: row.run_id,
    status: 'interrupted',
    phase: 'interrupted',
    result: null,
    trigger: row.trigger as RunSummary['trigger'],
    request: row.request,
    baseCommit: row.base_commit,
    targetCommit: row.target_commit,
    includedCommits: parseJson(row.included_commits_json, []),
    startedAt: row.started_at,
    finishedAt: row.interrupted_at,
    errorMessage: row.error_message,
    artifactNames: parseJson(row.artifact_names_json, []),
    runningDirectory: row.running_directory,
    interruptedAt: row.interrupted_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
