import type Database from 'better-sqlite3';

import type { ConnectivityCheck, ConnectivityResult, ConnectivityStatus } from '../shared/types.js';
import type { ConfigurationStore } from './configuration.js';
import type { ProviderAdapter } from './runs/provider.js';
import type { RepositoryService } from './repository/service.js';
import { GITHUB_CHECK_IDS, type GithubCheckId } from './repository/github.js';
import type { BrowserMcpAdapter } from './browser/playwright-mcp.js';
import type { OssAdapter } from './storage/oss.js';

const TEST_ENVIRONMENT_CHECK = 'test-environment-url';

const GITHUB_CHECKS = [
  { id: 'github-repository-read', label: 'GitHub 仓库读取' },
  { id: 'github-scenario-branch-write', label: '场景测试分支写入前提' },
  { id: 'github-pull-request', label: 'GitHub Pull Request 权限' },
  { id: 'github-issue', label: 'GitHub Issue 权限' },
] as const;

const ADAPTER_CHECKS = [
  { id: 'playwright-mcp', label: 'Playwright MCP' },
  { id: 'oss', label: 'OSS 测试对象读写' },
] as const;

export interface ConnectivityRegistry {
  list(): ConnectivityCheck[];
  run(checkId: string): Promise<ConnectivityCheck>;
  runAll(): Promise<ConnectivityCheck[]>;
  invalidate?(checkIds: readonly string[]): void;
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
  provider?: ProviderAdapter,
  browser?: BrowserMcpAdapter,
  oss?: OssAdapter,
): ConnectivityRegistry {
  return new DefaultConnectivityRegistry(
    database,
    configuration,
    repository,
    provider,
    browser,
    oss,
  );
}

class DefaultConnectivityRegistry implements ConnectivityRegistry {
  constructor(
    private readonly database: Database.Database,
    private readonly configuration: ConfigurationStore,
    private readonly repository?: RepositoryService,
    private readonly provider?: ProviderAdapter,
    private readonly browser?: BrowserMcpAdapter,
    private readonly oss?: OssAdapter,
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
      ...ADAPTER_CHECKS.map(({ id, label }) => {
        const available =
          id === 'playwright-mcp' ? isBrowserAvailable(this.browser) : isOssAvailable(this.oss);
        return {
          id,
          label,
          available,
          result: available
            ? this.readStoredOrEmpty(id, `${label} 检查尚未执行`)
            : emptyResult('not_available', '对应能力尚未提供'),
        };
      }),
      {
        id: 'provider-model',
        label: '模型 Provider 与模型',
        available: this.provider !== undefined,
        result: this.provider
          ? this.readStoredOrEmpty('provider-model', 'Provider 检查尚未执行')
          : emptyResult('not_available', '对应能力尚未提供'),
      },
    ];
  }

  invalidate(checkIds: readonly string[]): void {
    const uniqueIds = [...new Set(checkIds)];
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => '?').join(', ');
    this.database
      .prepare(`DELETE FROM connectivity_check_results WHERE check_id IN (${placeholders})`)
      .run(...uniqueIds);
  }

  async runAll(): Promise<ConnectivityCheck[]> {
    const results: ConnectivityCheck[] = [];
    for (const check of this.list()) {
      if (!check.available) {
        results.push(check);
        continue;
      }
      try {
        results.push(await this.run(check.id));
      } catch {
        const result = emptyResult('failed', '检查执行失败，请查看服务日志并重试');
        this.writeResult(check.id, result);
        results.push({ ...check, result });
      }
    }
    return results;
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
      if (checkId === 'provider-model') {
        if (!this.provider) {
          return {
            id: checkId,
            label: '模型 Provider 与模型',
            available: false,
            result: emptyResult('not_available', '对应能力尚未提供'),
          };
        }
        const result = await this.provider.checkConnectivity();
        this.writeResult(checkId, result);
        return { id: checkId, label: '模型 Provider 与模型', available: true, result };
      }
      if (checkId === 'playwright-mcp') {
        if (!isBrowserAvailable(this.browser)) {
          return {
            id: checkId,
            label: 'Playwright MCP',
            available: false,
            result: emptyResult('not_available', 'Playwright MCP 尚未启用'),
          };
        }
        const result = await this.browser!.checkConnectivity();
        this.writeResult(checkId, result);
        return { id: checkId, label: 'Playwright MCP', available: true, result };
      }
      if (checkId === 'oss') {
        if (!isOssAvailable(this.oss)) {
          return {
            id: checkId,
            label: 'OSS 测试对象读写',
            available: false,
            result: emptyResult('not_available', '对应能力尚未提供'),
          };
        }
        const result = await this.oss!.checkConnectivity();
        this.writeResult(checkId, result);
        return { id: checkId, label: 'OSS 测试对象读写', available: true, result };
      }
      if (ADAPTER_CHECKS.some((check) => check.id === checkId)) {
        return {
          id: checkId,
          label: ADAPTER_CHECKS.find((check) => check.id === checkId)?.label ?? checkId,
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

function isBrowserAvailable(browser: BrowserMcpAdapter | undefined): boolean {
  try {
    return browser?.isEnabled() ?? false;
  } catch {
    return false;
  }
}

function isOssAvailable(oss: OssAdapter | undefined): boolean {
  try {
    return oss?.isConfigured() ?? false;
  } catch {
    return false;
  }
}
