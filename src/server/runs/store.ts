import type Database from 'better-sqlite3';

import type {
  ConfirmedBugSummary,
  RunResult,
  RunTrigger,
  ScenarioResultSummary,
} from '../../shared/types.js';
import { RUN_ARTIFACT_NAMES, type RunArtifactName } from './types.js';

export type StoredReportStatus = 'pending' | 'published' | 'not_applicable' | 'conflict' | 'failed';
export type StoredIssueStatus = 'pending' | 'succeeded' | 'failed';
export type StoredArchiveStatus = 'pending' | 'partial' | 'completed' | 'failed';

export interface CompletedRunImport {
  runId: string;
  trigger: RunTrigger;
  request?: string;
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  result: RunResult;
  startedAt: string;
  finishedAt: string;
  completedDirectory: string;
  reportPath?: string;
  artifacts: Partial<Record<RunArtifactName, string>>;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
  specialRun?: boolean;
}

export interface StoredRunIssue {
  runId: string;
  bugKey: string;
  title: string;
  scenarioIds: string[];
  issueAction: 'create' | 'link';
  requestedIssueUrl: string | null;
  status: StoredIssueStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRun {
  runId: string;
  status: 'completed';
  trigger: RunTrigger;
  request: string;
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  result: RunResult;
  startedAt: string;
  finishedAt: string;
  completedDirectory: string;
  reportPath: string;
  reportStatus: StoredReportStatus;
  reportCommitSha: string | null;
  archiveStatus: StoredArchiveStatus;
  archiveError: string | null;
  progressed: boolean;
  progressedAt: string | null;
  artifacts: Partial<Record<RunArtifactName, string>>;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
  issues: StoredRunIssue[];
  specialRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReportPublicationUpdate {
  status: StoredReportStatus;
  commitSha?: string | null;
  errorMessage?: string | null;
}

export interface IssueAttemptUpdate {
  status: StoredIssueStatus;
  issueNumber?: number | null;
  issueUrl?: string | null;
  errorMessage?: string | null;
}

export interface ArchiveCompletion {
  reportReady: boolean;
  errorMessage?: string | null;
}

export interface RunStore {
  importCompleted(input: CompletedRunImport): StoredRun;
  get(runId: string): StoredRun | null;
  list(): StoredRun[];
  listPending(): StoredRun[];
  getLastCompletedTarget(): string | null;
  markReport(runId: string, update: ReportPublicationUpdate): StoredRun;
  markIssueAttempt(runId: string, bugKey: string, update: IssueAttemptUpdate): StoredRun;
  markArchiveFailure(runId: string, message: string): StoredRun;
  completeArchive(runId: string, completion: ArchiveCompletion): StoredRun;
}

export class RunStoreError extends Error {
  readonly code:
    | 'RUN_STORE_INVALID'
    | 'RUN_STORE_NOT_FOUND'
    | 'RUN_STORE_CONFLICT'
    | 'RUN_STORE_ISSUE_NOT_FOUND';

  constructor(code: RunStoreError['code'], message: string) {
    super(message);
    this.name = 'RunStoreError';
    this.code = code;
  }
}

export function createRunStore(
  database: Database.Database,
  options: { now?: () => string } = {},
): RunStore {
  return new SqliteRunStore(database, options.now ?? (() => new Date().toISOString()));
}

class SqliteRunStore implements RunStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => string,
  ) {}

  importCompleted(input: CompletedRunImport): StoredRun {
    assertImport(input);
    const timestamp = this.now();
    this.database.transaction(() => {
      const existing = this.readRunRow(input.runId);
      if (existing) {
        assertSameImmutableRun(existing, input);
        if (existing.request === '' && input.request?.trim()) {
          this.database
            .prepare('UPDATE run_store_runs SET request = ?, updated_at = ? WHERE run_id = ?')
            .run(input.request.trim(), timestamp, input.runId);
        }
        this.assertStoredArtifacts(input.runId, input.artifacts);
        this.ensureIssueRows(input, timestamp);
        return;
      }

      const reportPath = input.reportPath ?? `docs/scenario-testing/reports/${input.runId}`;
      this.database
        .prepare(
          `INSERT INTO run_store_runs
           (run_id, status, trigger, request, base_commit, target_commit, included_commits_json,
            result, scenario_results_json, confirmed_bugs_json, started_at, finished_at,
            completed_directory, report_path, report_status,
            report_commit_sha, archive_status, archive_error, progressed, progressed_at,
            created_at, updated_at)
           VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, 0, NULL, ?, ?)`,
        )
        .run(
          input.runId,
          input.trigger,
          input.request?.trim() ?? '',
          input.baseCommit,
          input.targetCommit,
          JSON.stringify(input.includedCommits),
          input.result,
          JSON.stringify(input.scenarioResults),
          JSON.stringify(input.confirmedBugs),
          input.startedAt,
          input.finishedAt,
          input.completedDirectory,
          reportPath,
          input.specialRun === true ? 'not_applicable' : 'pending',
          timestamp,
          timestamp,
        );
      for (const [name, content] of Object.entries(input.artifacts)) {
        if (content === undefined) continue;
        this.database
          .prepare(
            `INSERT INTO run_store_artifacts (run_id, name, content, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.runId, name, content, timestamp, timestamp);
      }
      this.ensureIssueRows(input, timestamp);
    })();
    const stored = this.get(input.runId);
    if (!stored) throw new RunStoreError('RUN_STORE_NOT_FOUND', 'Run 导入后无法读取');
    return stored;
  }

  get(runId: string): StoredRun | null {
    const row = this.readRunRow(runId);
    if (!row) return null;
    const artifacts = this.database
      .prepare('SELECT name, content FROM run_store_artifacts WHERE run_id = ? ORDER BY name')
      .all(runId) as Array<{ name: string; content: string }>;
    const issues = this.database
      .prepare(
        `SELECT run_id, bug_key, title, scenario_ids_json, issue_action, requested_issue_url,
                status, issue_number, issue_url, error_message, attempts, created_at, updated_at
         FROM run_store_issues WHERE run_id = ? ORDER BY bug_key`,
      )
      .all(runId) as IssueRow[];
    return toStoredRun(row, artifacts, issues);
  }

  list(): StoredRun[] {
    const rows = this.database
      .prepare('SELECT * FROM run_store_runs ORDER BY finished_at DESC, run_id DESC')
      .all() as RunRow[];
    return rows.map((row) => this.requireStoredRun(row.run_id));
  }

  listPending(): StoredRun[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM run_store_runs
         WHERE archive_status <> 'completed'
         ORDER BY finished_at ASC, run_id ASC`,
      )
      .all() as RunRow[];
    return rows.map((row) => this.requireStoredRun(row.run_id));
  }

  getLastCompletedTarget(): string | null {
    const row = this.database
      .prepare('SELECT last_completed_target FROM run_store_progress WHERE id = 1')
      .get() as { last_completed_target: string | null } | undefined;
    return row?.last_completed_target ?? null;
  }

  markReport(runId: string, update: ReportPublicationUpdate): StoredRun {
    const timestamp = this.now();
    this.database.transaction(() => {
      this.requireRunRow(runId);
      this.database
        .prepare(
          `UPDATE run_store_runs
           SET report_status = ?, report_commit_sha = ?, archive_error = ?,
               archive_status = CASE WHEN ? IN ('conflict', 'failed') THEN 'failed' ELSE archive_status END,
               updated_at = ?
           WHERE run_id = ?`,
        )
        .run(
          update.status,
          update.commitSha ?? null,
          update.errorMessage ?? null,
          update.status,
          timestamp,
          runId,
        );
    })();
    return this.requireStoredRun(runId);
  }

  markIssueAttempt(runId: string, bugKey: string, update: IssueAttemptUpdate): StoredRun {
    const timestamp = this.now();
    this.database.transaction(() => {
      const issue = this.database
        .prepare('SELECT bug_key FROM run_store_issues WHERE run_id = ? AND bug_key = ?')
        .get(runId, bugKey);
      if (!issue) {
        throw new RunStoreError('RUN_STORE_ISSUE_NOT_FOUND', `Run Issue 记录不存在：${bugKey}`);
      }
      this.database
        .prepare(
          `UPDATE run_store_issues
           SET status = ?, issue_number = ?, issue_url = ?, error_message = ?,
               attempts = attempts + 1, updated_at = ?
           WHERE run_id = ? AND bug_key = ?`,
        )
        .run(
          update.status,
          update.issueNumber ?? null,
          update.issueUrl ?? null,
          update.errorMessage ?? null,
          timestamp,
          runId,
          bugKey,
        );
      this.database
        .prepare(
          `UPDATE run_store_runs
           SET archive_status = CASE WHEN ? = 'failed' THEN 'partial' ELSE archive_status END,
               archive_error = CASE WHEN ? = 'failed' THEN ? ELSE archive_error END,
               updated_at = ?
           WHERE run_id = ?`,
        )
        .run(update.status, update.status, update.errorMessage ?? null, timestamp, runId);
    })();
    return this.requireStoredRun(runId);
  }

  markArchiveFailure(runId: string, message: string): StoredRun {
    const timestamp = this.now();
    this.database
      .prepare(
        `UPDATE run_store_runs
         SET archive_status = 'failed', archive_error = ?, updated_at = ?
         WHERE run_id = ?`,
      )
      .run(message, timestamp, runId);
    return this.requireStoredRun(runId);
  }

  completeArchive(runId: string, completion: ArchiveCompletion): StoredRun {
    const timestamp = this.now();
    this.database.transaction(() => {
      const run = this.requireRunRow(runId);
      const issues = this.database
        .prepare('SELECT status FROM run_store_issues WHERE run_id = ?')
        .all(runId) as Array<{ status: StoredIssueStatus }>;
      const allIssuesSucceeded = issues.every((issue) => issue.status === 'succeeded');
      const reportReady =
        completion.reportReady &&
        (run.report_status === 'published' || run.report_status === 'not_applicable');
      const canProgress =
        run.report_status === 'published' &&
        allIssuesSucceeded &&
        (run.result === 'passed' || run.result === 'failed');
      const canComplete = reportReady && allIssuesSucceeded;
      let progressed = run.progressed === 1;
      let progressedAt = run.progressed_at;

      if (canProgress && !progressed) {
        const progress = this.database
          .prepare('SELECT run_id FROM run_store_progress WHERE id = 1')
          .get() as { run_id: string | null } | undefined;
        const currentRunId = progress?.run_id ?? null;
        const currentRun = currentRunId
          ? (this.database
              .prepare('SELECT finished_at FROM run_store_runs WHERE run_id = ?')
              .get(currentRunId) as { finished_at: string } | undefined)
          : undefined;
        const currentIsNewer =
          currentRun !== undefined &&
          (currentRun.finished_at > run.finished_at ||
            (currentRun.finished_at === run.finished_at &&
              currentRunId !== null &&
              currentRunId > run.run_id));
        if (!currentIsNewer) {
          this.database
            .prepare(
              `INSERT INTO run_store_progress (id, last_completed_target, run_id, updated_at)
               VALUES (1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 last_completed_target = excluded.last_completed_target,
                 run_id = excluded.run_id,
                 updated_at = excluded.updated_at`,
            )
            .run(run.target_commit, run.run_id, timestamp);
          progressed = true;
          progressedAt = timestamp;
        }
      }

      const archiveStatus: StoredArchiveStatus = canComplete ? 'completed' : 'partial';
      const archiveError = canComplete
        ? null
        : (completion.errorMessage ??
          (!reportReady
            ? '正式报告尚未发布'
            : !allIssuesSucceeded
              ? '仍有 confirmed Bug 未完成 Issue 归档'
              : 'Run 不满足推进条件'));
      this.database
        .prepare(
          `UPDATE run_store_runs
           SET archive_status = ?, archive_error = ?, progressed = ?, progressed_at = ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(archiveStatus, archiveError, progressed ? 1 : 0, progressedAt, timestamp, runId);
    })();
    return this.requireStoredRun(runId);
  }

  private readRunRow(runId: string): RunRow | undefined {
    return this.database.prepare('SELECT * FROM run_store_runs WHERE run_id = ?').get(runId) as
      RunRow | undefined;
  }

  private requireRunRow(runId: string): RunRow {
    const row = this.readRunRow(runId);
    if (!row) throw new RunStoreError('RUN_STORE_NOT_FOUND', `Run 不存在：${runId}`);
    return row;
  }

  private requireStoredRun(runId: string): StoredRun {
    const run = this.get(runId);
    if (!run) throw new RunStoreError('RUN_STORE_NOT_FOUND', `Run 不存在：${runId}`);
    return run;
  }

  private assertStoredArtifacts(
    runId: string,
    artifacts: Partial<Record<RunArtifactName, string>>,
  ): void {
    const existing = this.database
      .prepare('SELECT name, content FROM run_store_artifacts WHERE run_id = ?')
      .all(runId) as Array<{ name: string; content: string }>;
    const byName = new Map(existing.map((item) => [item.name, item.content]));
    for (const [name, content] of Object.entries(artifacts)) {
      if (content !== undefined && byName.get(name) !== undefined && byName.get(name) !== content) {
        throw new RunStoreError('RUN_STORE_CONFLICT', `Run 工件内容冲突：${name}`);
      }
    }
  }

  private ensureIssueRows(input: CompletedRunImport, timestamp: string): void {
    for (const bug of input.confirmedBugs) {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO run_store_issues
           (run_id, bug_key, title, scenario_ids_json, issue_action, requested_issue_url,
            status, issue_number, issue_url, error_message, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, ?, ?)`,
        )
        .run(
          input.runId,
          bug.key,
          bug.title,
          JSON.stringify(bug.scenarioIds),
          bug.issueAction,
          bug.issueUrl ?? null,
          timestamp,
          timestamp,
        );
    }
  }
}

interface RunRow {
  run_id: string;
  status: 'completed';
  trigger: RunTrigger;
  request: string;
  base_commit: string | null;
  target_commit: string;
  included_commits_json: string;
  result: RunResult;
  scenario_results_json: string;
  confirmed_bugs_json: string;
  started_at: string;
  finished_at: string;
  completed_directory: string;
  report_path: string;
  report_status: StoredReportStatus;
  report_commit_sha: string | null;
  archive_status: StoredArchiveStatus;
  archive_error: string | null;
  progressed: number;
  progressed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IssueRow {
  run_id: string;
  bug_key: string;
  title: string;
  scenario_ids_json: string;
  issue_action: 'create' | 'link';
  requested_issue_url: string | null;
  status: StoredIssueStatus;
  issue_number: number | null;
  issue_url: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function toStoredRun(
  row: RunRow,
  artifacts: Array<{ name: string; content: string }>,
  issues: IssueRow[],
): StoredRun {
  return {
    runId: row.run_id,
    status: 'completed',
    trigger: row.trigger,
    request: row.request,
    baseCommit: row.base_commit,
    targetCommit: row.target_commit,
    includedCommits: parseJson<string[]>(row.included_commits_json, []),
    result: row.result,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    completedDirectory: row.completed_directory,
    reportPath: row.report_path,
    reportStatus: row.report_status,
    reportCommitSha: row.report_commit_sha,
    archiveStatus: row.archive_status,
    archiveError: row.archive_error,
    progressed: row.progressed === 1,
    progressedAt: row.progressed_at,
    artifacts: Object.fromEntries(
      artifacts
        .filter((item): item is { name: RunArtifactName; content: string } =>
          RUN_ARTIFACT_NAMES.includes(item.name as RunArtifactName),
        )
        .map((item) => [item.name, item.content]),
    ),
    scenarioResults: parseJson<ScenarioResultSummary[]>(row.scenario_results_json, []),
    confirmedBugs: parseJson<ConfirmedBugSummary[]>(row.confirmed_bugs_json, []),
    issues: issues.map(toStoredIssue),
    specialRun: row.report_status === 'not_applicable',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredIssue(row: IssueRow): StoredRunIssue {
  return {
    runId: row.run_id,
    bugKey: row.bug_key,
    title: row.title,
    scenarioIds: parseJson<string[]>(row.scenario_ids_json, []),
    issueAction: row.issue_action,
    requestedIssueUrl: row.requested_issue_url,
    status: row.status,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function assertImport(input: CompletedRunImport): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId)) {
    throw new RunStoreError('RUN_STORE_INVALID', 'Run ID 格式无效');
  }
  if (!input.completedDirectory || !input.targetCommit || !input.startedAt || !input.finishedAt) {
    throw new RunStoreError('RUN_STORE_INVALID', 'completed Run 元数据不完整');
  }
  const keys = Object.keys(input.artifacts);
  if (keys.some((name) => !RUN_ARTIFACT_NAMES.includes(name as RunArtifactName))) {
    throw new RunStoreError('RUN_STORE_INVALID', '包含不允许归档的 Run 工件');
  }
  const bugKeys = input.confirmedBugs.map((bug) => bug.key);
  if (new Set(bugKeys).size !== bugKeys.length) {
    throw new RunStoreError('RUN_STORE_INVALID', '同一 Run 内 confirmed bug key 不能重复');
  }
}

function assertSameImmutableRun(row: RunRow, input: CompletedRunImport): void {
  const same =
    (row.request === '' || !input.request?.trim() || row.request === input.request.trim()) &&
    row.trigger === input.trigger &&
    row.base_commit === input.baseCommit &&
    row.target_commit === input.targetCommit &&
    row.result === input.result &&
    row.started_at === input.startedAt &&
    row.finished_at === input.finishedAt &&
    row.included_commits_json === JSON.stringify(input.includedCommits);
  if (!same) throw new RunStoreError('RUN_STORE_CONFLICT', `Run 元数据冲突：${input.runId}`);
}
