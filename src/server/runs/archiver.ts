import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { RepositoryIssue } from '../../shared/types.js';
import { parseReportMarkdown } from '../repository/markdown.js';
import type { ReportFileName, ReportPublishResult } from '../repository/git-repository.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import { RepositoryError } from '../repository/errors.js';
import { parseGitHubRepository } from '../repository/github.js';
import type { ScenarioPatchValidation } from '../repository/scenario-patch.js';
import type { RepositoryService } from '../repository/service.js';
import {
  createRunStore,
  RunStoreError,
  type RunStore,
  type StoredArchiveStatus,
  type StoredRun,
} from './store.js';
import { RunWorkspaceError, RunWorkspaceStore } from './workspace.js';
import { RUN_ARTIFACT_NAMES, SCENARIO_PATCH_ARTIFACT_NAME } from './types.js';

export type ArchiveResultStatus = 'completed' | 'partial' | 'failed';

export interface ArchiveIssueResult {
  bugKey: string;
  status: 'pending' | 'succeeded' | 'failed';
  issueNumber: number | null;
  issueUrl: string | null;
  errorMessage: string | null;
}

export interface ArchiveResult {
  runId: string;
  status: ArchiveResultStatus;
  reportStatus: StoredRun['reportStatus'];
  reportCommitSha: string | null;
  issues: ArchiveIssueResult[];
  progressed: boolean;
  archiveStatus: StoredArchiveStatus;
  errorMessage: string | null;
  indexerTriggered: boolean;
  scenarioStatus?: StoredRun['scenarioStatus'];
  scenarioCommitSha?: string | null;
  scenarioPrUrl?: string | null;
  scenarioError?: string | null;
}

export interface RunArchiver {
  archive(runId: string): Promise<ArchiveResult>;
  scan(): Promise<ArchiveResult[]>;
  retry(runId: string): Promise<ArchiveResult>;
}

export interface RunArchiverOptions {
  database: Database.Database;
  reportDir: string;
  repository: RepositoryService;
  indexer?: RepositoryIndexer;
  runStore?: RunStore;
  now?: () => string;
  logger?: Logger;
}

export function createRunArchiver(options: RunArchiverOptions): RunArchiver {
  return new DefaultRunArchiver({
    ...options,
    runStore: options.runStore ?? createRunStore(options.database, { now: options.now }),
  });
}

export const createArchiver = createRunArchiver;

class DefaultRunArchiver implements RunArchiver {
  private readonly workspaceStore: RunWorkspaceStore;
  private readonly active = new Map<string, Promise<ArchiveResult>>();

  constructor(private readonly options: RunArchiverOptions & { runStore: RunStore }) {
    this.workspaceStore = new RunWorkspaceStore(options.reportDir);
  }

  async archive(runId: string): Promise<ArchiveResult> {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const operation = this.archiveInternal(runId).finally(() => {
      if (this.active.get(runId) === operation) this.active.delete(runId);
    });
    this.active.set(runId, operation);
    return operation;
  }

  async scan(): Promise<ArchiveResult[]> {
    const runIds = await this.workspaceStore.list('completed');
    return Promise.all(runIds.map((runId) => this.archive(runId)));
  }

  async retry(runId: string): Promise<ArchiveResult> {
    return this.archive(runId);
  }

  private async archiveInternal(runId: string): Promise<ArchiveResult> {
    let imported: StoredRun;
    let report: ReturnType<typeof parseReportMarkdown>;
    let specialRun = false;
    let scenarioPatch: string | undefined;
    try {
      const workspace = this.workspaceStore.open(runId, 'completed');
      const artifacts = await workspace.list();
      specialRun = isSpecialScenarioReviewRun(artifacts);
      scenarioPatch = artifacts[SCENARIO_PATCH_ARTIFACT_NAME];
      if (specialRun && scenarioPatch === undefined) {
        throw new RunWorkspaceError('ARTIFACT_MISSING', '场景变更 patch 无法读取');
      }
      if (!specialRun) {
        const missing = RUN_ARTIFACT_NAMES.filter((name) => artifacts[name] === undefined);
        if (missing.length > 0) {
          throw new RunWorkspaceError(
            'ARTIFACT_MISSING',
            `completed Run 缺少必需工件：${missing.join(', ')}`,
          );
        }
      } else if (artifacts['report.md'] === undefined) {
        throw new RunWorkspaceError('ARTIFACT_MISSING', '特殊 blocked Run 缺少 report.md');
      }
      const reportContent = artifacts['report.md'];
      if (!reportContent)
        throw new RunWorkspaceError('ARTIFACT_MISSING', 'completed Run 缺少 report.md');
      report = parseReportMarkdown(
        reportContent,
        `${workspace.completedDirectory}/report.md`,
        runId,
      );
      assertArchivableReport(report);
      if (specialRun && report.result !== 'blocked') {
        throw new RepositoryError(
          'REPORT_CONFLICT',
          '包含场景变更 patch 的特殊 Run 必须是 blocked',
          422,
        );
      }
      imported = this.options.runStore.importCompleted({
        runId,
        trigger: report.trigger,
        baseCommit: report.baseCommit,
        targetCommit: report.targetCommit,
        includedCommits: report.includedCommits,
        result: report.result,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        completedDirectory: workspace.completedDirectory,
        artifacts,
        scenarioResults: report.scenarioResults,
        confirmedBugs: report.confirmedBugs,
        specialRun,
      });
    } catch (error) {
      const message = safeArchiveMessage(error);
      const stored = this.options.runStore.get(runId);
      if (stored) {
        this.options.runStore.markArchiveFailure(runId, message);
        return this.toResult(this.options.runStore.get(runId)!, false);
      }
      return {
        runId,
        status: 'failed',
        reportStatus: 'failed',
        reportCommitSha: null,
        issues: [],
        progressed: false,
        archiveStatus: 'failed',
        errorMessage: message,
        indexerTriggered: false,
      };
    }

    if (imported.archiveStatus === 'completed') return this.toResult(imported, false);

    let indexerTriggered = false;
    if (
      scenarioPatch !== undefined &&
      imported.scenarioStatus !== 'published' &&
      imported.scenarioStatus !== 'pull_request' &&
      (!imported.specialRun || this.options.repository.publishScenarioChanges !== undefined)
    ) {
      try {
        const metadata = await this.validateScenarioPatch(imported.targetCommit, scenarioPatch);
        const mode = scenarioPublicationMode(imported, metadata);
        if (!this.options.repository.publishScenarioChanges) {
          throw new RepositoryError(
            'SCENARIO_PR_CREATE_FAILED',
            'Repository Service 未提供场景变更归档能力',
            503,
          );
        }
        const publication = await this.options.repository.publishScenarioChanges(
          runId,
          scenarioPatch,
          mode,
          scenarioPublicationDetails(imported),
        );
        if (publication.status === 'pull_request') {
          if (!publication.scenarioPrUrl) {
            throw new RepositoryError('SCENARIO_PR_CREATE_FAILED', '场景 PR 地址缺失', 502);
          }
          imported = this.options.runStore.markScenario(runId, {
            status: 'pull_request',
            commitSha: publication.commitSha,
            scenarioPrUrl: publication.scenarioPrUrl,
            errorMessage: null,
          });
        } else {
          if (!publication.commitSha) {
            throw new RepositoryError('SCENARIO_PUBLISH_CONFLICT', '场景提交 SHA 缺失', 502);
          }
          imported = this.options.runStore.markScenario(runId, {
            status: 'published',
            commitSha: publication.commitSha,
            scenarioPrUrl: null,
            errorMessage: null,
          });
        }
      } catch (error) {
        const message = safeArchiveMessage(error);
        imported = this.options.runStore.markScenario(runId, {
          status: 'failed',
          errorMessage: message,
        });
        this.options.logger?.warn(
          { runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'scenario change archive failed',
        );
      }
    }

    if (
      imported.reportStatus === 'pending' ||
      imported.reportStatus === 'failed' ||
      imported.reportStatus === 'conflict'
    ) {
      const reportFiles = pickReportFiles(imported.artifacts);
      if (!reportFiles) {
        imported = this.options.runStore.markReport(runId, {
          status: 'failed',
          errorMessage: '正式报告工件不完整',
        });
        if (imported.result !== 'blocked') return this.toResult(imported, false);
      } else {
        let publication: ReportPublishResult | undefined;
        try {
          publication = await this.options.repository.publishRunReports(runId, reportFiles);
        } catch (error) {
          const message = safeArchiveMessage(error);
          const status =
            error instanceof RepositoryError &&
            (error.code === 'REPORT_CONFLICT' || error.code === 'REPORT_PUBLISH_CONFLICT')
              ? 'conflict'
              : 'failed';
          imported = this.options.runStore.markReport(runId, {
            status,
            errorMessage: message,
          });
          if (imported.result !== 'blocked') return this.toResult(imported, false);
        }
        if (publication) {
          imported = this.options.runStore.markReport(runId, {
            status: 'published',
            commitSha: publication.commitSha,
            errorMessage: null,
          });
          if (this.options.indexer) {
            indexerTriggered = true;
            try {
              await this.options.indexer.sync();
            } catch (error) {
              this.options.logger?.warn(
                { runId, errorName: error instanceof Error ? error.name : 'UnknownError' },
                'repository indexer failed after report publication',
              );
            }
          }
        }
      }
    }

    imported = this.options.runStore.get(runId)!;
    for (const issue of imported.issues) {
      if (issue.status === 'succeeded') continue;
      try {
        const result = await this.processIssue(imported, issue);
        this.options.runStore.markIssueAttempt(runId, issue.bugKey, {
          status: 'succeeded',
          issueNumber: result.number,
          issueUrl: result.url,
          errorMessage: null,
        });
      } catch (error) {
        const message = safeArchiveMessage(error);
        this.options.runStore.markIssueAttempt(runId, issue.bugKey, {
          status: 'failed',
          errorMessage: message,
        });
        this.options.logger?.warn(
          {
            runId,
            bugKey: issue.bugKey,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'run issue archive failed',
        );
      }
    }

    const current = this.options.runStore.get(runId)!;
    const failedIssues = current.issues.filter((issue) => issue.status !== 'succeeded');
    const completed = this.options.runStore.completeArchive(runId, {
      reportReady:
        current.reportStatus === 'published' || current.reportStatus === 'not_applicable',
      errorMessage: failedIssues.length > 0 ? '仍有 confirmed Bug 未完成 Issue 归档' : null,
    });
    return this.toResult(completed, indexerTriggered);
  }

  private async processIssue(
    run: StoredRun,
    issue: StoredRun['issues'][number],
  ): Promise<Pick<RepositoryIssue, 'number' | 'url'>> {
    if (issue.issueAction === 'link') {
      const url = issue.requestedIssueUrl;
      if (!url || !isIssueUrlForRepository(url, this.options.repository.getRepositoryUrl())) {
        throw new RepositoryError('ISSUE_URL_INVALID', 'Issue 关联地址无效', 400);
      }
      const found = await this.options.repository.getIssueByUrl(url);
      return { number: found.number, url: found.url };
    }

    assertMarkerPart(run.runId);
    assertMarkerPart(issue.bugKey);
    const runMarker = `luowang-run:${run.runId}`;
    const bugMarker = `luowang-bug:${issue.bugKey}`;
    const matches = await this.options.repository.findIssuesByMarkers([runMarker, bugMarker]);
    const existing = matches.sort((left, right) => left.number - right.number)[0];
    if (existing) return { number: existing.number, url: existing.url };
    const title = issue.title.replace(/[\r\n]+/g, ' ').trim();
    if (title === '') throw new RepositoryError('ISSUE_CREATE_FAILED', 'Issue 标题无效', 400);
    const body = [
      '由 LuoWang 归档的 confirmed bug。',
      '',
      `- ${runMarker}`,
      `- ${bugMarker}`,
      `- target_commit: ${run.targetCommit}`,
      `- scenario_ids: ${issue.scenarioIds.join(', ') || 'none'}`,
    ].join('\n');
    const created = await this.options.repository.createIssue(title, body);
    if (
      created.number <= 0 ||
      !isIssueUrlForRepository(created.url, this.options.repository.getRepositoryUrl())
    ) {
      throw new RepositoryError('ISSUE_CREATE_FAILED', 'GitHub Issue 响应无效', 502);
    }
    return { number: created.number, url: created.url };
  }

  private toResult(run: StoredRun, indexerTriggered: boolean): ArchiveResult {
    const failed = run.archiveStatus === 'failed';
    const partial = run.archiveStatus === 'partial';
    return {
      runId: run.runId,
      status: failed ? 'failed' : partial ? 'partial' : 'completed',
      reportStatus: run.reportStatus,
      reportCommitSha: run.reportCommitSha,
      issues: run.issues.map((issue) => ({
        bugKey: issue.bugKey,
        status: issue.status,
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        errorMessage: issue.errorMessage,
      })),
      progressed: run.progressed,
      archiveStatus: run.archiveStatus,
      errorMessage: run.archiveError,
      indexerTriggered,
      scenarioStatus: run.scenarioStatus,
      scenarioCommitSha: run.scenarioCommitSha,
      scenarioPrUrl: run.scenarioPrUrl,
      scenarioError: run.scenarioError,
    };
  }

  private async validateScenarioPatch(
    baseCommit: string,
    patch: string,
  ): Promise<ScenarioPatchValidation> {
    if (this.options.repository.validateScenarioPatch) {
      return this.options.repository.validateScenarioPatch(baseCommit, patch);
    }
    const repository = await this.options.repository.getRepository();
    return repository.validateScenarioPatch(baseCommit, patch);
  }
}

function pickReportFiles(artifacts: StoredRun['artifacts']): Record<ReportFileName, string> | null {
  const draft = artifacts['draft-report.md'];
  const review = artifacts['review.md'];
  const report = artifacts['report.md'];
  if (draft === undefined || review === undefined || report === undefined) return null;
  return { 'draft-report.md': draft, 'review.md': review, 'report.md': report };
}

function isSpecialScenarioReviewRun(artifacts: Record<string, string>): boolean {
  return (
    artifacts[SCENARIO_PATCH_ARTIFACT_NAME] !== undefined &&
    artifacts['report.md'] !== undefined &&
    RUN_ARTIFACT_NAMES.filter((name) => name !== 'report.md').every(
      (name) => artifacts[name] === undefined,
    )
  );
}

function scenarioPublicationMode(
  run: StoredRun,
  metadata: ScenarioPatchValidation,
): 'direct' | 'pull-request' {
  if (run.specialRun) return 'pull-request';
  if (run.scenarioMode === 'autonomous') return 'direct';
  if (run.scenarioMode === 'add-only' && metadata.onlyAdds) return 'direct';
  return 'pull-request';
}

function scenarioPublicationDetails(run: StoredRun): {
  targetCommit: string;
  reason: string;
  blockingReasons: readonly string[];
} {
  if (run.specialRun) {
    return {
      targetCommit: run.targetCommit,
      reason: '当前场景变更模式要求人工审核，Run 以 blocked 结束。',
      blockingReasons: ['场景变更等待人工审核，合并后可人工重测。'],
    };
  }
  return {
    targetCommit: run.targetCommit,
    reason: '本次 Run 验证了场景变更后需要维护的长期测试资产。',
    blockingReasons: [],
  };
}

function isGitHubIssueUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      parts.length === 4 &&
      parts[2] === 'issues' &&
      /^\d+$/.test(parts[3] ?? '')
    );
  } catch {
    return false;
  }
}

function isIssueUrlForRepository(value: string, repositoryUrl: string): boolean {
  if (!isGitHubIssueUrl(value)) return false;
  try {
    const configured = parseGitHubRepository(repositoryUrl);
    const issue = new URL(value);
    const parts = issue.pathname.split('/').filter(Boolean);
    return (
      parts[0]?.toLowerCase() === configured.owner.toLowerCase() &&
      parts[1]?.toLowerCase() === configured.name.toLowerCase()
    );
  } catch {
    // Local repository test doubles do not have a GitHub URL. The production
    // RepositoryService validates the exact owner/name before the request.
    return true;
  }
}

function assertMarkerPart(value: string): void {
  if (
    value.trim() === '' ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new RepositoryError('ISSUE_CREATE_FAILED', 'Issue 标记包含无效字符', 400);
  }
}

function assertArchivableReport(report: ReturnType<typeof parseReportMarkdown>): void {
  if (report.result === 'failed' && report.confirmedBugs.length === 0) {
    throw new RepositoryError('REPORT_CONFLICT', 'failed 报告必须至少包含一个 confirmed bug', 422);
  }
  if (report.result === 'passed' && report.confirmedBugs.length > 0) {
    throw new RepositoryError('REPORT_CONFLICT', 'passed 报告不能包含 confirmed bug', 422);
  }
}

function safeArchiveMessage(error: unknown): string {
  if (
    error instanceof RepositoryError ||
    error instanceof RunWorkspaceError ||
    error instanceof RunStoreError
  ) {
    return error.message;
  }
  return '归档步骤失败，已保留 completed 目录，稍后可重试';
}
