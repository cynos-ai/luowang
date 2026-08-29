import type Database from 'better-sqlite3';

import type {
  IndexErrorItem,
  IndexedReport,
  IndexedScenario,
  RepositorySyncResponse,
  ScenarioStatus,
} from '../../shared/types.js';
import type { RepositoryService } from './service.js';
import { RepositoryError } from './errors.js';
import {
  parseReportMarkdown,
  parseScenarioMarkdown,
  type ParsedReport,
  type ParsedScenario,
} from './markdown.js';
import type { GitRepository, GitTreeEntry } from './git-repository.js';

const SCENARIO_PREFIX = 'docs/scenario-testing/scenarios/';
const REPORT_PREFIX = 'docs/scenario-testing/reports/';

export interface RepositoryIndexer {
  sync(): Promise<RepositorySyncResponse>;
  listScenarios(filters?: { status?: ScenarioStatus; tag?: string }): IndexedScenario[];
  getScenario(id: string): IndexedScenario | null;
  listReports(): IndexedReport[];
  getReport(runId: string): IndexedReport | null;
  indexState(): { commitSha: string | null; syncedAt: string | null; errors: IndexErrorItem[] };
}

export function createRepositoryIndexer(
  database: Database.Database,
  repository: RepositoryService,
): RepositoryIndexer {
  return new SqliteRepositoryIndexer(database, repository);
}

class SqliteRepositoryIndexer implements RepositoryIndexer {
  constructor(
    private readonly database: Database.Database,
    private readonly repository: RepositoryService,
  ) {}

  async sync(): Promise<RepositorySyncResponse> {
    let git: GitRepository;
    try {
      git = await this.repository.getRepository();
    } catch (error) {
      if (error instanceof RepositoryError && error.code === 'REPOSITORY_NOT_CONFIGURED') {
        return {
          status: 'not_configured',
          commitSha: null,
          syncedAt: null,
          scenarios: 0,
          reports: 0,
          errors: [],
          message: error.message,
        };
      }
      throw error;
    }

    const branch = this.repository.getScenarioBranch();
    await git.fetch();
    const commitSha = await git.remoteBranchHead(branch);
    if (!commitSha) {
      return {
        status: 'failed',
        commitSha: null,
        syncedAt: null,
        scenarios: this.count('indexed_scenarios'),
        reports: this.count('indexed_reports'),
        errors: [{ path: branch, message: '场景测试分支不存在，请先创建或确认分支' }],
        message: '场景测试分支不存在',
      };
    }

    const previousState = this.database
      .prepare(
        `SELECT repository, scenario_branch, commit_sha
         FROM repository_index_state WHERE id = 1`,
      )
      .get() as
      { repository: string; scenario_branch: string; commit_sha: string | null } | undefined;
    if (
      previousState?.repository === this.repository.getRepositoryUrl() &&
      previousState.scenario_branch === branch &&
      previousState.commit_sha &&
      previousState.commit_sha !== commitSha
    ) {
      try {
        await git.assertAncestor(previousState.commit_sha, commitSha);
      } catch {
        const error = {
          path: branch,
          message: '场景测试分支历史已断裂，保留上一次完整索引，请重新指定起点',
        };
        return {
          status: 'failed',
          commitSha,
          syncedAt: null,
          scenarios: this.count('indexed_scenarios'),
          reports: this.count('indexed_reports'),
          errors: [error],
          message: error.message,
        };
      }
    }

    const snapshot = await this.readSnapshot(git, commitSha);
    const syncedAt = new Date().toISOString();
    this.applySnapshot(snapshot, {
      repository: this.repositoryRepositoryName(),
      scenarioBranch: branch,
      commitSha,
      syncedAt,
    });
    return {
      status: 'synced',
      commitSha,
      syncedAt,
      scenarios: this.count('indexed_scenarios'),
      reports: this.count('indexed_reports'),
      errors: snapshot.errors,
      message:
        snapshot.errors.length === 0
          ? `已同步 ${snapshot.scenes.length} 个场景和 ${snapshot.reports.length} 个报告`
          : `已同步，但有 ${snapshot.errors.length} 个索引错误`,
    };
  }

  listScenarios(filters: { status?: ScenarioStatus; tag?: string } = {}): IndexedScenario[] {
    const rows = this.database
      .prepare(
        `SELECT path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at
         FROM indexed_scenarios ORDER BY scenario_id`,
      )
      .all() as ScenarioRow[];
    return rows
      .map(toScenario)
      .filter((scenario) => !filters.status || scenario.status === filters.status)
      .filter((scenario) => !filters.tag || scenario.tags.includes(filters.tag));
  }

  getScenario(id: string): IndexedScenario | null {
    const row = this.database
      .prepare(
        `SELECT path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at
         FROM indexed_scenarios WHERE scenario_id = ?`,
      )
      .get(id) as ScenarioRow | undefined;
    return row ? toScenario(row) : null;
  }

  listReports(): IndexedReport[] {
    return this.database
      .prepare(
        `SELECT run_id, path, trigger, base_commit, target_commit, included_commits_json,
                result, started_at, finished_at, scenario_results_json, confirmed_bugs_json,
                files_json, content, commit_sha, indexed_at
         FROM indexed_reports ORDER BY finished_at DESC`,
      )
      .all()
      .map((row) => toReport(row as ReportRow));
  }

  getReport(runId: string): IndexedReport | null {
    const row = this.database
      .prepare(
        `SELECT run_id, path, trigger, base_commit, target_commit, included_commits_json,
                result, started_at, finished_at, scenario_results_json, confirmed_bugs_json,
                files_json, content, commit_sha, indexed_at
         FROM indexed_reports WHERE run_id = ?`,
      )
      .get(runId) as ReportRow | undefined;
    return row ? toReport(row) : null;
  }

  indexState(): { commitSha: string | null; syncedAt: string | null; errors: IndexErrorItem[] } {
    const row = this.database
      .prepare('SELECT commit_sha, synced_at FROM repository_index_state WHERE id = 1')
      .get() as { commit_sha: string | null; synced_at: string | null } | undefined;
    return {
      commitSha: row?.commit_sha ?? null,
      syncedAt: row?.synced_at ?? null,
      errors: this.database
        .prepare('SELECT path, message FROM repository_index_errors ORDER BY path')
        .all()
        .map((item) => item as IndexErrorItem),
    };
  }

  private async readSnapshot(git: GitRepository, commitSha: string): Promise<Snapshot> {
    const tree = await git.listTree(commitSha);
    const errors: IndexErrorItem[] = [];
    const scenes: Array<{ path: string; data: ParsedScenario; content: string }> = [];
    const scenePaths = new Set<string>();
    for (const entry of tree.filter(
      (item) => item.path.startsWith(SCENARIO_PREFIX) && item.path.endsWith('.md'),
    )) {
      scenePaths.add(entry.path);
      if (!isRegularBlob(entry)) {
        errors.push({ path: entry.path, message: '场景文件必须是普通 Markdown 文件' });
        continue;
      }
      try {
        const content = await git.readFile(commitSha, entry.path);
        scenes.push({
          path: entry.path,
          data: parseScenarioMarkdown(content, entry.path),
          content,
        });
      } catch (error) {
        errors.push({ path: entry.path, message: errorMessage(error) });
      }
    }

    const duplicateIds = new Set(
      [...groupBy(scenes, (item) => item.data.id).entries()]
        .filter(([, entries]) => entries.length > 1)
        .flatMap(([, entries]) => entries.map((entry) => entry.path)),
    );
    const validScenes = scenes.filter((scene) => {
      if (!duplicateIds.has(scene.path)) return true;
      errors.push({ path: scene.path, message: `场景 id 重复：${scene.data.id}` });
      return false;
    });

    const reportFiles = new Map<string, Map<string, { entry: GitTreeEntry; content: string }>>();
    for (const entry of tree.filter(
      (item) => item.path.startsWith(REPORT_PREFIX) && item.path.endsWith('.md'),
    )) {
      const relative = entry.path.slice(REPORT_PREFIX.length);
      const [runId, ...fileParts] = relative.split('/');
      const fileName = fileParts.join('/');
      if (!runId || !fileName || runId.includes('..')) {
        errors.push({ path: entry.path, message: '报告路径必须是 reports/<run-id>/<file>.md' });
        continue;
      }
      if (!isRegularBlob(entry)) {
        errors.push({ path: entry.path, message: '报告文件必须是普通 Markdown 文件' });
        continue;
      }
      let files = reportFiles.get(runId);
      if (!files) {
        files = new Map();
        reportFiles.set(runId, files);
      }
      try {
        files.set(fileName, { entry, content: await git.readFile(commitSha, entry.path) });
      } catch (error) {
        errors.push({ path: entry.path, message: errorMessage(error) });
      }
    }

    const reports: ParsedReportRecord[] = [];
    const reportDirs = new Set<string>();
    for (const [runId, files] of reportFiles) {
      const reportPath = `${REPORT_PREFIX}${runId}`;
      reportDirs.add(reportPath);
      const finalReport = files.get('report.md');
      if (!finalReport) {
        errors.push({ path: `${reportPath}/report.md`, message: '报告目录缺少 report.md' });
        continue;
      }
      try {
        const parsed = parseReportMarkdown(finalReport.content, `${reportPath}/report.md`, runId);
        reports.push({
          path: reportPath,
          data: parsed,
          content: finalReport.content,
          files: Object.fromEntries(
            [...files.entries()].map(([name, item]) => [name, item.content]),
          ),
        });
      } catch (error) {
        errors.push({ path: `${reportPath}/report.md`, message: errorMessage(error) });
      }
    }

    return { scenes: validScenes, reports, scenePaths, reportDirs, errors: uniqueErrors(errors) };
  }

  private applySnapshot(
    snapshot: Snapshot,
    state: { repository: string; scenarioBranch: string; commitSha: string; syncedAt: string },
  ): void {
    this.database.transaction(() => {
      const currentScenePaths = [...snapshot.scenePaths];
      const currentReportDirs = [...snapshot.reportDirs];
      if (currentScenePaths.length === 0) {
        this.database.prepare('DELETE FROM indexed_scenarios').run();
      } else {
        this.database
          .prepare(
            `DELETE FROM indexed_scenarios WHERE path NOT IN (${currentScenePaths.map(() => '?').join(',')})`,
          )
          .run(...currentScenePaths);
      }
      if (currentReportDirs.length === 0) {
        this.database.prepare('DELETE FROM indexed_reports').run();
      } else {
        this.database
          .prepare(
            `DELETE FROM indexed_reports WHERE path NOT IN (${currentReportDirs.map(() => '?').join(',')})`,
          )
          .run(...currentReportDirs);
      }

      for (const scene of snapshot.scenes) {
        this.database
          .prepare('DELETE FROM indexed_scenarios WHERE scenario_id = ? AND path <> ?')
          .run(scene.data.id, scene.path);
        this.database
          .prepare(
            `INSERT INTO indexed_scenarios
             (path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               scenario_id = excluded.scenario_id,
               name = excluded.name,
               description = excluded.description,
               status = excluded.status,
               tags_json = excluded.tags_json,
               content = excluded.content,
               commit_sha = excluded.commit_sha,
               indexed_at = excluded.indexed_at`,
          )
          .run(
            scene.path,
            scene.data.id,
            scene.data.name,
            scene.data.description,
            scene.data.status,
            JSON.stringify(scene.data.tags),
            scene.content,
            state.commitSha,
            state.syncedAt,
          );
      }
      for (const report of snapshot.reports) {
        this.database
          .prepare('DELETE FROM indexed_reports WHERE run_id = ? AND path <> ?')
          .run(report.data.runId, report.path);
        this.database
          .prepare(
            `INSERT INTO indexed_reports
             (run_id, path, trigger, base_commit, target_commit, included_commits_json, result,
              started_at, finished_at, scenario_results_json, confirmed_bugs_json, files_json,
              content, commit_sha, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               path = excluded.path,
               trigger = excluded.trigger,
               base_commit = excluded.base_commit,
               target_commit = excluded.target_commit,
               included_commits_json = excluded.included_commits_json,
               result = excluded.result,
               started_at = excluded.started_at,
               finished_at = excluded.finished_at,
               scenario_results_json = excluded.scenario_results_json,
               confirmed_bugs_json = excluded.confirmed_bugs_json,
               files_json = excluded.files_json,
               content = excluded.content,
               commit_sha = excluded.commit_sha,
               indexed_at = excluded.indexed_at`,
          )
          .run(
            report.data.runId,
            report.path,
            report.data.trigger,
            report.data.baseCommit,
            report.data.targetCommit,
            JSON.stringify(report.data.includedCommits),
            report.data.result,
            report.data.startedAt,
            report.data.finishedAt,
            JSON.stringify(report.data.scenarioResults),
            JSON.stringify(report.data.confirmedBugs),
            JSON.stringify(report.files),
            report.content,
            state.commitSha,
            state.syncedAt,
          );
      }
      this.database.prepare('DELETE FROM repository_index_errors').run();
      for (const error of snapshot.errors) {
        this.database
          .prepare(
            `INSERT INTO repository_index_errors (path, message, commit_sha, indexed_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(error.path, error.message, state.commitSha, state.syncedAt);
      }
      this.database
        .prepare(
          `INSERT INTO repository_index_state (id, repository, scenario_branch, commit_sha, synced_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             repository = excluded.repository,
             scenario_branch = excluded.scenario_branch,
             commit_sha = excluded.commit_sha,
             synced_at = excluded.synced_at`,
        )
        .run(state.repository, state.scenarioBranch, state.commitSha, state.syncedAt);
    })();
  }

  private repositoryRepositoryName(): string {
    return this.repository.getRepositoryUrl();
  }

  private count(table: 'indexed_scenarios' | 'indexed_reports'): number {
    return Number(
      (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count,
    );
  }
}

interface Snapshot {
  scenes: Array<{ path: string; data: ParsedScenario; content: string }>;
  reports: ParsedReportRecord[];
  scenePaths: Set<string>;
  reportDirs: Set<string>;
  errors: IndexErrorItem[];
}

interface ParsedReportRecord {
  path: string;
  data: ParsedReport;
  content: string;
  files: Record<string, string>;
}

interface ScenarioRow {
  path: string;
  scenario_id: string;
  name: string;
  description: string;
  status: string;
  tags_json: string;
  content: string;
  commit_sha: string;
  indexed_at: string;
}

interface ReportRow {
  run_id: string;
  path: string;
  trigger: string;
  base_commit: string | null;
  target_commit: string;
  included_commits_json: string;
  result: string;
  started_at: string;
  finished_at: string;
  scenario_results_json: string;
  confirmed_bugs_json: string;
  files_json: string;
  content: string;
  commit_sha: string;
  indexed_at: string;
}

function toScenario(row: ScenarioRow): IndexedScenario {
  return {
    id: row.scenario_id,
    path: row.path,
    name: row.name,
    description: row.description,
    status: row.status as IndexedScenario['status'],
    tags: parseJson<string[]>(row.tags_json, []),
    content: row.content,
    commitSha: row.commit_sha,
    indexedAt: row.indexed_at,
  };
}

function toReport(row: ReportRow): IndexedReport {
  return {
    runId: row.run_id,
    path: row.path,
    trigger: row.trigger as IndexedReport['trigger'],
    baseCommit: row.base_commit,
    targetCommit: row.target_commit,
    includedCommits: parseJson<string[]>(row.included_commits_json, []),
    result: row.result as IndexedReport['result'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    scenarioResults: parseJson<IndexedReport['scenarioResults']>(row.scenario_results_json, []),
    confirmedBugs: parseJson<IndexedReport['confirmedBugs']>(row.confirmed_bugs_json, []),
    files: parseJson<Record<string, string>>(row.files_json, {}),
    content: row.content,
    commitSha: row.commit_sha,
    indexedAt: row.indexed_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isRegularBlob(entry: GitTreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = result.get(value) ?? [];
    group.push(item);
    result.set(value, group);
  }
  return result;
}

function uniqueErrors(errors: IndexErrorItem[]): IndexErrorItem[] {
  return [
    ...new Map(errors.map((item) => [`${item.path}\u0000${item.message}`, item])).values(),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '索引文件读取失败';
}
