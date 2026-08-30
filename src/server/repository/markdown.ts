import { parse } from 'yaml';

import type {
  ConfirmedBugSummary,
  RunResult,
  ScenarioResultSummary,
  ScenarioStatus,
} from '../../shared/types.js';
import { RepositoryError } from './errors.js';

const SCENARIO_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SCENARIO_STATUSES = new Set<ScenarioStatus>(['draft', 'approved', 'deprecated']);
const RUN_RESULTS = new Set<RunResult>(['passed', 'failed', 'blocked']);
const TRIGGERS = new Set(['git', 'schedule', 'manual', 'api']);

export interface ParsedScenario {
  id: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  tags: string[];
}

export interface ParsedReport {
  runId: string;
  trigger: 'git' | 'schedule' | 'manual' | 'api';
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  result: RunResult;
  startedAt: string;
  finishedAt: string;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
}

export function parseScenarioMarkdown(content: string, path: string): ParsedScenario {
  const data = parseFrontmatter(content, path);
  assertKnownKeys(data, ['id', 'name', 'description', 'status', 'tags'], path);
  const id = readString(data.id, 'id', path);
  if (!SCENARIO_ID_PATTERN.test(id) || id.length > 128) {
    throw invalid(path, '场景 id 必须是大写字母/数字与连字符组成的稳定 ID');
  }
  const name = readNonEmptyString(data.name, 'name', path, 200);
  const description = readNonEmptyString(data.description, 'description', path, 2_000);
  const status = readString(data.status, 'status', path) as ScenarioStatus;
  if (!SCENARIO_STATUSES.has(status))
    throw invalid(path, 'status 必须是 draft、approved 或 deprecated');
  if (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== 'string')) {
    throw invalid(path, 'tags 必须是字符串数组');
  }
  const tags = data.tags.map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > 50 || tags.some((tag) => tag.length > 100))
    throw invalid(path, 'tags 数量或长度超出限制');
  if (new Set(tags).size !== tags.length) throw invalid(path, 'tags 不能重复');
  return { id, name, description, status, tags };
}

export function parseReportMarkdown(
  content: string,
  path: string,
  expectedRunId: string,
): ParsedReport {
  const data = parseFrontmatter(content, path);
  assertKnownKeys(
    data,
    [
      'run_id',
      'trigger',
      'base_commit',
      'target_commit',
      'included_commits',
      'result',
      'started_at',
      'finished_at',
      'scenario_results',
      'confirmed_bugs',
    ],
    path,
  );
  const runId = readString(data.run_id, 'run_id', path);
  if (!RUN_ID_PATTERN.test(runId) || runId !== expectedRunId) {
    throw invalid(path, 'run_id 必须与报告目录名一致且格式有效');
  }
  const trigger = readString(data.trigger, 'trigger', path) as ParsedReport['trigger'];
  if (!TRIGGERS.has(trigger)) throw invalid(path, 'trigger 不是支持的值');
  const baseCommit = readNullableSha(data.base_commit, 'base_commit', path);
  const targetCommit = readSha(data.target_commit, 'target_commit', path);
  const includedCommits = readShaArray(data.included_commits, 'included_commits', path);
  const result = readString(data.result, 'result', path) as RunResult;
  if (!RUN_RESULTS.has(result)) throw invalid(path, 'result 必须是 passed、failed 或 blocked');
  const startedAt = readIsoDate(data.started_at, 'started_at', path);
  const finishedAt = readIsoDate(data.finished_at, 'finished_at', path);
  const scenarioResults = readScenarioResults(data.scenario_results, path);
  const confirmedBugs = readConfirmedBugs(data.confirmed_bugs, path);
  return {
    runId,
    trigger,
    baseCommit,
    targetCommit,
    includedCommits,
    result,
    startedAt,
    finishedAt,
    scenarioResults,
    confirmedBugs,
  };
}

export function parseFrontmatter(content: string, path: string): Record<string, unknown> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') throw invalid(path, '缺少 Markdown frontmatter 起始标记');
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) throw invalid(path, '缺少 Markdown frontmatter 结束标记');
  try {
    const data = parse(lines.slice(1, closing).join('\n')) as unknown;
    if (!isRecord(data)) throw invalid(path, 'frontmatter 必须是对象');
    return data;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw invalid(path, 'frontmatter YAML 无效');
  }
}

function readScenarioResults(value: unknown, path: string): ScenarioResultSummary[] {
  if (!Array.isArray(value)) throw invalid(path, 'scenario_results 必须是数组');
  return value.map((item, index) => {
    if (!isRecord(item)) throw invalid(path, `scenario_results[${index}] 必须是对象`);
    const id = readString(item.id, `scenario_results[${index}].id`, path);
    const result = readString(item.result, `scenario_results[${index}].result`, path) as RunResult;
    if (!SCENARIO_ID_PATTERN.test(id) || !RUN_RESULTS.has(result)) {
      throw invalid(path, `scenario_results[${index}] 字段无效`);
    }
    return { id, result };
  });
}

function readConfirmedBugs(value: unknown, path: string): ConfirmedBugSummary[] {
  if (!Array.isArray(value)) throw invalid(path, 'confirmed_bugs 必须是数组');
  return value.map((item, index) => {
    if (!isRecord(item)) throw invalid(path, `confirmed_bugs[${index}] 必须是对象`);
    const key = readNonEmptyString(item.key, `confirmed_bugs[${index}].key`, path, 128);
    const title = readNonEmptyString(item.title, `confirmed_bugs[${index}].title`, path, 500);
    if (
      !Array.isArray(item.scenario_ids) ||
      item.scenario_ids.some((id) => typeof id !== 'string')
    ) {
      throw invalid(path, `confirmed_bugs[${index}].scenario_ids 必须是字符串数组`);
    }
    const scenarioIds = item.scenario_ids.map((id) => id.trim()).filter(Boolean);
    const issueAction = readString(
      item.issue_action,
      `confirmed_bugs[${index}].issue_action`,
      path,
    );
    if (issueAction !== 'create' && issueAction !== 'link') {
      throw invalid(path, `confirmed_bugs[${index}].issue_action 无效`);
    }
    const issueUrl =
      item.issue_url === undefined
        ? undefined
        : readNonEmptyString(item.issue_url, `confirmed_bugs[${index}].issue_url`, path, 2_000);
    if (issueAction === 'link' && !issueUrl)
      throw invalid(path, `confirmed_bugs[${index}] link 必须提供 issue_url`);
    return { key, title, scenarioIds, issueAction, ...(issueUrl ? { issueUrl } : {}) };
  });
}

function readShaArray(value: unknown, field: string, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !SHA_PATTERN.test(item))
  ) {
    throw invalid(path, `${field} 必须是 SHA 数组`);
  }
  return value.map((item) => item.toLowerCase());
}

function readNullableSha(value: unknown, field: string, path: string): string | null {
  if (value === null) return null;
  return readSha(value, field, path);
}

function readSha(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value))
    throw invalid(path, `${field} 必须是 40 位 commit SHA`);
  return value.toLowerCase();
}

function readIsoDate(value: unknown, field: string, path: string): string {
  const result = readString(value, field, path);
  if (Number.isNaN(Date.parse(result))) throw invalid(path, `${field} 必须是有效 ISO 时间`);
  return result;
}

function readString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid(path, `${field} 必须是非空字符串`);
  return value.trim();
}

function readNonEmptyString(
  value: unknown,
  field: string,
  path: string,
  maxLength: number,
): string {
  const result = readString(value, field, path);
  if (result.length > maxLength) throw invalid(path, `${field} 超出长度限制`);
  return result;
}

function assertKnownKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalid(path, `frontmatter 包含未知字段：${unknown.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): RepositoryError {
  return new RepositoryError('INDEX_UNAVAILABLE', `${path}：${message}`, 422);
}
