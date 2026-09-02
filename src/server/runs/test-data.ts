import { createHash } from 'node:crypto';

import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createTextResult } from './agent-session.js';

export type TestDataStatus = 'registered' | 'cleanup-claimed' | 'verified-cleaned' | 'rejected';

export interface TestDataEntry {
  id: string;
  scenarioId?: string;
  description?: string;
}

export interface TestDataVerificationReceipt {
  sourceId: string;
  sourceKind: 'cleanup-adapter' | 'api-query' | 'readonly-command';
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

export interface TestDataQueryAdapter {
  id: string;
  kind: 'api-query' | 'readonly-command';
  operations: Readonly<Record<string, readonly string[]>>;
  query(
    input: Readonly<{
      runId: string;
      entry: TestDataEntry;
      operation: string;
      parameters: Readonly<Record<string, string>>;
    }>,
  ): Promise<TestDataAdapterObservation>;
}

export interface TestDataRecord extends TestDataEntry {
  status: TestDataStatus;
  registeredAt: string;
  claim?: { evidenceIds: string[]; claimedAt: string };
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

export interface TestDataEvidenceBoundary {
  captureCleanupQuery(
    receipt: TestDataVerificationReceipt,
    redactedContent: string,
  ): Promise<string>;
  isCleanupClaimEvidence(evidenceId: string, runId: string, dataId: string): Promise<boolean>;
  readCleanupTextEvidence(evidenceId: string, runId: string, dataId: string): Promise<string>;
  isReviewedCleanupEvidence(evidenceId: string): boolean;
}

export interface TestDataManager {
  prefix(runId: string): string;
  register(runId: string, entry: TestDataEntry): Promise<void>;
  submitClaim(
    runId: string,
    dataId: string,
    evidenceIds: readonly string[],
  ): Promise<TestDataRecord>;
  pending(runId: string): TestDataRecord[];
  query(
    runId: string,
    dataId: string,
    adapterId: string,
    operation: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ receipt: TestDataVerificationReceipt; redactedContent: string }>;
  verify(
    runId: string,
    dataId: string,
    decision: 'confirm' | 'reject',
    reason: string | undefined,
    wasRead: (evidenceId: string) => boolean,
  ): Promise<TestDataRecord>;
  cleanup(runId: string): Promise<TestDataCleanupResult>;
  finalize(runId: string): TestDataFinalResult;
}

export interface TestDataManagerOptions {
  cleanupAdapter?: TestDataCleanupAdapter;
  queryAdapters?: readonly TestDataQueryAdapter[];
  now?: () => Date;
}

export function createTestDataManager(options: TestDataManagerOptions = {}): TestDataManager {
  return new DefaultTestDataManager(options);
}

class DefaultTestDataManager implements TestDataManager {
  private readonly entries = new Map<string, Map<string, TestDataRecord>>();
  private readonly now: () => Date;
  private readonly queryAdapters: Map<string, TestDataQueryAdapter>;

  constructor(private readonly options: TestDataManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.queryAdapters = new Map();
    for (const adapter of options.queryAdapters ?? []) {
      assertAdapterId(adapter.id);
      if (this.queryAdapters.has(adapter.id)) throw new Error('测试数据查询适配器 ID 重复');
      this.queryAdapters.set(adapter.id, adapter);
    }
    if (options.cleanupAdapter) assertAdapterId(options.cleanupAdapter.id);
  }

  prefix(runId: string): string {
    return `luowang-${runId}-`;
  }

  async register(runId: string, entry: TestDataEntry): Promise<void> {
    const id = normalizeDataId(entry.id);
    if (!id.startsWith(this.prefix(runId))) {
      throw new Error('测试数据标识必须使用当前 Run 前缀');
    }
    const entries = this.entries.get(runId) ?? new Map<string, TestDataRecord>();
    if (!entries.has(id)) {
      entries.set(id, {
        id,
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

  async submitClaim(
    runId: string,
    dataId: string,
    evidenceIds: readonly string[],
  ): Promise<TestDataRecord> {
    const record = this.requireRecord(runId, dataId);
    const normalizedEvidence = [...new Set(evidenceIds.map(normalizeEvidenceId))];
    if (normalizedEvidence.length === 0 || normalizedEvidence.length > 8) {
      throw new Error('清理声明必须引用 1–8 项当前 Run 证据');
    }
    if (record.status === 'verified-cleaned') throw new Error('测试数据已经核验清理');
    if (record.status === 'cleanup-claimed') {
      if (sameValues(record.claim?.evidenceIds ?? [], normalizedEvidence))
        return cloneRecord(record);
      throw new Error('测试数据已有不同的清理声明');
    }
    record.status = 'cleanup-claimed';
    record.claim = { evidenceIds: normalizedEvidence, claimedAt: this.now().toISOString() };
    delete record.rejectionReason;
    return cloneRecord(record);
  }

  pending(runId: string): TestDataRecord[] {
    return [...(this.entries.get(runId)?.values() ?? [])]
      .filter((entry) => entry.status !== 'verified-cleaned')
      .map(cloneRecord)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async query(
    runId: string,
    dataId: string,
    adapterId: string,
    operation: string,
    parameters: Readonly<Record<string, string>>,
  ): Promise<{ receipt: TestDataVerificationReceipt; redactedContent: string }> {
    const record = this.requireRecord(runId, dataId);
    const adapter = this.queryAdapters.get(adapterId);
    if (!adapter) throw new Error('测试数据查询适配器不在 allowlist');
    const allowedParameters = adapter.operations[operation];
    if (!allowedParameters) throw new Error('测试数据查询操作不在 allowlist');
    const normalizedParameters = normalizeQueryParameters(parameters, allowedParameters);
    const observation = await adapter.query({
      runId,
      entry: publicEntry(record),
      operation,
      parameters: normalizedParameters,
    });
    return createReceipt(runId, record.id, adapter.id, adapter.kind, observation, this.now());
  }

  async verify(
    runId: string,
    dataId: string,
    decision: 'confirm' | 'reject',
    reason: string | undefined,
    wasRead: (evidenceId: string) => boolean,
  ): Promise<TestDataRecord> {
    const record = this.requireRecord(runId, dataId);
    if (record.status === 'verified-cleaned') return cloneRecord(record);
    if (record.status !== 'cleanup-claimed' || !record.claim) {
      throw new Error('测试数据没有待审核的清理声明');
    }
    if (!record.claim.evidenceIds.every(wasRead)) {
      throw new Error('Reviewer 必须先读取全部证据，且受控查询必须确认数据不存在');
    }
    if (decision === 'confirm') {
      record.status = 'verified-cleaned';
      delete record.rejectionReason;
    } else {
      const normalizedReason = normalizeShortText(reason ?? '', 500);
      if (normalizedReason === '') throw new Error('拒绝清理声明时必须提供原因');
      record.status = 'rejected';
      record.rejectionReason = redactSensitiveText(normalizedReason);
    }
    return cloneRecord(record);
  }

  async cleanup(runId: string): Promise<TestDataCleanupResult> {
    const entries = [...(this.entries.get(runId)?.values() ?? [])].filter(
      (entry) => entry.status !== 'verified-cleaned',
    );
    if (entries.length === 0) {
      return {
        ok: true,
        attempted: 0,
        failed: [],
        message: '没有待清理的测试数据',
        receipts: [],
      };
    }
    const adapter = this.options.cleanupAdapter;
    if (!adapter) {
      return {
        ok: false,
        attempted: 0,
        failed: entries.map((entry) => entry.id),
        message: '没有配置测试数据清理适配器，等待 Reviewer 核验清理声明',
        receipts: [],
      };
    }

    const failed: string[] = [];
    const receipts: TestDataVerificationReceipt[] = [];
    for (const entry of entries) {
      try {
        const observation = await adapter.cleanupAndVerify({
          runId,
          entry: publicEntry(entry),
        });
        const captured = createReceipt(
          runId,
          entry.id,
          adapter.id,
          'cleanup-adapter',
          observation,
          this.now(),
        );
        receipts.push(captured.receipt);
        entry.verification = captured.receipt;
        if (captured.receipt.absent) {
          entry.status = 'verified-cleaned';
          delete entry.rejectionReason;
        } else {
          entry.status = 'rejected';
          entry.rejectionReason = '清理适配器独立查询确认数据仍存在';
          failed.push(entry.id);
        }
      } catch {
        entry.status = 'rejected';
        entry.rejectionReason = '清理适配器执行或独立查询失败';
        failed.push(entry.id);
      }
    }
    return {
      ok: failed.length === 0,
      attempted: entries.length,
      failed,
      message:
        failed.length === 0
          ? `清理适配器已独立核验 ${entries.length} 项测试数据不存在`
          : `有 ${failed.length} 项测试数据未通过清理适配器核验`,
      receipts,
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
      message:
        pending.length === 0
          ? '全部登记测试数据均已独立核验清理'
          : `仍有 ${pending.length} 项测试数据未确认清理`,
    };
  }

  private requireRecord(runId: string, dataId: string): TestDataRecord {
    const id = normalizeDataId(dataId);
    const record = this.entries.get(runId)?.get(id);
    if (!record) throw new Error('测试数据未在当前 Run 登记');
    return record;
  }
}

export function createTestDataTools(
  manager: TestDataManager,
  runId: string,
  evidence: TestDataEvidenceBoundary | undefined,
  scenarioId?: string,
): ToolDefinition[] {
  const registerParameters = Type.Object(
    {
      id: Type.String({ description: '已创建测试数据的稳定标识，不要填写密码或 Token' }),
      description: Type.Optional(Type.String({ description: '测试数据的脱敏简短说明' })),
    },
    { additionalProperties: false },
  );
  const claimParameters = Type.Object(
    {
      dataId: Type.String({ description: '当前 Run 已登记的测试数据 ID' }),
      evidenceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
    },
    { additionalProperties: false },
  );
  const captureParameters = Type.Object(
    {
      dataId: Type.String({ description: '当前 Run 已登记的测试数据 ID' }),
      adapterId: Type.String({ description: 'Harness 配置的查询 adapter ID' }),
      operation: Type.String({ description: 'adapter allowlist 内的只读查询操作' }),
      parameters: Type.Optional(
        Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }), Type.String()),
      ),
    },
    { additionalProperties: false },
  );
  return [
    {
      name: 'get_test_data_prefix',
      label: '获取测试数据标记',
      description: '获取当前 Run 的测试数据前缀。创建数据时必须使用该前缀，便于清理。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => createTextResult(manager.prefix(runId)),
    },
    {
      name: 'register_test_data',
      label: '登记测试数据',
      description: '创建测试数据后立即登记；登记本身不代表数据已清理。',
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
      name: 'capture_test_data_cleanup_query',
      label: '捕获清理后查询证据',
      description:
        '通过 Harness allowlist 内的 API/只读命令 adapter 查询已登记数据；响应正文、状态码和摘要由 Harness 直接捕获，不能由 Agent 提交。',
      parameters: captureParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof captureParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          if (!evidence) throw new Error('当前 Run 没有可用的 Evidence Store');
          const captured = await manager.query(
            runId,
            params.dataId,
            params.adapterId,
            params.operation,
            params.parameters ?? {},
          );
          const evidenceId = await evidence.captureCleanupQuery(
            captured.receipt,
            captured.redactedContent,
          );
          return createTextResult(JSON.stringify({ evidenceId, receipt: captured.receipt }), {
            evidenceId,
          });
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'submit_test_data_cleanup_claim',
      label: '提交测试数据清理声明',
      description:
        '引用当前 Run 中 Harness 管理的受控查询证据或 Playwright 截图，只提交声明；必须经 adapter 或 Reviewer 核验。',
      parameters: claimParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof claimParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          if (!evidence) throw new Error('当前 Run 没有可用的 Evidence Store');
          for (const evidenceId of params.evidenceIds) {
            if (!(await evidence.isCleanupClaimEvidence(evidenceId, runId, params.dataId))) {
              throw new Error('清理声明引用了不合格或不属于当前 Run/data ID 的证据');
            }
          }
          const record = await manager.submitClaim(runId, params.dataId, params.evidenceIds);
          return createTextResult(JSON.stringify(publicRecord(record)));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'list_pending_test_data',
      label: '列出待核验测试数据',
      description: '列出当前 Run 尚未独立核验清理的脱敏测试数据。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () =>
        createTextResult(JSON.stringify(manager.pending(runId).map(publicRecord))),
    },
  ];
}

export function createReviewerTestDataTools(
  manager: TestDataManager,
  runId: string,
  evidence: TestDataEvidenceBoundary | undefined,
): ToolDefinition[] {
  const readParameters = Type.Object(
    {
      dataId: Type.String(),
      evidenceId: Type.String(),
    },
    { additionalProperties: false },
  );
  const verifyParameters = Type.Object(
    {
      dataId: Type.String(),
      decision: Type.Union([Type.Literal('confirm'), Type.Literal('reject')]),
      reason: Type.Optional(Type.String({ maxLength: 500 })),
    },
    { additionalProperties: false },
  );
  return [
    {
      name: 'list_pending_test_data',
      label: '列出待核验测试数据',
      description: '列出当前 Run 待 Reviewer 核验的 data ID、状态和清理声明 evidence IDs。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () =>
        createTextResult(JSON.stringify(manager.pending(runId).map(publicRecord))),
    },
    {
      name: 'read_test_data_cleanup_evidence',
      label: '读取测试数据清理证据',
      description:
        '读取 Harness 捕获并已上传的清理后文本查询证据。截图必须使用 read_evidence_image 查看。',
      parameters: readParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof readParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          if (!evidence) throw new Error('当前 Run 没有可用的 Evidence Store');
          return createTextResult(
            await evidence.readCleanupTextEvidence(params.evidenceId, runId, params.dataId),
          );
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'verify_test_data_cleanup',
      label: '核验测试数据清理',
      description: '仅在实际读取清理声明引用的全部受控证据后确认或拒绝；不能执行目标环境命令。',
      parameters: verifyParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof verifyParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          if (!evidence) throw new Error('当前 Run 没有可用的 Evidence Store');
          const record = await manager.verify(
            runId,
            params.dataId,
            params.decision,
            params.reason,
            (evidenceId) => evidence.isReviewedCleanupEvidence(evidenceId),
          );
          return createTextResult(JSON.stringify(publicRecord(record)));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
  ];
}

function createReceipt(
  runId: string,
  dataId: string,
  sourceId: string,
  sourceKind: TestDataVerificationReceipt['sourceKind'],
  observation: TestDataAdapterObservation,
  now: Date,
): { receipt: TestDataVerificationReceipt; redactedContent: string } {
  if (typeof observation.content !== 'string') throw new Error('清理查询没有返回文本响应');
  if (Buffer.byteLength(observation.content, 'utf8') > 256 * 1024) {
    throw new Error('清理查询响应超过大小限制');
  }
  if (sourceKind === 'api-query' && !validStatusCode(observation.statusCode)) {
    throw new Error('受控 API 查询缺少有效状态码');
  }
  if (sourceKind === 'readonly-command' && !Number.isInteger(observation.exitCode)) {
    throw new Error('受控只读命令缺少有效退出码');
  }
  const redactedContent = redactSensitiveText(observation.content).slice(0, 64 * 1024);
  const normalized = redactedContent.replace(/\s+/g, ' ').trim();
  const receipt: TestDataVerificationReceipt = {
    sourceId,
    sourceKind,
    runId,
    dataId,
    queriedAt: now.toISOString(),
    absent: observation.absent === true,
    ...(validStatusCode(observation.statusCode) ? { statusCode: observation.statusCode } : {}),
    ...(Number.isInteger(observation.exitCode) ? { exitCode: observation.exitCode } : {}),
    summary: normalized.slice(0, 240),
    sha256: createHash('sha256').update(redactedContent, 'utf8').digest('hex'),
  };
  return { receipt, redactedContent };
}

function normalizeQueryParameters(
  parameters: Readonly<Record<string, string>>,
  allowed: readonly string[],
): Record<string, string> {
  const keys = Object.keys(parameters);
  if (keys.length > 16 || keys.some((key) => !allowed.includes(key))) {
    throw new Error('测试数据查询参数不在 allowlist');
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = parameters[key];
    if (typeof value !== 'string' || value.length > 200 || containsControlCharacters(value)) {
      throw new Error('测试数据查询参数无效');
    }
    result[key] = value;
  }
  return result;
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizeDataId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) || looksLikeSecret(id)) {
    throw new Error('测试数据标识无效');
  }
  return id;
}

function normalizeEvidenceId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(id) || id.includes('..')) {
    throw new Error('清理证据 ID 无效');
  }
  return id;
}

function normalizeShortText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length > maxLength || text.includes('\u0000')) throw new Error('测试数据文本无效');
  return text;
}

function assertAdapterId(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('测试数据适配器 ID 无效');
}

function publicEntry(record: TestDataRecord): TestDataEntry {
  return {
    id: record.id,
    ...(record.scenarioId ? { scenarioId: record.scenarioId } : {}),
    ...(record.description ? { description: record.description } : {}),
  };
}

function publicRecord(record: TestDataRecord): Record<string, unknown> {
  return {
    id: record.id,
    ...(record.scenarioId ? { scenarioId: record.scenarioId } : {}),
    status: record.status,
    evidenceIds: record.claim?.evidenceIds ?? [],
    ...(record.rejectionReason ? { rejectionReason: record.rejectionReason } : {}),
  };
}

function cloneRecord(record: TestDataRecord): TestDataRecord {
  return {
    ...record,
    ...(record.claim
      ? { claim: { ...record.claim, evidenceIds: [...record.claim.evidenceIds] } }
      : {}),
    ...(record.verification ? { verification: { ...record.verification } } : {}),
  };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validStatusCode(value: number | undefined): value is number {
  return Number.isInteger(value) && (value ?? 0) >= 100 && (value ?? 0) <= 599;
}

function redactSensitiveText(value: string): string {
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

function looksLikeSecret(value: string): boolean {
  return /^(?:github_pat_|gh[opsur]_|sk-|AKIA)/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '测试数据操作失败';
}
