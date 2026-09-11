import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createTextResult } from './agent-session.js';

export interface TestDataEntry {
  id: string;
  scenarioId?: string;
  description?: string;
  cleanupScope?: 'website-accounts';
}

export class UnsupportedCleanupScopeError extends Error {}

export interface TestDataVerificationReceipt {
  sourceId: string;
  sourceKind: 'cleanup-adapter';
  runId: string;
  dataId: string;
  queriedAt: string;
  absent: boolean;
  statusCode?: number;
  exitCode?: number;
  summary: string;
  sha256: string;
}

export interface TestDataAdapterObservation {
  absent: boolean;
  content: string;
  statusCode?: number;
  exitCode?: number;
}

export interface TestDataCleanupAdapter {
  id: string;
  cleanupAndVerify(
    input: Readonly<{ runId: string; entry: TestDataEntry }>,
  ): Promise<TestDataAdapterObservation>;
}

export interface TestDataRecord extends TestDataEntry {
  status: 'registered' | 'verified-cleaned' | 'rejected';
  registeredAt: string;
  verification?: TestDataVerificationReceipt;
  rejectionReason?: string;
}

export interface TestDataCleanupResult {
  ok: boolean;
  attempted: number;
  failed: string[];
  message: string;
  receipts: TestDataVerificationReceipt[];
}

export interface TestDataFinalResult {
  ok: boolean;
  pending: Array<Pick<TestDataRecord, 'id' | 'scenarioId' | 'status' | 'rejectionReason'>>;
  message: string;
}

export interface TestDataManager {
  /** Adapter configuration, not proof of successful cleanup; omitted means unknown. */
  readonly cleanupAvailable?: boolean;
  prefix(runId: string): string;
  register(runId: string, entry: TestDataEntry): Promise<void>;
  pending(runId: string): TestDataRecord[];
  cleanup(runId: string): Promise<TestDataCleanupResult>;
  finalize(runId: string): TestDataFinalResult;
}

export interface TestDataManagerOptions {
  cleanupAdapter?: TestDataCleanupAdapter;
  now?: () => Date;
}

export function createTestDataManager(options: TestDataManagerOptions = {}): TestDataManager {
  return new DefaultTestDataManager(options);
}

class DefaultTestDataManager implements TestDataManager {
  private readonly entries = new Map<string, Map<string, TestDataRecord>>();
  private readonly now: () => Date;

  constructor(private readonly options: TestDataManagerOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.cleanupAdapter && !/^[a-z][a-z0-9-]{0,63}$/.test(options.cleanupAdapter.id)) {
      throw new Error('测试数据适配器 ID 无效');
    }
  }

  get cleanupAvailable(): boolean {
    return this.options.cleanupAdapter !== undefined;
  }

  prefix(runId: string): string {
    return `luowang-${runId}-`;
  }

  async register(runId: string, entry: TestDataEntry): Promise<void> {
    const id = entry.id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) || !id.startsWith(this.prefix(runId))) {
      throw new Error('测试数据标识必须有效且使用当前 Run 前缀');
    }
    if (entry.cleanupScope !== undefined && entry.cleanupScope !== 'website-accounts') {
      throw new Error('测试数据清理资源域无效');
    }
    const entries = this.entries.get(runId) ?? new Map<string, TestDataRecord>();
    if (!entries.has(id)) {
      entries.set(id, {
        id,
        ...(entry.cleanupScope ? { cleanupScope: entry.cleanupScope } : {}),
        ...(entry.scenarioId ? { scenarioId: normalizeShortText(entry.scenarioId, 200) } : {}),
        ...(entry.description
          ? { description: redactSensitiveText(normalizeShortText(entry.description, 500)) }
          : {}),
        status: 'registered',
        registeredAt: this.now().toISOString(),
      });
      this.entries.set(runId, entries);
    }
  }

  pending(runId: string): TestDataRecord[] {
    return [...(this.entries.get(runId)?.values() ?? [])]
      .filter((entry) => entry.status !== 'verified-cleaned')
      .map((entry) => ({
        ...entry,
        ...(entry.verification ? { verification: { ...entry.verification } } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async cleanup(runId: string): Promise<TestDataCleanupResult> {
    const entries = [...(this.entries.get(runId)?.values() ?? [])].filter(
      (entry) => entry.status !== 'verified-cleaned',
    );
    if (!entries.length)
      return { ok: true, attempted: 0, failed: [], receipts: [], message: '没有待清理的测试数据' };
    const adapter = this.options.cleanupAdapter;
    if (!adapter)
      return {
        ok: false,
        attempted: 0,
        failed: entries.map((entry) => entry.id),
        receipts: [],
        message: '没有配置测试数据清理适配器；残留待人工处理',
      };
    const failed: string[] = [];
    const receipts: TestDataVerificationReceipt[] = [];
    for (const entry of entries) {
      try {
        const observation = await adapter.cleanupAndVerify({
          runId,
          entry: {
            id: entry.id,
            ...(entry.cleanupScope ? { cleanupScope: entry.cleanupScope } : {}),
            ...(entry.scenarioId ? { scenarioId: entry.scenarioId } : {}),
            ...(entry.description ? { description: entry.description } : {}),
          },
        });
        if (
          typeof observation.content !== 'string' ||
          Buffer.byteLength(observation.content, 'utf8') > 256 * 1024
        )
          throw new Error('清理查询响应无效');
        const content = redactSensitiveText(observation.content).slice(0, 64 * 1024);
        const receipt: TestDataVerificationReceipt = {
          sourceId: adapter.id,
          sourceKind: 'cleanup-adapter',
          runId,
          dataId: entry.id,
          queriedAt: this.now().toISOString(),
          absent: observation.absent === true,
          ...(Number.isInteger(observation.statusCode) &&
          observation.statusCode! >= 100 &&
          observation.statusCode! <= 599
            ? { statusCode: observation.statusCode }
            : {}),
          ...(Number.isInteger(observation.exitCode) ? { exitCode: observation.exitCode } : {}),
          summary: content.replace(/\s+/g, ' ').trim().slice(0, 240),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        };
        receipts.push(receipt);
        entry.verification = receipt;
        if (receipt.absent) {
          entry.status = 'verified-cleaned';
          delete entry.rejectionReason;
        } else {
          entry.status = 'rejected';
          entry.rejectionReason = '清理适配器独立查询确认数据仍存在';
          failed.push(entry.id);
        }
      } catch (error) {
        entry.status = 'rejected';
        entry.rejectionReason =
          error instanceof UnsupportedCleanupScopeError
            ? '登记数据未绑定受支持的清理资源域；残留待人工处理'
            : '清理适配器执行或独立查询失败';
        failed.push(entry.id);
      }
    }
    return {
      ok: failed.length === 0,
      attempted: entries.length,
      failed,
      receipts,
      message: failed.length
        ? `有 ${failed.length} 项测试数据未通过清理适配器核验`
        : `清理适配器已独立核验 ${entries.length} 项测试数据不存在`,
    };
  }

  finalize(runId: string): TestDataFinalResult {
    const pending = this.pending(runId).map(({ id, scenarioId, status, rejectionReason }) => ({
      id,
      ...(scenarioId ? { scenarioId } : {}),
      status,
      ...(rejectionReason ? { rejectionReason } : {}),
    }));
    return {
      ok: pending.length === 0,
      pending,
      message: pending.length
        ? `仍有 ${pending.length} 项测试数据未确认清理`
        : '全部登记测试数据均已独立核验清理',
    };
  }
}

export function createTestDataTools(
  manager: TestDataManager,
  runId: string,
  scenarioId?: string,
): ToolDefinition[] {
  const cleanupNote =
    manager.cleanupAvailable === true
      ? '已配置受控清理适配器；是否清理成功以最终收尾核验为准，登记不代表已清理。'
      : manager.cleanupAvailable === false
        ? '未配置清理适配器；Harness 无法自动删除登记数据，只会保留未完成告警，不要假定数据会被自动清理。'
        : '清理适配器能力未确认；不要假定数据会被自动清理，以最终收尾核验为准。';
  const parameters = Type.Object(
    {
      id: Type.String({ description: '当前 Run 创建的测试数据标识，不含凭据' }),
      description: Type.Optional(Type.String()),
      cleanupScope: Type.Optional(
        Type.Literal('website-accounts', {
          description:
            '仅用于本 Run 在配置的非生产官网中创建的 Run 前缀账号及关联会话；容器、文件及其他资源不得选择此域。未绑定数据保留人工处理告警。',
        }),
      ),
    },
    { additionalProperties: false },
  );
  return [
    {
      name: 'get_test_data_prefix',
      label: '获取测试数据标记',
      description: `获取当前 Run 前缀。创建后立即登记；Harness 在最终 Main 结束后统一收尾，Runner 不提交清理声明或提前确认结果。${cleanupNote}`,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => createTextResult(manager.prefix(runId)),
    },
    {
      name: 'register_test_data',
      label: '登记测试数据',
      description: `登记已创建的当前 Run 数据，供 Harness 收尾；登记不代表已清理。${cleanupNote}`,
      parameters,
      execute: async (_id: string, params: Static<typeof parameters>) => {
        try {
          await manager.register(runId, { ...params, ...(scenarioId ? { scenarioId } : {}) });
          return createTextResult(`测试数据已登记；${cleanupNote}`);
        } catch {
          return createTextResult('测试数据登记失败，请检查当前 Run 前缀及字段格式', {
            error: true,
          });
        }
      },
    },
    {
      name: 'list_pending_test_data',
      label: '列出待处理测试数据',
      description: '列出当前 Run 尚待 Harness 收尾处理的登记数据，不是测试结论。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () =>
        createTextResult(
          JSON.stringify(manager.pending(runId).map(({ id, status }) => ({ id, status }))),
        ),
    },
  ];
}

function normalizeShortText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length > maxLength || text.includes('\u0000')) throw new Error('测试数据文本无效');
  return text;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^,;\r\n}]+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:password|passwd|token|secret|cookie|api[-_]?key)\s*["']?\s*[:=]\s*["']?)([^\s,"';}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:github_pat_|gh[opsur]_|sk-)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
}
