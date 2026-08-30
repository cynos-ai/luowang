import { randomUUID } from 'node:crypto';

import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createTextResult } from './agent-session.js';

export interface TestDataEntry {
  id: string;
  scenarioId?: string;
  description?: string;
}

export interface TestDataCleanupResult {
  ok: boolean;
  attempted: number;
  failed: string[];
  message: string;
}

export interface TestDataManager {
  prefix(runId: string): string;
  register(runId: string, entry: TestDataEntry): Promise<void>;
  cleanup(runId: string): Promise<TestDataCleanupResult>;
}

export interface TestDataManagerOptions {
  cleanup?: (runId: string, entries: readonly TestDataEntry[]) => Promise<readonly string[]>;
  id?: () => string;
}

export function createTestDataManager(options: TestDataManagerOptions = {}): TestDataManager {
  return new DefaultTestDataManager(options);
}

class DefaultTestDataManager implements TestDataManager {
  private readonly entries = new Map<string, TestDataEntry[]>();
  private readonly id: () => string;

  constructor(private readonly options: TestDataManagerOptions) {
    this.id = options.id ?? randomUUID;
  }

  prefix(runId: string): string {
    return `luowang-${runId}-`;
  }

  async register(runId: string, entry: TestDataEntry): Promise<void> {
    const id = entry.id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
      throw new Error('测试数据标识无效');
    }
    const entries = this.entries.get(runId) ?? [];
    if (!entries.some((item) => item.id === id)) {
      entries.push({ ...entry, id });
      this.entries.set(runId, entries);
    }
  }

  async cleanup(runId: string): Promise<TestDataCleanupResult> {
    const entries = this.entries.get(runId) ?? [];
    if (entries.length > 0 && !this.options.cleanup) {
      return {
        ok: false,
        attempted: entries.length,
        failed: entries.map((entry) => entry.id),
        message: '没有配置测试数据清理适配器，无法确认测试数据已清理',
      };
    }
    try {
      const failed = this.options.cleanup ? [...(await this.options.cleanup(runId, entries))] : [];
      if (failed.length === 0) this.entries.delete(runId);
      return {
        ok: failed.length === 0,
        attempted: entries.length,
        failed,
        message:
          failed.length === 0
            ? entries.length === 0
              ? '没有登记需要清理的测试数据'
              : `已清理 ${entries.length} 项测试数据`
            : `有 ${failed.length} 项测试数据清理失败`,
      };
    } catch {
      return {
        ok: false,
        attempted: entries.length,
        failed: entries.map((entry) => entry.id),
        message: '测试数据清理适配器执行失败',
      };
    }
  }

  nextId(): string {
    return this.id();
  }
}

export function createTestDataTools(
  manager: TestDataManager,
  runId: string,
  scenarioId?: string,
): ToolDefinition[] {
  const registerParameters = Type.Object({
    id: Type.String({ description: '已创建测试数据的稳定标识，不要填写密码或 Token' }),
    description: Type.Optional(Type.String({ description: '测试数据的简短说明' })),
  });
  const cleanupParameters = Type.Object({});
  return [
    {
      name: 'get_test_data_prefix',
      label: '获取测试数据标记',
      description: '获取当前 Run 的测试数据前缀。创建数据时必须使用该前缀，便于清理。',
      parameters: Type.Object({}),
      execute: async () => createTextResult(manager.prefix(runId)),
    },
    {
      name: 'register_test_data',
      label: '登记测试数据',
      description: '登记本次场景创建的临时数据，场景结束时由 Harness 统一清理。',
      parameters: registerParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof registerParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          await manager.register(runId, {
            id: params.id,
            ...(scenarioId ? { scenarioId } : {}),
            ...(params.description ? { description: params.description } : {}),
          });
          return createTextResult('测试数据已登记');
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'cleanup_test_data',
      label: '清理测试数据',
      description: '在当前场景结束时执行一次测试数据清理，并返回清理结果。',
      parameters: cleanupParameters,
      execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = await manager.cleanup(runId);
        return createTextResult(JSON.stringify(result), { cleanup: result });
      },
    },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '测试数据操作失败';
}
