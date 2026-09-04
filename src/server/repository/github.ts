import type { RepositoryIssue } from '../../shared/types.js';
import { RepositoryError } from './errors.js';

export const GITHUB_CHECK_IDS = [
  'github-repository-read',
  'github-scenario-branch-write',
  'github-pull-request',
  'github-issue',
] as const;

export type GithubCheckId = (typeof GITHUB_CHECK_IDS)[number];

export interface GitHubRepositoryInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  hasIssues: boolean;
  oauthScopes: string[];
  permissions: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
  };
}

export interface GitHubPullRequest {
  number: number;
  url: string;
}

interface GitHubClientOptions {
  repositoryUrl: string;
  tokenProvider?: () => string | undefined;
  apiBaseUrl?: string;
}

interface GitHubResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

interface GitHubIssuePayload {
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export class GitHubClient {
  private readonly repository: { owner: string; name: string };
  private readonly tokenProvider?: () => string | undefined;
  private readonly apiBaseUrl: string;

  constructor(options: GitHubClientOptions) {
    this.repository = parseGitHubRepository(options.repositoryUrl);
    this.tokenProvider = options.tokenProvider;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async readRepository(): Promise<GitHubRepositoryInfo> {
    const response = await this.request(`/repos/${this.repository.owner}/${this.repository.name}`);
    if (response.status !== 200 || !isRecord(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub 仓库读取失败');
    }
    const permissions = isRecord(response.body.permissions) ? response.body.permissions : {};
    return {
      fullName: readString(
        response.body.full_name,
        `${this.repository.owner}/${this.repository.name}`,
      ),
      defaultBranch: readString(response.body.default_branch, 'main'),
      private: response.body.private === true,
      hasIssues: response.body.has_issues !== false,
      oauthScopes: readOauthScopes(response.headers),
      permissions: {
        admin: permissions.admin === true,
        push: permissions.push === true,
        pull: permissions.pull === true,
      },
    };
  }

  async check(
    checkId: GithubCheckId,
    branch: string,
  ): Promise<{
    status: 'ok' | 'failed' | 'unknown' | 'not_configured';
    message: string;
    latencyMs: number;
  }> {
    const startedAt = Date.now();
    if (!this.tokenProvider?.()) {
      return {
        status: 'not_configured',
        message: 'GitHub Token 尚未配置',
        latencyMs: Date.now() - startedAt,
      };
    }
    try {
      const repository = await this.readRepository();
      if (checkId === 'github-repository-read') {
        return {
          status: 'ok',
          message: `已读取 ${repository.fullName}`,
          latencyMs: Date.now() - startedAt,
        };
      }
      if (checkId === 'github-scenario-branch-write') {
        if (!repository.permissions.push) {
          return {
            status: 'failed',
            message: 'Token 没有仓库写入权限',
            latencyMs: Date.now() - startedAt,
          };
        }
        const branchResult = await this.request(
          `/repos/${this.repository.owner}/${this.repository.name}/branches/${encodeURIComponent(branch)}`,
        );
        if (branchResult.status !== 200 && branchResult.status !== 404) {
          throw new GitHubApiError(branchResult.status, '场景测试分支读取失败');
        }
        return {
          status: 'ok',
          message:
            branchResult.status === 200
              ? 'Token 具备仓库 push 权限；罗网发布时仍使用 non-force/CAS 并校验分支保护结果'
              : 'Token 具备仓库 push 权限；场景测试分支尚不存在，首次创建仍使用 non-force/CAS',
          latencyMs: Date.now() - startedAt,
        };
      }
      if (checkId === 'github-pull-request') {
        if (!repository.permissions.push) {
          return {
            status: 'failed',
            message: 'Token 没有仓库写入权限，无法确认 PR 写入能力',
            latencyMs: Date.now() - startedAt,
          };
        }
        const pullRequestResult = await this.request(
          `/repos/${this.repository.owner}/${this.repository.name}/pulls?state=open&per_page=1`,
        );
        if (pullRequestResult.status !== 200) {
          throw new GitHubApiError(pullRequestResult.status, 'GitHub Pull Request 读取失败');
        }
        if (hasClassicRepositoryWriteScope(repository)) {
          return {
            status: 'ok',
            message: '已验证仓库 push 权限、PR 读取和 classic PAT 仓库写 scope',
            latencyMs: Date.now() - startedAt,
          };
        }
        return {
          status: 'unknown',
          message:
            '仓库允许 push 和读取 PR，但当前 Token 未公开可验证的 classic PAT 写 scope；为避免创建测试 PR，无法无副作用确认',
          latencyMs: Date.now() - startedAt,
        };
      }
      if (!repository.hasIssues) {
        return {
          status: 'failed',
          message: '该仓库未启用 Issues',
          latencyMs: Date.now() - startedAt,
        };
      }
      const issueResult = await this.request(
        `/repos/${this.repository.owner}/${this.repository.name}/issues?state=open&per_page=1`,
      );
      if (issueResult.status !== 200) {
        throw new GitHubApiError(issueResult.status, 'GitHub Issues 读取失败');
      }
      if (hasClassicRepositoryWriteScope(repository)) {
        return {
          status: 'ok',
          message: '已验证 Issues 已启用、可读取且 classic PAT 具备仓库写 scope',
          latencyMs: Date.now() - startedAt,
        };
      }
      return {
        status: 'unknown',
        message:
          'Issues 已启用且可读取，但当前 Token 未公开可验证的 classic PAT 写 scope；为避免创建测试 Issue，无法无副作用确认',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const status = error instanceof GitHubApiError ? error.status : 0;
      return {
        status: 'failed',
        message:
          status === 401 || status === 403 ? 'GitHub Token 无效或权限不足' : 'GitHub 暂时不可达',
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async listIssues(): Promise<RepositoryIssue[]> {
    return (await this.listIssuePayloads()).map(toRepositoryIssue);
  }

  async findIssuesByMarkers(markers: readonly string[]): Promise<RepositoryIssue[]> {
    if (markers.length === 0) return [];
    const normalizedMarkers = markers.map((marker) => marker.trim()).filter(Boolean);
    if (normalizedMarkers.length !== markers.length) {
      throw new RepositoryError('ISSUE_URL_INVALID', 'Issue 标记不能为空', 400);
    }
    return (await this.listIssuePayloads())
      .filter((issue) => normalizedMarkers.every((marker) => issue.body.includes(marker)))
      .map(toRepositoryIssue);
  }

  async createIssue(title: string, body: string): Promise<RepositoryIssue> {
    if (title.trim() === '' || body.trim() === '') {
      throw new RepositoryError('ISSUE_CREATE_FAILED', 'Issue 标题和正文不能为空', 400);
    }
    const response = await this.request(
      `/repos/${this.repository.owner}/${this.repository.name}/issues`,
      { method: 'POST', body: JSON.stringify({ title, body }) },
    );
    if (response.status !== 201 || !isRecord(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub Issue 创建失败');
    }
    const issue = toIssuePayload(response.body);
    if (!issue) throw new GitHubApiError(response.status, 'GitHub Issue 响应无效');
    return toRepositoryIssue(issue);
  }

  async findPullRequest(head: string, base: string): Promise<GitHubPullRequest | null> {
    const response = await this.request(
      `/repos/${this.repository.owner}/${this.repository.name}/pulls?state=open&head=${encodeURIComponent(`${this.repository.owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=10`,
    );
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub Pull Request 查询失败');
    }
    for (const item of response.body) {
      if (!isRecord(item)) continue;
      const url = readString(item.html_url, '');
      const number = typeof item.number === 'number' ? item.number : 0;
      if (number > 0 && isPullRequestUrl(url, this.repository)) return { number, url };
    }
    return null;
  }

  async createPullRequest(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequest> {
    if (title.trim() === '' || body.trim() === '' || head.trim() === '' || base.trim() === '') {
      throw new RepositoryError('SCENARIO_PR_CREATE_FAILED', '场景 PR 参数不能为空', 400);
    }
    const response = await this.request(
      `/repos/${this.repository.owner}/${this.repository.name}/pulls`,
      { method: 'POST', body: JSON.stringify({ title, body, head, base }) },
    );
    if (response.status !== 201 || !isRecord(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub 场景 PR 创建失败');
    }
    const url = readString(response.body.html_url, '');
    const number = typeof response.body.number === 'number' ? response.body.number : 0;
    if (number <= 0 || !isPullRequestUrl(url, this.repository)) {
      throw new GitHubApiError(response.status, 'GitHub 场景 PR 响应无效');
    }
    return { number, url };
  }

  async getIssueByUrl(issueUrl: string): Promise<RepositoryIssue> {
    const number = parseGitHubIssueUrl(issueUrl, this.repository);
    const response = await this.request(
      `/repos/${this.repository.owner}/${this.repository.name}/issues/${number}`,
    );
    if (response.status === 404) {
      throw new RepositoryError('ISSUE_NOT_FOUND', '指定的 GitHub Issue 不存在', 404);
    }
    if (response.status !== 200 || !isRecord(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub Issue 读取失败');
    }
    if ('pull_request' in response.body) {
      throw new RepositoryError('ISSUE_URL_INVALID', 'issue_url 不能指向 Pull Request', 400);
    }
    const issue = toIssuePayload(response.body);
    if (!issue) throw new GitHubApiError(response.status, 'GitHub Issue 响应无效');
    return toRepositoryIssue(issue);
  }

  private async listIssuePayloads(): Promise<GitHubIssuePayload[]> {
    const issues: GitHubIssuePayload[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const query = page === 1 ? '' : `&page=${page}`;
      const response = await this.request(
        `/repos/${this.repository.owner}/${this.repository.name}/issues?state=all&per_page=100${query}`,
      );
      if (response.status !== 200 || !Array.isArray(response.body)) {
        throw new GitHubApiError(response.status, 'GitHub Issues 读取失败');
      }
      issues.push(
        ...response.body
          .filter(
            (item): item is Record<string, unknown> => isRecord(item) && !('pull_request' in item),
          )
          .map(toIssuePayload)
          .filter((issue): issue is GitHubIssuePayload => issue !== null),
      );
      if (response.body.length < 100) break;
    }
    return issues;
  }

  private async request(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: string } = {},
  ): Promise<GitHubResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const token = this.tokenProvider?.();
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'luowang-repository-service',
      };
      if (token) headers.authorization = `Bearer ${token}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        redirect: 'error',
        signal: controller.signal,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(0, 'GitHub 请求失败');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseGitHubRepository(value: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError('REPOSITORY_INVALID', 'GitHub 仓库 URL 无效', 400);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password
  ) {
    throw new RepositoryError(
      'REPOSITORY_INVALID',
      '目前只支持不带凭据的 HTTPS GitHub 仓库 URL',
      400,
    );
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new RepositoryError('REPOSITORY_INVALID', 'GitHub 仓库 URL 必须包含组织和仓库名', 400);
  }
  const name = parts[1].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new RepositoryError('REPOSITORY_INVALID', 'GitHub 仓库名包含不支持的字符', 400);
  }
  return { owner: parts[0], name };
}

export function isGitHubRepository(value: string): boolean {
  try {
    parseGitHubRepository(value);
    return true;
  } catch {
    return false;
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function readOauthScopes(headers: Headers): string[] {
  return (headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function hasClassicRepositoryWriteScope(repository: GitHubRepositoryInfo): boolean {
  return (
    repository.oauthScopes.includes('repo') ||
    (!repository.private && repository.oauthScopes.includes('public_repo'))
  );
}

function toIssuePayload(value: Record<string, unknown>): GitHubIssuePayload | null {
  const number = typeof value.number === 'number' ? value.number : 0;
  const title = readString(value.title, '');
  const url = readString(value.html_url, '');
  if (number <= 0 || title === '' || url === '') return null;
  return {
    number,
    title,
    state: (value.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
    url,
    createdAt: readString(value.created_at, ''),
    updatedAt: readString(value.updated_at, ''),
    body: readString(value.body, ''),
  };
}

function toRepositoryIssue(issue: GitHubIssuePayload): RepositoryIssue {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function parseGitHubIssueUrl(value: string, repository: { owner: string; name: string }): number {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError('ISSUE_URL_INVALID', 'issue_url 不是有效的 GitHub Issue URL', 400);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 4 ||
    parts[0]?.toLowerCase() !== repository.owner.toLowerCase() ||
    parts[1]?.toLowerCase() !== repository.name.toLowerCase() ||
    parts[2] !== 'issues' ||
    !/^\d+$/.test(parts[3] ?? '')
  ) {
    throw new RepositoryError(
      'ISSUE_URL_INVALID',
      'issue_url 必须指向当前 GitHub 仓库的 Issue',
      400,
    );
  }
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RepositoryError('ISSUE_URL_INVALID', 'issue_url 中的 Issue 编号无效', 400);
  }
  return number;
}

function isPullRequestUrl(value: string, repository: { owner: string; name: string }): boolean {
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
      parts[0]?.toLowerCase() === repository.owner.toLowerCase() &&
      parts[1]?.toLowerCase() === repository.name.toLowerCase() &&
      parts[2] === 'pull' &&
      /^\d+$/.test(parts[3] ?? '')
    );
  } catch {
    return false;
  }
}
