import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { RepositoryIssue, RunResult } from '../../shared/types.js';
import type { RunRecoveryStore } from '../automation/recovery.js';
import type { RepositoryService } from '../repository/service.js';
import { createTextResult } from './agent-session.js';
import type { RunStore, StoredRun, StoredRunIssue } from './store.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_FINALIZATION_CALLS = 10;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SCENARIO_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;

export interface RunHistoryDependencies {
  runStore?: RunStore;
  recoveryStore?: RunRecoveryStore;
}

export interface IssueCandidateDependencies {
  runStore?: RunStore;
  repository: Pick<RepositoryService, 'listIssues'>;
}

export function createRunHistoryTool(dependencies: RunHistoryDependencies): ToolDefinition {
  const parameters = Type.Object(
    {
      commit: Type.Optional(Type.String({ minLength: 40, maxLength: 40 })),
      scenarioId: Type.Optional(Type.String({ maxLength: 128 })),
      bugOrIssue: Type.Optional(Type.String({ maxLength: 256 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    },
    { additionalProperties: false },
  );
  return {
    name: 'query_run_history',
    label: '查询历史 Run',
    description:
      '只读查询 SQLite/Recovery 中有限、脱敏的历史 Run；可按 commit、场景或 Bug/Issue 过滤，默认最近 20 条，最多 100 条。',
    parameters,
    execute: async (
      _toolCallId: string,
      params: Static<typeof parameters>,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      try {
        const query = validateRunHistoryQuery(params);
        if (!dependencies.runStore && !dependencies.recoveryStore) {
          return createTextResult(
            JSON.stringify({
              status: 'unavailable',
              runs: [],
              message: 'Run 历史存储当前不可用',
            }),
          );
        }
        let completed: StoredRun[];
        let interrupted: ReturnType<RunRecoveryStore['list']>;
        try {
          completed = dependencies.runStore?.list() ?? [];
          interrupted = dependencies.recoveryStore?.list() ?? [];
        } catch {
          return createTextResult(
            JSON.stringify({
              status: 'unavailable',
              runs: [],
              message: 'Run 历史依赖当前不可用',
            }),
          );
        }
        const runs = [
          ...completed.map(summarizeStoredRun),
          ...interrupted.map((run) => ({
            runId: run.runId,
            status: 'interrupted' as const,
            result: null,
            trigger: run.trigger,
            request: sanitizeText(run.request, 240),
            baseCommit: run.baseCommit,
            targetCommit: run.targetCommit,
            includedCommits: [...run.includedCommits],
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            scenarioResults: [],
            bugKeys: [],
            issueUrls: [],
            scenarioPrUrl: null,
            reportStatus: 'not_applicable',
            scenarioStatus: 'not_applicable',
            archiveStatus: 'not_applicable',
            errorMessage: sanitizeNullable(run.errorMessage, 500),
            initialization: run.initialization === true,
            specialBlocked: false,
            interrupted: true,
          })),
        ]
          .filter((run) => historyMatches(run, query))
          .sort(compareHistory)
          .slice(0, query.limit);
        return createTextResult(JSON.stringify({ status: runs.length > 0 ? 'ok' : 'empty', runs }));
      } catch (error) {
        return createTextResult(errorMessage(error), { error: true });
      }
    },
  };
}

export interface IssueCandidateController {
  tool: ToolDefinition;
  callCount(): number;
  coverageForBug(bugKey: string, title: string): 'covered' | 'gap' | 'none';
}

export function createIssueCandidateController(
  dependencies: IssueCandidateDependencies,
  canQuery: () => boolean,
): IssueCandidateController {
  const parameters = Type.Object(
    {
      title: Type.Optional(Type.String({ maxLength: 200 })),
      keywords: Type.Optional(
        Type.Array(Type.String({ minLength: 2, maxLength: 64 }), {
          minItems: 1,
          maxItems: 8,
        }),
      ),
      bug_key: Type.Optional(Type.String({ maxLength: 128 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    },
    { additionalProperties: false },
  );
  let calls = 0;
  const queryResults: Array<{
    query: IssueCandidateQuery;
    status: 'ok' | 'empty' | 'unavailable' | 'budget-exhausted';
  }> = [];
  const previous = new Map<string, { status: 'ok' | 'empty' | 'unavailable'; attempts: number }>();

  const tool: ToolDefinition = {
    name: 'query_issue_candidates',
    label: '查询相似 Issue 候选',
    description:
      'Main · 最终汇总在读取本次 draft/review 并形成 Bug 候选后，只读查询相似 Issue 和有限关联 Run。不会创建、修改、关闭或评论 Issue。',
    parameters,
    execute: async (
      _toolCallId: string,
      params: Static<typeof parameters>,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      try {
        if (!canQuery())
          throw new Error('必须先读取 draft-report.md 和 review.md，再查询 Issue 候选');
        const query = validateIssueCandidateQuery(params);
        const key = JSON.stringify(query);
        const prior = previous.get(key);
        if (prior?.status === 'ok' || prior?.status === 'empty') {
          throw new Error('成功或空结果的相同 Issue 查询不能重复');
        }
        if (prior?.status === 'unavailable' && prior.attempts >= 2) {
          return createTextResult(
            JSON.stringify({
              status: 'unavailable',
              candidates: [],
              message: '相同 unavailable 查询已达到一次重试上限',
            }),
          );
        }
        if (calls >= MAX_FINALIZATION_CALLS) {
          queryResults.push({ query, status: 'budget-exhausted' });
          return createTextResult(
            JSON.stringify({
              status: 'unavailable',
              candidates: [],
              message: '本次最终汇总的 Issue 查询预算已耗尽',
            }),
          );
        }
        calls += 1;
        try {
          if (!dependencies.runStore) throw new Error('run store unavailable');
          const issues = await dependencies.repository.listIssues();
          const candidates = findIssueCandidates(issues, dependencies.runStore.list(), query).slice(
            0,
            query.limit,
          );
          const status = candidates.length > 0 ? 'ok' : 'empty';
          previous.set(key, { status, attempts: (prior?.attempts ?? 0) + 1 });
          queryResults.push({ query, status });
          return createTextResult(JSON.stringify({ status, candidates }));
        } catch {
          previous.set(key, {
            status: 'unavailable',
            attempts: (prior?.attempts ?? 0) + 1,
          });
          queryResults.push({ query, status: 'unavailable' });
          return createTextResult(
            JSON.stringify({
              status: 'unavailable',
              candidates: [],
              message: 'Issue 或 Run 历史依赖当前不可用',
            }),
          );
        }
      } catch (error) {
        return createTextResult(errorMessage(error), { error: true });
      }
    },
  };
  return {
    tool,
    callCount: () => calls,
    coverageForBug: (bugKey, title) => {
      const normalizedKey = normalize(bugKey);
      const normalizedTitle = normalize(title);
      const matching = queryResults.filter(({ query }) =>
        queryMatchesBug(query, normalizedKey, normalizedTitle),
      );
      if (matching.some(({ status }) => status === 'ok' || status === 'empty')) return 'covered';
      if (matching.length > 0) return 'gap';
      return 'none';
    },
  };
}

interface RunHistoryQuery {
  commit?: string;
  scenarioId?: string;
  bugOrIssue?: string;
  limit: number;
}

interface HistorySummary {
  runId: string;
  status: 'completed' | 'interrupted';
  result: RunResult | null;
  trigger: string;
  request: string;
  baseCommit: string | null;
  targetCommit: string | null;
  includedCommits: string[];
  startedAt: string;
  finishedAt: string | null;
  scenarioResults: Array<{ id: string; result: RunResult }>;
  bugKeys: string[];
  issueUrls: string[];
  scenarioPrUrl: string | null;
  reportStatus: string;
  scenarioStatus: string;
  archiveStatus: string;
  errorMessage: string | null;
  initialization: boolean;
  specialBlocked: boolean;
  interrupted: boolean;
}

interface IssueCandidateQuery {
  title?: string;
  keywords: string[];
  bugKey?: string;
  limit: number;
}

interface IssueCandidate {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  updatedAt: string;
  matchReasons: string[];
  bugKeys: string[];
  relatedRuns: Array<{
    runId: string;
    result: RunResult;
    scenarioIds: string[];
    targetCommit: string;
    finishedAt: string;
  }>;
}

interface RankedIssueCandidate extends IssueCandidate {
  rank: {
    exactBugKey: boolean;
    exactTitle: boolean;
    keywordHits: number;
  };
}

function validateRunHistoryQuery(value: Record<string, unknown>): RunHistoryQuery {
  const commit = optionalString(value.commit, 40);
  if (commit && !SHA_PATTERN.test(commit)) throw new Error('commit 必须是 40 位 SHA');
  const scenarioId = optionalString(value.scenarioId, 128);
  if (scenarioId && !SCENARIO_ID_PATTERN.test(scenarioId)) throw new Error('scenarioId 格式无效');
  const bugOrIssue = optionalString(value.bugOrIssue, 256);
  const limit = validateLimit(value.limit);
  return {
    ...(commit ? { commit: commit.toLowerCase() } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(bugOrIssue ? { bugOrIssue: normalize(bugOrIssue) } : {}),
    limit,
  };
}

function validateIssueCandidateQuery(value: Record<string, unknown>): IssueCandidateQuery {
  const title = optionalString(value.title, 200);
  const bugKey = optionalString(value.bug_key, 128);
  if (value.keywords !== undefined && !Array.isArray(value.keywords)) {
    throw new Error('keywords 必须是字符串数组');
  }
  const rawKeywords = (value.keywords ?? []) as unknown[];
  if (
    (value.keywords !== undefined && rawKeywords.length === 0) ||
    rawKeywords.length > 8 ||
    rawKeywords.some((keyword) => typeof keyword !== 'string')
  ) {
    throw new Error('keywords 必须包含 1–8 个字符串');
  }
  const keywords = [
    ...new Set(rawKeywords.map((keyword) => normalize(assertString(keyword, 64))).filter(Boolean)),
  ].sort();
  if (keywords.some((keyword) => keyword.length < 2)) {
    throw new Error('每个 keyword 必须为 2–64 个字符');
  }
  if (!title && !bugKey && keywords.length === 0) {
    throw new Error('title、keywords、bug_key 至少提供一个');
  }
  for (const value of [title, bugKey, ...keywords]) {
    if (value && (containsControl(value) || looksLikeSecret(value))) {
      throw new Error('Issue 查询条件包含控制字符或敏感凭据形态');
    }
  }
  return {
    ...(title ? { title: normalize(title) } : {}),
    keywords,
    ...(bugKey ? { bugKey: normalize(bugKey) } : {}),
    limit: validateLimit(value.limit),
  };
}

function queryMatchesBug(
  query: IssueCandidateQuery,
  normalizedKey: string,
  normalizedTitle: string,
): boolean {
  return (
    query.bugKey === normalizedKey ||
    (query.title !== undefined &&
      (query.title.includes(normalizedTitle) || normalizedTitle.includes(query.title))) ||
    query.keywords.some(
      (keyword) => normalizedKey.includes(keyword) || normalizedTitle.includes(keyword),
    )
  );
}

function summarizeStoredRun(run: StoredRun): HistorySummary {
  return {
    runId: run.runId,
    status: 'completed',
    result: run.result,
    trigger: run.trigger,
    request: sanitizeText(run.request, 240),
    baseCommit: run.baseCommit,
    targetCommit: run.targetCommit,
    includedCommits: [...run.includedCommits],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scenarioResults: run.scenarioResults.map((item) => ({ ...item })),
    bugKeys: run.issues.map((issue) => sanitizeText(issue.bugKey, 128)),
    issueUrls: unique(
      run.issues.map((issue) => issue.issueUrl).filter((url): url is string => Boolean(url)),
    ),
    scenarioPrUrl: run.scenarioPrUrl,
    reportStatus: run.reportStatus,
    scenarioStatus: run.scenarioStatus,
    archiveStatus: run.archiveStatus,
    errorMessage: sanitizeNullable(
      run.archiveError ??
        run.scenarioError ??
        run.issues.find((issue) => issue.errorMessage)?.errorMessage,
      500,
    ),
    initialization: run.initialization,
    specialBlocked: run.specialRun && run.result === 'blocked',
    interrupted: false,
  };
}

function historyMatches(run: HistorySummary, query: RunHistoryQuery): boolean {
  if (
    query.commit &&
    ![run.baseCommit, run.targetCommit, ...run.includedCommits].some(
      (commit) => commit?.toLowerCase() === query.commit,
    )
  ) {
    return false;
  }
  if (
    query.scenarioId &&
    !run.scenarioResults.some((scenario) => scenario.id === query.scenarioId)
  ) {
    return false;
  }
  if (query.bugOrIssue) {
    const values = [...run.bugKeys, ...run.issueUrls].map(normalize);
    if (!values.some((value) => value.includes(query.bugOrIssue as string))) return false;
  }
  return true;
}

function compareHistory(left: HistorySummary, right: HistorySummary): number {
  const leftTime = left.finishedAt ?? left.startedAt;
  const rightTime = right.finishedAt ?? right.startedAt;
  return rightTime.localeCompare(leftTime) || right.runId.localeCompare(left.runId);
}

function findIssueCandidates(
  issues: readonly RepositoryIssue[],
  runs: readonly StoredRun[],
  query: IssueCandidateQuery,
): IssueCandidate[] {
  const result: RankedIssueCandidate[] = [];
  for (const issue of issues) {
    const related = relationsForIssue(issue, runs);
    const normalizedTitles = [
      normalize(issue.title),
      ...related.map((item) => normalize(item.issue.title)),
    ];
    const exactBugKey = Boolean(
      query.bugKey && related.some((item) => normalize(item.issue.bugKey) === query.bugKey),
    );
    const exactTitle = Boolean(
      query.title && normalizedTitles.some((title) => title === query.title),
    );
    const containsTitle = Boolean(
      query.title &&
      normalizedTitles.some(
        (title) => title.includes(query.title as string) || query.title?.includes(title),
      ),
    );
    const keywordText = normalize(
      [issue.title, ...related.flatMap((item) => [item.issue.title, item.issue.bugKey])].join(' '),
    );
    const keywordHits = query.keywords.filter((keyword) => keywordText.includes(keyword)).length;
    if (!exactBugKey && !exactTitle && !containsTitle && keywordHits === 0) continue;
    const relatedRuns = uniqueRelatedRuns(related);
    result.push({
      number: issue.number,
      title: sanitizeText(issue.title, 200),
      url: issue.url,
      state: issue.state,
      updatedAt: issue.updatedAt,
      matchReasons: [
        ...(exactBugKey ? ['exact_bug_key'] : []),
        ...(exactTitle ? ['exact_title'] : containsTitle ? ['contains_title'] : []),
        ...(keywordHits > 0 ? [`keyword_hits:${keywordHits}`] : []),
      ],
      bugKeys: unique(related.map((item) => sanitizeText(item.issue.bugKey, 128))),
      relatedRuns,
      rank: { exactBugKey, exactTitle, keywordHits },
    });
  }
  return result
    .sort(
      (left, right) =>
        Number(right.rank.exactBugKey) - Number(left.rank.exactBugKey) ||
        Number(right.rank.exactTitle) - Number(left.rank.exactTitle) ||
        right.rank.keywordHits - left.rank.keywordHits ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.number - left.number,
    )
    .map((candidate) => ({
      number: candidate.number,
      title: candidate.title,
      url: candidate.url,
      state: candidate.state,
      updatedAt: candidate.updatedAt,
      matchReasons: candidate.matchReasons,
      bugKeys: candidate.bugKeys,
      relatedRuns: candidate.relatedRuns,
    }));
}

function relationsForIssue(
  issue: RepositoryIssue,
  runs: readonly StoredRun[],
): Array<{ run: StoredRun; issue: StoredRunIssue }> {
  return runs.flatMap((run) =>
    run.issues
      .filter(
        (stored) =>
          stored.issueNumber === issue.number ||
          sameUrl(stored.issueUrl, issue.url) ||
          sameUrl(stored.requestedIssueUrl, issue.url),
      )
      .map((stored) => ({ run, issue: stored })),
  );
}

function uniqueRelatedRuns(
  relations: Array<{ run: StoredRun; issue: StoredRunIssue }>,
): IssueCandidate['relatedRuns'] {
  const byRun = new Map<string, IssueCandidate['relatedRuns'][number]>();
  for (const { run, issue } of relations) {
    const existing = byRun.get(run.runId);
    const scenarioIds = unique([...(existing?.scenarioIds ?? []), ...issue.scenarioIds]).sort();
    byRun.set(run.runId, {
      runId: run.runId,
      result: run.result,
      scenarioIds,
      targetCommit: run.targetCommit,
      finishedAt: run.finishedAt,
    });
  }
  return [...byRun.values()].sort(
    (left, right) =>
      right.finishedAt.localeCompare(left.finishedAt) || right.runId.localeCompare(left.runId),
  );
}

function validateLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_LIMIT) {
    throw new Error('limit 必须是 1–100 的整数');
  }
  return value as number;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const result = assertString(value, maxLength).trim();
  if (result === '') return undefined;
  if (containsControl(result)) throw new Error('查询文本不能包含控制字符');
  return result;
}

function assertString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength)
    throw new Error('查询文本类型或长度无效');
  return value;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function sanitizeNullable(value: string | null | undefined, maxLength: number): string | null {
  return value ? sanitizeText(value, maxLength) : null;
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^,;\s}]+/gi, '$1[REDACTED]')
    .replace(
      /((?:password|passwd|token|secret|cookie|api[-_]?key)\s*[:=]\s*)[^,;\s}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:github_pat_|gh[opsur]_|sk-)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function looksLikeSecret(value: string): boolean {
  return /(?:authorization\s*[:=]|password\s*[:=]|token\s*[:=]|secret\s*[:=])|\b(?:github_pat_|gh[opsur]_|sk-)|\bAKIA[0-9A-Z]{16}/i.test(
    value,
  );
}

function sameUrl(left: string | null, right: string): boolean {
  return left?.replace(/\/$/, '') === right.replace(/\/$/, '');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '历史查询失败';
}
