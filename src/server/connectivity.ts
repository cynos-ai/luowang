import type Database from 'better-sqlite3';

import type { ConnectivityCheck, ConnectivityResult, ConnectivityStatus } from '../shared/types.js';
import type { ConfigurationStore } from './configuration.js';
import type { RepositoryService } from './repository/service.js';
import { GITHUB_CHECK_IDS, type GithubCheckId } from './repository/github.js';

const TEST_ENVIRONMENT_CHECK = 'test-environment-url';

const GITHUB_CHECKS = [
  { id: 'github-repository-read', label: 'GitHub 仓库读取' },
  { id: 'github-scenario-branch-write', label: '场景测试分支非 force 写入' },
  { id: 'github-pull-request', label: 'GitHub Pull Request 权限' },
  { id: 'github-issue', label: 'GitHub Issue 权限' },
] as const;

const UNREGISTERED_CHECKS = [
  { id: 'provider-model', label: '模型 Provider 与模型' },
  { id: 'playwright-mcp', label: 'Playwright MCP' },
  { id: 'oss', label: 'OSS 测试对象读写' },
] as const;

export interface ConnectivityRegistry {
  list(): ConnectivityCheck[];
  run(checkId: string): Promise<ConnectivityCheck>;
}

interface StoredResult {
  status: ConnectivityStatus;
  message: string;
  checked_at: string;
  latency_ms: number | null;
}

export function createConnectivityRegistry(
  database: Database.Database,
  configuration: ConfigurationStore,
  repository?: RepositoryService,
): ConnectivityRegistry {
  return new DefaultConnectivityRegistry(database, configuration, repository);
}

class DefaultConnectivityRegistry implements ConnectivityRegistry {
  constructor(
    private readonly database: Database.Database,
    private readonly configuration: ConfigurationStore,
    private readonly repository?: RepositoryService,
  ) {}

  list(): ConnectivityCheck[] {
    const repository = this.configuration.getRepository();
    const stored = this.readResult(TEST_ENVIRONMENT_CHECK);
    const testEnvironmentResult = stored
      ? toResult(stored)
      : repository.baseUrl.trim() === ''
        ? emptyResult('not_configured', '测试环境基础 URL 尚未配置')
        : emptyResult('not_checked', '尚未执行检查');

    return [
      {
        id: TEST_ENVIRONMENT_CHECK,
        label: '测试环境基础 URL',
        available: true,
        result: testEnvironmentResult,
      },
      ...GITHUB_CHECKS.map(({ id, label }) => ({
        id,
        label,
        available: this.repository !== undefined,
        result: this.readStoredOrEmpty(id, 'GitHub 检查尚未执行'),
      })),
      ...UNREGISTERED_CHECKS.map(({ id, label }) => ({
        id,
        label,
        available: false,
        result: emptyResult('not_available', '对应能力尚未提供'),
      })),
    ];
  }

  async run(checkId: string): Promise<ConnectivityCheck> {
    if (checkId !== TEST_ENVIRONMENT_CHECK) {
      if ((GITHUB_CHECK_IDS as readonly string[]).includes(checkId)) {
        const label = GITHUB_CHECKS.find((check) => check.id === checkId)?.label ?? checkId;
        if (!this.repository) {
          return {
            id: checkId,
            label,
            available: false,
            result: emptyResult('not_available', '对应能力尚未提供'),
          };
        }
        const result = await this.repository.checkConnectivity(checkId as GithubCheckId);
        this.writeResult(checkId, result);
        return { id: checkId, label, available: true, result };
      }
      if (UNREGISTERED_CHECKS.some((check) => check.id === checkId)) {
        return {
          id: checkId,
          label: UNREGISTERED_CHECKS.find((check) => check.id === checkId)?.label ?? checkId,
          available: false,
          result: emptyResult('not_available', '对应能力尚未提供'),
        };
      }
      return {
        id: checkId,
        label: checkId,
        available: false,
        result: emptyResult('not_available', '对应能力尚未提供'),
      };
    }

    const result = await this.checkTestEnvironment();
    this.writeResult(TEST_ENVIRONMENT_CHECK, result);
    return {
      id: TEST_ENVIRONMENT_CHECK,
      label: '测试环境基础 URL',
      available: true,
      result,
    };
  }

  private async checkTestEnvironment(): Promise<ConnectivityResult> {
    const baseUrl = this.configuration.getRepository().baseUrl.trim();
    if (baseUrl === '') {
      return emptyResult('not_configured', '测试环境基础 URL 尚未配置');
    }

    let url: URL;
    try {
      url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return emptyResult('failed', '测试环境 URL 配置无效');
      }
    } catch {
      return emptyResult('failed', '测试环境 URL 配置无效');
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: '*/*' },
      });
      const latencyMs = Date.now() - startedAt;
      return {
        status: response.status < 500 ? 'ok' : 'failed',
        message: response.status < 500 ? '测试环境可访问' : '测试环境返回服务错误',
        checkedAt: new Date().toISOString(),
        latencyMs,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - startedAt;
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return {
        status: timedOut ? 'timeout' : 'unreachable',
        message: timedOut ? '测试环境检查超时' : '测试环境拒绝连接或不可达',
        checkedAt: new Date().toISOString(),
        latencyMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private readResult(checkId: string): StoredResult | undefined {
    return this.database
      .prepare(
        `SELECT status, message, checked_at, latency_ms
         FROM connectivity_check_results WHERE check_id = ?`,
      )
      .get(checkId) as StoredResult | undefined;
  }

  private readStoredOrEmpty(checkId: string, message: string): ConnectivityResult {
    const stored = this.readResult(checkId);
    return stored ? toResult(stored) : emptyResult('not_checked', message);
  }

  private writeResult(checkId: string, result: ConnectivityResult): void {
    this.database
      .prepare(
        `INSERT INTO connectivity_check_results
           (check_id, status, message, checked_at, latency_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(check_id) DO UPDATE SET
           status = excluded.status,
           message = excluded.message,
           checked_at = excluded.checked_at,
           latency_ms = excluded.latency_ms`,
      )
      .run(
        checkId,
        result.status,
        result.message,
        result.checkedAt ?? new Date().toISOString(),
        result.latencyMs,
      );
  }
}

function toResult(row: StoredResult): ConnectivityResult {
  return {
    status: row.status,
    message: row.message,
    checkedAt: row.checked_at,
    latencyMs: row.latency_ms,
  };
}

function emptyResult(status: ConnectivityStatus, message: string): ConnectivityResult {
  return { status, message, checkedAt: null, latencyMs: null };
}
