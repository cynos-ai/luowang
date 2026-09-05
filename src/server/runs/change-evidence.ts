import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

const MAX_CHANGED_FILES_PER_PAGE = 100;
const MAX_DIFF_PAGE_BYTES = 32 * 1024;
const CURSOR_VERSION = 1;

export type TargetChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TargetChangeDescriptor {
  oldPath: string | null;
  newPath: string | null;
  kind: TargetChangeKind;
  oldMode: string | null;
  newMode: string | null;
  oldType: 'blob' | 'tree' | 'commit' | null;
  newType: 'blob' | 'tree' | 'commit' | null;
  readable: boolean;
  unreadableReason?: string;
}

export interface TargetTextReadResult {
  status: 'ok' | 'empty' | 'no_baseline' | 'unreadable' | 'unavailable';
  content?: string;
  reason?: string;
}

export interface TargetDiffReadResult {
  status: 'ok' | 'empty' | 'no_baseline' | 'unreadable' | 'unavailable';
  content?: string;
  reason?: string;
}

export interface TargetChangeEvidenceOptions {
  baseCommit: string | null;
  targetCommit: string;
  listChanges: () => Promise<readonly TargetChangeDescriptor[]>;
  readDiff: (path: string) => Promise<TargetDiffReadResult>;
  readFile: (version: 'base' | 'target', path: string) => Promise<TargetTextReadResult>;
}

export function createTargetChangeEvidenceTools(
  options: TargetChangeEvidenceOptions,
): ToolDefinition[] {
  const listParameters = Type.Object(
    { cursor: Type.Optional(Type.String({ description: '上一次响应返回的续读游标' })) },
    { additionalProperties: false },
  );
  const diffParameters = Type.Object(
    {
      path: Type.String({ description: '变更清单中的新路径或旧路径' }),
      cursor: Type.Optional(Type.String({ description: '上一次 diff 响应返回的续读游标' })),
    },
    { additionalProperties: false },
  );
  const fileParameters = Type.Object(
    {
      version: Type.Union([Type.Literal('base'), Type.Literal('target')]),
      path: Type.String({ description: '固定版本中的仓库相对路径' }),
    },
    { additionalProperties: false },
  );

  return [
    {
      name: 'list_target_changes',
      label: '列出固定变化',
      description:
        '只读列出固定 base 到 target 的净文件变化；每页最多 100 项，必须使用返回游标续读。base 不存在、空变化、不可读变化和依赖失败会明确区分。',
      parameters: listParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof listParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const cursor = decodeCursor(params.cursor, 'changes', options);
          if (options.baseCommit === null) {
            return textResult(
              JSON.stringify({
                status: 'no_baseline',
                baseCommit: null,
                targetCommit: options.targetCommit,
                changes: [],
                nextCursor: null,
                message: '本 Run 没有可比较的 base commit；请按当前 target 理解基线。',
              }),
            );
          }
          const changes = [...(await options.listChanges())].sort(compareChanges);
          const start = cursor?.offset ?? 0;
          const page = changes.slice(start, start + MAX_CHANGED_FILES_PER_PAGE);
          const nextOffset = start + page.length;
          const nextCursor =
            nextOffset < changes.length
              ? encodeCursor({
                  version: CURSOR_VERSION,
                  kind: 'changes',
                  baseCommit: options.baseCommit,
                  targetCommit: options.targetCommit,
                  offset: nextOffset,
                })
              : null;
          return textResult(
            JSON.stringify({
              status: page.length === 0 ? 'empty' : nextCursor === null ? 'ok' : 'partial',
              baseCommit: options.baseCommit,
              targetCommit: options.targetCommit,
              changes: page.map((change) => serializeChange(change)),
              nextCursor,
            }),
          );
        } catch (error) {
          return unavailableResult(error, '固定变化清单当前不可读取');
        }
      },
    },
    {
      name: 'read_target_diff',
      label: '读取固定文本 diff',
      description:
        '读取变化清单中一个文件的固定 base/target 文本 diff；每页最多 32 KiB，返回游标必须续读。二进制、符号链接、子模块和不可读内容不会伪装成文本。',
      parameters: diffParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof diffParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const path = assertPath(params.path);
          const cursor = decodeCursor(params.cursor, 'diff', options, path);
          const result = await options.readDiff(path);
          if (result.status === 'unavailable') {
            return unavailableResult(
              new Error(result.reason ?? '固定 diff 依赖不可用'),
              '固定 diff 依赖不可用',
            );
          }
          if (result.status === 'no_baseline') {
            return textResult(
              JSON.stringify({
                status: 'no_baseline',
                baseCommit: null,
                targetCommit: options.targetCommit,
                path: safePath(path),
                content: '',
                nextCursor: null,
                reason: result.reason ?? '本 Run 没有可比较的 base commit',
              }),
            );
          }
          if (result.status === 'unreadable') {
            return textResult(
              JSON.stringify({
                status: 'unreadable',
                baseCommit: options.baseCommit,
                targetCommit: options.targetCommit,
                path: safePath(path),
                reason: result.reason ?? '固定文件不是可读文本',
                nextCursor: null,
              }),
            );
          }
          const content = result.content ?? '';
          if (content === '') {
            return textResult(
              JSON.stringify({
                status: 'empty',
                baseCommit: options.baseCommit,
                targetCommit: options.targetCommit,
                path: safePath(path),
                content: '',
                nextCursor: null,
              }),
            );
          }
          const page = paginateUtf8(content, cursor?.offset ?? 0);
          const nextCursor =
            page.nextOffset < page.totalBytes
              ? encodeCursor({
                  version: CURSOR_VERSION,
                  kind: 'diff',
                  baseCommit: options.baseCommit,
                  targetCommit: options.targetCommit,
                  path,
                  offset: page.nextOffset,
                })
              : null;
          return textResult(
            JSON.stringify({
              status: nextCursor === null ? 'ok' : 'partial',
              baseCommit: options.baseCommit,
              targetCommit: options.targetCommit,
              path: safePath(path),
              content: page.content,
              bytes: Buffer.byteLength(page.content, 'utf8'),
              nextCursor,
            }),
          );
        } catch (error) {
          return unavailableResult(error, '固定 diff 当前不可读取');
        }
      },
    },
    {
      name: 'read_target_file_version',
      label: '读取固定版本文件',
      description:
        '按 base 或 target 读取一个固定版本的非敏感文本文件；版本只能是 base/target，不能指定任意 ref、SHA 或路径范围。',
      parameters: fileParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof fileParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const path = assertPath(params.path);
          const result = await options.readFile(params.version, path);
          if (result.status === 'unavailable') {
            return unavailableResult(
              new Error(result.reason ?? '固定版本文件依赖不可用'),
              '固定版本文件依赖不可用',
            );
          }
          return textResult(
            JSON.stringify({
              status: result.status,
              version: params.version,
              baseCommit: options.baseCommit,
              targetCommit: options.targetCommit,
              path: safePath(path),
              ...(result.content !== undefined ? { content: result.content } : {}),
              ...(result.reason ? { reason: result.reason } : {}),
            }),
          );
        } catch (error) {
          return unavailableResult(error, '固定版本文件当前不可读取');
        }
      },
    },
  ];
}

interface Cursor {
  version: number;
  kind: 'changes' | 'diff';
  baseCommit: string | null;
  targetCommit: string;
  path?: string;
  offset: number;
}

function decodeCursor(
  value: string | undefined,
  kind: Cursor['kind'],
  options: TargetChangeEvidenceOptions,
  path?: string,
): Cursor | null {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('固定变化续读游标无效');
  }
  if (!isRecord(parsed)) throw new Error('固定变化续读游标无效');
  const cursor = parsed as Partial<Cursor>;
  if (
    cursor.version !== CURSOR_VERSION ||
    cursor.kind !== kind ||
    cursor.baseCommit !== options.baseCommit ||
    cursor.targetCommit !== options.targetCommit ||
    !Number.isSafeInteger(cursor.offset) ||
    (cursor.offset as number) < 0
  ) {
    throw new Error('固定变化续读游标与当前 base/target 不匹配');
  }
  if (kind === 'diff' && (typeof cursor.path !== 'string' || cursor.path !== path)) {
    throw new Error('固定 diff 续读游标与当前路径不匹配');
  }
  return cursor as Cursor;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function paginateUtf8(
  value: string,
  offset: number,
): {
  content: string;
  nextOffset: number;
  totalBytes: number;
} {
  const bytes = Buffer.from(value, 'utf8');
  if (offset > bytes.byteLength) throw new Error('固定 diff 续读游标超出内容范围');
  let end = Math.min(offset + MAX_DIFF_PAGE_BYTES, bytes.byteLength);
  while (end > offset && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
  if (end === offset && offset < bytes.byteLength)
    end = Math.min(offset + MAX_DIFF_PAGE_BYTES, bytes.byteLength);
  return {
    content: bytes.subarray(offset, end).toString('utf8'),
    nextOffset: end,
    totalBytes: bytes.byteLength,
  };
}

function serializeChange(change: TargetChangeDescriptor): Record<string, unknown> {
  return {
    kind: change.kind,
    oldPath: safePath(change.oldPath),
    newPath: safePath(change.newPath),
    readable: change.readable,
    ...(change.unreadableReason ? { unreadableReason: change.unreadableReason } : {}),
  };
}

function compareChanges(left: TargetChangeDescriptor, right: TargetChangeDescriptor): number {
  return (left.newPath ?? left.oldPath ?? '').localeCompare(right.newPath ?? right.oldPath ?? '');
}

function assertPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes('\u0000') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('固定变化文件路径无效');
  }
  return value.trim();
}

function safePath(value: string | null): string | null {
  return value;
}

function unavailableResult(
  error: unknown,
  fallback: string,
): AgentToolResult<Record<string, unknown>> {
  const message = error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
  return textResult(JSON.stringify({ status: 'unavailable', message }), { error: true });
}

function textResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
