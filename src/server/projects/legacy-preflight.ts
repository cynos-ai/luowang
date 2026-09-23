import type Database from 'better-sqlite3';

import { parseGitHubRepository } from '../repository/github.js';

const OWNED_TABLES = [
  'run_store_runs',
  'interrupted_run_records',
  'test_request_queue',
  'indexed_scenarios',
  'indexed_reports',
  'repository_index_errors',
] as const;

type OwnedTable = (typeof OWNED_TABLES)[number];

export interface LegacyProjectPreflight {
  status: 'empty' | 'ready_for_verification' | 'blocked';
  configuredRepository: { owner: string; name: string } | null;
  counts: Record<OwnedTable, number>;
  requiresHistoryOwnershipReview: boolean;
  blockers: string[];
}

/** Read-only inspection. It never assigns historical records to a project. */
export function inspectLegacyProject(database: Database.Database): LegacyProjectPreflight {
  const counts = Object.fromEntries(
    OWNED_TABLES.map((table) => [table, count(database, table)]),
  ) as Record<OwnedTable, number>;
  const blockers: string[] = [];
  const configured = database
    .prepare("SELECT value FROM app_config WHERE key = 'repository'")
    .get() as { value: string } | undefined;
  let repositoryUrl = '';
  if (configured) {
    try {
      const parsed = JSON.parse(configured.value) as unknown;
      if (!isRecord(parsed) || typeof parsed.repository !== 'string') {
        blockers.push('旧仓库配置无法解析');
      } else {
        repositoryUrl = parsed.repository.trim();
      }
    } catch {
      blockers.push('旧仓库配置无法解析');
    }
  }
  const configuredRepository = repositoryUrl
    ? parseRepositoryOrBlock(repositoryUrl, blockers, '旧仓库配置无效')
    : null;

  const indexState = database
    .prepare('SELECT repository FROM repository_index_state WHERE id = 1')
    .get() as { repository: string } | undefined;
  const polledRepository = database
    .prepare("SELECT value FROM automation_state WHERE key = 'git-poller.repository'")
    .get() as { value: string } | undefined;
  for (const [source, value] of [
    ['索引', indexState?.repository],
    ['轮询', polledRepository?.value],
  ] as const) {
    if (!value) continue;
    const observed = parseRepositoryOrBlock(value, blockers, `旧${source}仓库身份无效`);
    if (observed && configuredRepository && !sameRepository(observed, configuredRepository)) {
      blockers.push(`旧${source}仓库与当前配置不一致`);
    }
  }

  const activeQueue = database
    .prepare("SELECT count(*) AS count FROM test_request_queue WHERE status = 'running'")
    .get() as { count: number };
  if (activeQueue.count > 0) blockers.push('旧队列仍有 running 请求，必须先停止服务并确定中断状态');

  if (configuredRepository) {
    const issueUrls = database
      .prepare(
        `SELECT issue_url, requested_issue_url FROM run_store_issues
         WHERE issue_url IS NOT NULL OR requested_issue_url IS NOT NULL`,
      )
      .all() as Array<{ issue_url: string | null; requested_issue_url: string | null }>;
    const scenarioUrls = database
      .prepare('SELECT scenario_pr_url FROM run_store_runs WHERE scenario_pr_url IS NOT NULL')
      .all() as Array<{ scenario_pr_url: string }>;
    const links = [
      ...issueUrls.flatMap((row) => [row.issue_url, row.requested_issue_url]),
      ...scenarioUrls.map((row) => row.scenario_pr_url),
    ].filter((url): url is string => Boolean(url));
    if (links.some((url) => !sameGitHubArtifactRepository(url, configuredRepository))) {
      blockers.push('旧 Issue/PR 链接包含无效或其他仓库的地址');
    }
  }

  const hasOwnedData =
    Object.values(counts).some((value) => value > 0) ||
    Boolean(indexState) ||
    Boolean(polledRepository);
  const progress = database
    .prepare('SELECT last_completed_target FROM run_store_progress WHERE id = 1')
    .get() as { last_completed_target: string | null } | undefined;
  const requiresHistoryOwnershipReview =
    counts.run_store_runs > 0 ||
    counts.interrupted_run_records > 0 ||
    counts.test_request_queue > 0 ||
    Boolean(progress?.last_completed_target);
  if ((hasOwnedData || Boolean(progress?.last_completed_target)) && !configuredRepository) {
    blockers.push('存在旧项目数据，但仓库身份未配置或无效');
  }
  if (requiresHistoryOwnershipReview) {
    blockers.push('旧 Run/请求没有逐条仓库 ID，数据库本身无法证明全部历史的唯一归属');
  }
  if (blockers.length > 0) {
    return {
      status: 'blocked',
      configuredRepository,
      counts,
      requiresHistoryOwnershipReview,
      blockers,
    };
  }
  return {
    status: configuredRepository ? 'ready_for_verification' : 'empty',
    configuredRepository,
    counts,
    requiresHistoryOwnershipReview,
    blockers,
  };
}

function count(database: Database.Database, table: OwnedTable): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function parseRepositoryOrBlock(
  url: string,
  blockers: string[],
  message: string,
): { owner: string; name: string } | null {
  try {
    return parseGitHubRepository(url);
  } catch {
    blockers.push(message);
    return null;
  }
}

function sameRepository(
  left: { owner: string; name: string },
  right: { owner: string; name: string },
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function sameGitHubArtifactRepository(
  value: string,
  repository: { owner: string; name: string },
): boolean {
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
      sameRepository({ owner: parts[0], name: parts[1] }, repository) &&
      (parts[2] === 'issues' || parts[2] === 'pull') &&
      /^[1-9][0-9]*$/.test(parts[3])
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
