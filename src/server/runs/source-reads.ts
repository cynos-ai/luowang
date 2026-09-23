import { createHash, randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

export const SOURCE_STAGES = [
  'main-planning',
  'initialization-static',
  'initialization-candidate',
  'runner-execution',
  'initialization-reconnaissance',
  'initialization-validation',
] as const;
export type SourceStage = (typeof SOURCE_STAGES)[number];
export type SourceTool =
  | 'read_target_file'
  | 'read_target_file_version'
  | 'read_target_diff'
  | 'list_target_files'
  | 'list_target_changes'
  | 'search_target_files';
export interface SourceReadFact {
  tool: SourceTool;
  category: 'file' | 'diff' | 'paths' | 'changes' | 'search';
  status: 'ok' | 'empty' | 'partial' | 'no_baseline' | 'unreadable' | 'unavailable';
  path: string | null;
  commit: string | null;
  baseCommit: string | null;
  targetCommit: string;
  contentHash: string | null;
  pageHash: string | null;
  range: { unit: 'utf8-bytes' | 'items'; start: number; end: number; total: number } | null;
  redacted: boolean;
  limits: string[];
}
export interface SourceReadReceipt extends SourceReadFact {
  id: string;
  runId: string;
  repositoryId: string;
  sessionId: string;
  stage: SourceStage;
  toolCallHash: string;
}
export interface SourceReadSession {
  record(toolCallId: string, fact: SourceReadFact): Promise<SourceReadReceipt>;
}
export interface SourceReference {
  receiptId: string;
  coverage: 'returned-range' | 'full-file';
}
export class SourceReferenceError extends Error {
  constructor() {
    super(
      'sourceReferences 必须引用当前 Run 允许 Main 阶段的成功回执；full-file 需要本次引用的全部正文页完整覆盖。旧计划未修改。',
    );
  }
}
export function assertSourceReferences(value: unknown): asserts value is SourceReference[] {
  if (
    !Array.isArray(value) ||
    value.length > 2000 ||
    value.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        Object.keys(item).some((key) => !['receiptId', 'coverage'].includes(key)) ||
        typeof item.receiptId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(item.receiptId) ||
        !['returned-range', 'full-file'].includes(item.coverage),
    ) ||
    new Set(value.map((r) => r.receiptId)).size !== value.length
  )
    throw new SourceReferenceError();
}
export function sourceHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Local Run metadata, never an evidence object or a target Git artifact. */
export class SourceReadStore {
  private receipts: SourceReadReceipt[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private plan: { hash: string; references: SourceReference[] } | null = null;
  constructor(
    readonly runId: string,
    readonly repositoryId: string,
    private readonly persist: (content: string) => Promise<void>,
  ) {}

  session(stage: SourceStage): SourceReadSession {
    const sessionId = randomUUID();
    return {
      record: (toolCallId, fact) => {
        const write = this.pending.then(async () => {
          if (this.receipts.length >= 2000) throw new Error('Source read receipt limit');
          const receipt: SourceReadReceipt = {
            ...structuredClone(fact),
            id: randomUUID(),
            runId: this.runId,
            repositoryId: this.repositoryId,
            sessionId,
            stage,
            toolCallHash: sourceHash(toolCallId),
          };
          const next = [...this.receipts, receipt];
          const content = JSON.stringify({
            version: 1,
            runId: this.runId,
            repositoryId: this.repositoryId,
            receipts: next,
          });
          if (Buffer.byteLength(content) > 4 * 1024 * 1024)
            throw new Error('Source read metadata limit');
          await this.persist(content);
          this.receipts = next;
          return structuredClone(receipt);
        });
        this.pending = write.catch(() => undefined);
        return write;
      },
    };
  }

  writePlan(
    content: string,
    requiresBrowser: boolean,
    references: SourceReference[],
    allowedStages: readonly SourceStage[],
    write: (value: string) => Promise<void>,
  ): Promise<void> {
    const operation = this.pending.then(async () => {
      assertSourceReferences(references);
      // A candidate Main may copy the prior plan. Ignore its old metadata; only
      // this call's independently validated structured references are authoritative.
      if (typeof content === 'string')
        content = content.replace(
          /^<!-- luowang-source-references-v1\r?\n[^\r\n]*\r?\n-->\r?\n\r?\n/,
          '',
        );
      if (
        typeof content !== 'string' ||
        !content.trim() ||
        /<!--\s*luowang-source-references/i.test(content)
      )
        throw new SourceReferenceError();
      const selected = references.map((reference) => {
        const receipt = this.receipts.find((r) => r.id === reference.receiptId);
        if (
          !receipt ||
          receipt.runId !== this.runId ||
          !allowedStages.includes(receipt.stage) ||
          !['ok', 'empty', 'partial'].includes(receipt.status) ||
          !receipt.range ||
          !receipt.contentHash
        )
          throw new SourceReferenceError();
        return receipt;
      });
      references.forEach((reference, index) => {
        if (reference.coverage === 'full-file') {
          const receipt = selected[index];
          if (
            receipt.category !== 'file' ||
            !sourceCoverage(selected.filter((r) => sourceObjectKey(r) === sourceObjectKey(receipt)))
              .fullSafeText
          )
            throw new SourceReferenceError();
        }
      });
      const hash = sourceHash(content);
      // One atomic plan file owns both body and references. No two-file commit window.
      const metadata = JSON.stringify({
        runId: this.runId,
        planHash: hash,
        requiresBrowser,
        sourceReferences: references,
      });
      await write(`<!-- luowang-source-references-v1\n${metadata}\n-->\n\n${content}`);
      this.plan = { hash, references: structuredClone(references) };
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  queryTool(sanitize: (value: string) => string): ToolDefinition {
    const cursors = new SourceCursors();
    const parameters = Type.Object(
      {
        stage: Type.Optional(
          Type.Union([Type.Literal('all'), ...SOURCE_STAGES.map((stage) => Type.Literal(stage))]),
        ),
        path: Type.Optional(Type.String({ maxLength: 2048 })),
        cursor: Type.Optional(Type.String({ maxLength: 128 })),
        scope: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('plan')])),
      },
      { additionalProperties: false },
    );
    return {
      name: 'query_source_reads',
      label: '查询本 Run 源码读取回执',
      description:
        '只查询当前 Run 的脱敏读取元数据，不返回源码；可按阶段和精确相对路径筛选，每页最多 25 项。fullSafeText 仅指受控文本覆盖，不证明理解正确或已读脱敏原文。',
      parameters,
      execute: async (_id, params: Static<typeof parameters>) => {
        try {
          if (
            Object.keys(params).some((key) => !['stage', 'path', 'cursor', 'scope'].includes(key))
          )
            throw new SourceInputError();
          if (params.scope !== undefined && params.scope !== 'all' && params.scope !== 'plan')
            throw new SourceInputError();
          if (
            params.stage !== undefined &&
            params.stage !== 'all' &&
            !SOURCE_STAGES.includes(params.stage)
          )
            throw new SourceInputError();
          if (
            params.path !== undefined &&
            (assertSourcePath(params.path) !== params.path || sanitize(params.path) !== params.path)
          )
            throw new SourceInputError();
          await this.pending;
          const references = new Map(
            this.plan?.references.map((r) => [r.receiptId, r.coverage]) ?? [],
          );
          const matches = this.receipts.filter(
            (item) =>
              (params.scope !== 'plan' || references.has(item.id)) &&
              (!params.stage || params.stage === 'all' || item.stage === params.stage) &&
              (params.path === undefined || item.path === params.path),
          );
          // Freeze the result set into the cursor identity. New reads require a new query.
          const identity = sourceHash(
            JSON.stringify([
              params.scope ?? 'all',
              this.plan?.hash,
              params.stage ?? 'all',
              params.path ?? null,
              matches.map((r) => r.id),
            ]),
          );
          const start = cursors.offset(params.cursor, identity);
          const receipts: SourceReadReceipt[] = [];
          for (const receipt of matches.slice(start, start + 25)) {
            if (Buffer.byteLength(JSON.stringify([...receipts, receipt])) > 24 * 1024) break;
            receipts.push(receipt);
          }
          if (receipts.length === 0 && start < matches.length) throw new SourceInputError();
          const nextCursor = cursors.next(identity, start + receipts.length, matches.length);
          const fileKeys = new Set(
            receipts.filter((r) => r.category === 'file').map(sourceObjectKey),
          );
          const coverage = [...fileKeys].map((key) =>
            sourceCoverage(matches.filter((r) => sourceObjectKey(r) === key)),
          );
          const body = {
            status: 'ok',
            runId: this.runId,
            planHash: this.plan?.hash ?? null,
            receipts: receipts.map((r) => ({
              ...r,
              ...(references.has(r.id) ? { planCoverage: references.get(r.id) } : {}),
            })),
            coverage,
            nextCursor,
          };
          // Recheck at disclosure time if the operator changed secrets during the Run.
          if (
            sanitize(JSON.stringify(receipts.map((r) => r.path))) !==
            JSON.stringify(receipts.map((r) => r.path))
          )
            throw new SourceInputError();
          return sourceResult(body);
        } catch {
          return sourceResult({ status: 'unavailable', reason: 'source_query_unavailable' }, true);
        }
      },
    };
  }
}

export function sourceObjectKey(receipt: SourceReadReceipt): string {
  return JSON.stringify([
    receipt.runId,
    receipt.repositoryId,
    receipt.category,
    receipt.commit,
    receipt.path,
    receipt.contentHash,
  ]);
}
export function sourceCoverage(receipts: readonly SourceReadReceipt[]) {
  const first = receipts[0];
  const key = first ? sourceObjectKey(first) : '';
  const valid = receipts.filter(
    (r) =>
      sourceObjectKey(r) === key &&
      r.category === 'file' &&
      r.path !== null &&
      r.commit !== null &&
      r.contentHash &&
      r.range?.unit === 'utf8-bytes' &&
      ['ok', 'empty', 'partial'].includes(r.status),
  );
  const total = valid[0]?.range?.total ?? null;
  const intervals = valid.map((r) => r.range!).sort((a, b) => a.start - b.start);
  let coveredBytes = 0;
  let end = 0;
  let contiguous = true;
  for (const range of intervals) {
    if (
      range.total !== total ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > range.total
    ) {
      contiguous = false;
      continue;
    }
    if (range.start > end) contiguous = false;
    coveredBytes += Math.max(0, range.end - Math.max(end, range.start));
    end = Math.max(end, range.end);
  }
  return {
    path: first?.path ?? null,
    commit: first?.commit ?? null,
    contentHash: first?.contentHash ?? null,
    totalBytes: total,
    coveredBytes,
    fullSafeText: valid.length > 0 && contiguous && end === total,
    redacted: valid.some((r) => r.redacted),
  };
}

/** Opaque, session-local cursors bind the exact safe object and issued offset. */
export class SourceCursors {
  private issued = new Map<string, { identity: string; offset: number }>();
  offset(cursor: string | undefined, identity: string): number {
    if (cursor === undefined) return 0;
    const saved = this.issued.get(cursor);
    if (!saved || saved.identity !== identity) throw new SourceInputError();
    return saved.offset;
  }
  next(identity: string, offset: number, total: number): string | null {
    if (offset >= total) return null;
    if (this.issued.size >= 4000) throw new SourceInputError();
    const token = randomUUID();
    this.issued.set(token, { identity, offset });
    return token;
  }
}
export class SourceInputError extends Error {}
export function assertSourcePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value.trim() !== value ||
    !value ||
    /[\\:]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.startsWith('/') ||
    value.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new SourceInputError();
  return value;
}
export function sourceResult(
  body: unknown,
  error = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    details: error ? { error: true } : {},
  };
}
export async function recordedSourceResult(
  session: SourceReadSession | undefined,
  toolCallId: string,
  fact: SourceReadFact,
  body: Record<string, unknown>,
) {
  try {
    const receipt = session ? await session.record(toolCallId, fact) : undefined;
    return sourceResult(
      { ...body, ...(receipt ? { receipt } : {}) },
      fact.status === 'unavailable',
    );
  } catch {
    // No source text or uncommitted receipt escapes a failed persistence operation.
    return sourceResult({ status: 'unavailable', reason: 'source_receipt_write_failed' }, true);
  }
}

export function sourceTextPage(value: string, offset: number) {
  const bytes = Buffer.from(value, 'utf8');
  if (
    offset < 0 ||
    offset > bytes.length ||
    (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
  )
    throw new SourceInputError();
  let end = Math.min(offset + 32 * 1024, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    content: bytes.subarray(offset, end).toString('utf8'),
    range: { unit: 'utf8-bytes' as const, start: offset, end, total: bytes.length },
  };
}
