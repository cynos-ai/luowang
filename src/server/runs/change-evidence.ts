import { Type, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  assertSourcePath,
  recordedSourceResult,
  sourceHash,
  sourceTextPage,
  SourceCursors,
  SourceInputError,
  type SourceReadFact,
  type SourceReadSession,
  type SourceTool,
} from './source-reads.js';

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
export type TargetDiffReadResult = TargetTextReadResult;
export interface TargetSearchResult {
  paths: string[];
  limits: string[];
  scannedFiles: number;
}
export interface SourceToolOptions {
  baseCommit: string | null;
  targetCommit: string;
  sourceReads?: SourceReadSession;
  sanitize?: (value: string) => string;
}
export interface TargetChangeEvidenceOptions extends SourceToolOptions {
  listChanges: () => Promise<readonly TargetChangeDescriptor[]>;
  readDiff: (path: string) => Promise<TargetDiffReadResult>;
  readFile: (version: 'base' | 'target', path: string) => Promise<TargetTextReadResult>;
}

const cursorSchema = Type.Optional(
  Type.String({
    maxLength: 128,
    description: '使用本工具上次返回的续读游标；不能跨文件、版本或 Session 使用。',
  }),
);
export function createTargetChangeEvidenceTools(
  options: TargetChangeEvidenceOptions,
): ToolDefinition[] {
  const parameters = Type.Object({ cursor: cursorSchema }, { additionalProperties: false });
  const cursors = new SourceCursors();
  const changes: ToolDefinition = {
    name: 'list_target_changes',
    label: '列出固定变化',
    description:
      '分页列出固定 base/target 的变化，每页最多 100 项。目录和变化清单不算正文阅读；无 base、空变化和失败分别返回。',
    parameters,
    execute: async (id, params: Static<typeof parameters>) => {
      const fact = sourceFact(options, 'list_target_changes', 'changes', null, null);
      try {
        if (options.baseCommit === null)
          return respond(options, id, fact, {
            status: 'no_baseline',
            changes: [],
            nextCursor: null,
          });
        const raw = [...(await options.listChanges())].sort((a, b) =>
          (a.newPath ?? a.oldPath ?? '').localeCompare(b.newPath ?? b.oldPath ?? ''),
        );
        const sanitize = options.sanitize ?? ((value: string) => value);
        const rows = raw.map((row) => ({
          kind: row.kind,
          oldPath: row.oldPath === null ? null : sanitize(row.oldPath),
          newPath: row.newPath === null ? null : sanitize(row.newPath),
          readable: row.readable,
          ...(row.unreadableReason ? { unreadableReason: sanitize(row.unreadableReason) } : {}),
        }));
        fact.redacted = rows.some(
          (row, i) => row.oldPath !== raw[i].oldPath || row.newPath !== raw[i].newPath,
        );
        return listPage(options, cursors, id, fact, rows, params.cursor, 'changes');
      } catch (error) {
        return failed(options, id, fact, error);
      }
    },
  };
  return [
    changes,
    createSourceTextTool(options, 'read_target_diff', async (_version, path) =>
      options.readDiff(path),
    ),
    createSourceTextTool(options, 'read_target_file_version', options.readFile),
  ];
}

export function createSourceTextTool(
  options: SourceToolOptions,
  name: 'read_target_file' | 'read_target_file_version' | 'read_target_diff',
  read: (version: 'base' | 'target', path: string) => Promise<TargetTextReadResult>,
): ToolDefinition {
  const parameters = Type.Object(
    {
      path: Type.String({ maxLength: 2048, description: '固定版本中的非敏感仓库相对路径' }),
      ...(name === 'read_target_file_version'
        ? { version: Type.Union([Type.Literal('base'), Type.Literal('target')]) }
        : {}),
      cursor: cursorSchema,
    },
    { additionalProperties: false },
  );
  const cursors = new SourceCursors();
  return {
    name,
    label: name === 'read_target_diff' ? '读取固定文本 diff' : '读取固定版本文件',
    description:
      '只读固定版本普通文本，先脱敏再按 UTF-8 分页，每页最多 32 KiB；使用返回游标续读。回执记录实际返回范围，diff 不算全文。不能读取敏感路径、symlink、子模块或二进制。',
    parameters,
    execute: async (id, params: { path: string; version?: 'base' | 'target'; cursor?: string }) => {
      const version = name === 'read_target_file_version' ? params.version : 'target';
      const commit =
        name === 'read_target_diff'
          ? null
          : version === 'base'
            ? options.baseCommit
            : options.targetCommit;
      const fact = sourceFact(
        options,
        name,
        name === 'read_target_diff' ? 'diff' : 'file',
        null,
        commit,
      );
      try {
        if (version !== 'base' && version !== 'target') throw new SourceInputError();
        const path = assertSourcePath(params.path);
        const sanitize = options.sanitize ?? ((value: string) => value);
        const safePath = sanitize(path);
        fact.path = safePath === path ? path : null;
        const result = await read(version, path);
        if (!['ok', 'empty'].includes(result.status))
          return respond(options, id, fact, {
            status: result.status,
            path: fact.path,
            nextCursor: null,
            reason: result.status,
          });
        const raw = result.content ?? '';
        const content = sanitize(raw);
        fact.redacted = content !== raw || safePath !== path;
        fact.contentHash = sourceHash(content);
        const identity = sourceHash(
          JSON.stringify([
            name,
            options.baseCommit,
            options.targetCommit,
            path,
            version,
            fact.contentHash,
          ]),
        );
        const page = sourceTextPage(content, cursors.offset(params.cursor, identity));
        fact.range = page.range;
        fact.pageHash = sourceHash(page.content);
        const nextCursor = cursors.next(identity, page.range.end, page.range.total);
        return respond(options, id, fact, {
          status: nextCursor ? 'partial' : content === '' ? 'empty' : 'ok',
          version,
          path: fact.path,
          content: page.content,
          bytes: Buffer.byteLength(page.content),
          range: page.range,
          redacted: fact.redacted,
          nextCursor,
        });
      } catch (error) {
        return failed(options, id, fact, error);
      }
    },
  };
}

export function createSourceListTools(
  options: SourceToolOptions & {
    listFiles: () => Promise<string[]>;
    search: (query: string) => Promise<TargetSearchResult>;
  },
): ToolDefinition[] {
  return (['list_target_files', 'search_target_files'] as const).map((name) => {
    const parameters = Type.Object(
      {
        ...(name === 'search_target_files'
          ? { query: Type.String({ minLength: 1, maxLength: 1024 }) }
          : {}),
        cursor: cursorSchema,
      },
      { additionalProperties: false },
    );
    const cursors = new SourceCursors();
    return {
      name,
      label: name === 'list_target_files' ? '列出目标文件' : '搜索目标文件',
      description:
        '只返回固定 target 的受控文件路径，每页最多 100 项，不返回正文。搜索限制单独列出，不能将未命中视为全仓不存在；返回游标需续读。',
      parameters,
      execute: async (id: string, params: { query?: string; cursor?: string }) => {
        const fact = sourceFact(
          options,
          name,
          name === 'list_target_files' ? 'paths' : 'search',
          null,
          options.targetCommit,
        );
        try {
          const sanitize = options.sanitize ?? ((value: string) => value);
          let raw: string[];
          let queryScope = '';
          if (name === 'search_target_files') {
            if (
              typeof params.query !== 'string' ||
              !params.query.trim() ||
              params.query.length > 1024
            )
              throw new SourceInputError();
            queryScope = sourceHash(params.query);
            const result = await options.search(params.query);
            raw = result.paths;
            fact.limits = result.limits;
          } else {
            raw = await options.listFiles();
            fact.limits = ['regular_non_sensitive_paths_only'];
          }
          const paths = raw.map((path) => sanitize(path));
          fact.redacted = paths.some((path, i) => path !== raw[i]);
          return listPage(options, cursors, id, fact, paths, params.cursor, 'paths', queryScope);
        } catch (error) {
          return failed(options, id, fact, error);
        }
      },
    };
  });
}

function sourceFact(
  options: SourceToolOptions,
  tool: SourceTool,
  category: SourceReadFact['category'],
  path: string | null,
  commit: string | null,
): SourceReadFact {
  return {
    tool,
    category,
    status: 'unavailable',
    path,
    commit,
    baseCommit: options.baseCommit,
    targetCommit: options.targetCommit,
    contentHash: null,
    pageHash: null,
    range: null,
    redacted: false,
    limits: [],
  };
}
async function listPage(
  options: SourceToolOptions,
  cursors: SourceCursors,
  id: string,
  fact: SourceReadFact,
  rows: unknown[],
  cursor: string | undefined,
  field: 'paths' | 'changes',
  scope = '',
) {
  fact.contentHash = sourceHash(JSON.stringify(rows));
  const identity = sourceHash(
    JSON.stringify([
      fact.tool,
      options.baseCommit,
      options.targetCommit,
      fact.contentHash,
      scope,
      fact.limits,
    ]),
  );
  const start = cursors.offset(cursor, identity);
  const page: unknown[] = [];
  for (const row of rows.slice(start, start + 100)) {
    if (Buffer.byteLength(JSON.stringify([...page, row])) > 32 * 1024) break;
    page.push(row);
  }
  if (page.length === 0 && start < rows.length) throw new SourceInputError();
  fact.range = { unit: 'items', start, end: start + page.length, total: rows.length };
  fact.pageHash = sourceHash(JSON.stringify(page));
  const nextCursor = cursors.next(identity, fact.range.end, rows.length);
  return respond(options, id, fact, {
    status: nextCursor ? 'partial' : page.length === 0 ? 'empty' : 'ok',
    [field]: page,
    range: fact.range,
    limits: fact.limits,
    redacted: fact.redacted,
    nextCursor,
  });
}
async function respond(
  options: SourceToolOptions,
  id: string,
  fact: SourceReadFact,
  body: Record<string, unknown>,
) {
  fact.status = body.status as SourceReadFact['status'];
  return recordedSourceResult(options.sourceReads, id, fact, {
    baseCommit: options.baseCommit,
    targetCommit: options.targetCommit,
    ...body,
  });
}
async function failed(
  options: SourceToolOptions,
  id: string,
  fact: SourceReadFact,
  error: unknown,
) {
  return respond(
    options,
    id,
    {
      ...fact,
      path: null,
      contentHash: null,
      pageHash: null,
      range: null,
      limits: [error instanceof SourceInputError ? 'invalid_request' : 'read_failed'],
    },
    {
      status: 'unavailable',
      reason: error instanceof SourceInputError ? 'invalid_request' : 'read_failed',
      nextCursor: null,
    },
  );
}
