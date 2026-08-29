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
  permissions: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
  };
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
          status: 'unknown',
          message:
            branchResult.status === 200
              ? 'Token 具备仓库 push 权限；非 force 分支写入还需通过实际保护规则或安全写入确认'
              : 'Token 具备仓库 push 权限；场景测试分支尚不存在，无法非破坏地确认写入规则',
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
        await this.request(
          `/repos/${this.repository.owner}/${this.repository.name}/pulls?state=open&per_page=1`,
        );
        return {
          status: 'unknown',
          message:
            '已验证仓库读取和 push 权限；GitHub 不提供无副作用的 PR 创建权限探测，因此标记为 unknown',
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
      await this.request(
        `/repos/${this.repository.owner}/${this.repository.name}/issues?state=open&per_page=1`,
      );
      return {
        status: 'unknown',
        message:
          '已验证 Issues 可读取；GitHub 不提供无副作用的 Issue 创建权限探测，因此标记为 unknown',
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
    const response = await this.request(
      `/repos/${this.repository.owner}/${this.repository.name}/issues?state=all&per_page=100`,
    );
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new GitHubApiError(response.status, 'GitHub Issues 读取失败');
    }
    return response.body
      .filter(
        (item): item is Record<string, unknown> => isRecord(item) && !('pull_request' in item),
      )
      .map((item) => ({
        number: typeof item.number === 'number' ? item.number : 0,
        title: readString(item.title, ''),
        state: (item.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
        url: readString(item.html_url, ''),
        createdAt: readString(item.created_at, ''),
        updatedAt: readString(item.updated_at, ''),
      }))
      .filter((issue) => issue.number > 0 && issue.title !== '');
  }

  private async request(path: string): Promise<GitHubResponse> {
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
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: 'GET',
        headers,
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
