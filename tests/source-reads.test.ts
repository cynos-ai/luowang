import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  createSourceListTools,
  createSourceTextTool,
  createTargetChangeEvidenceTools,
} from '../src/server/runs/change-evidence.js';
import {
  SourceReadStore,
  sourceCoverage,
  sourceHash,
  type SourceReadReceipt,
} from '../src/server/runs/source-reads.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { redactCommandText } from '../src/server/runs/evidence.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});
const commits = { baseCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) };
const identity = (text: string) => text;
async function invoke(tool: ToolDefinition, params: object = {}) {
  const result = await tool.execute('private-call-id', params);
  return JSON.parse(
    result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(''),
  );
}
function fixture(persist?: (text: string) => Promise<void>) {
  let saved = '';
  const store = new SourceReadStore('run-one', sourceHash('repo-one'), async (text) => {
    await persist?.(text);
    saved = text;
  });
  const options = { ...commits, sourceReads: store.session('main-planning'), sanitize: identity };
  return { store, options, saved: () => saved };
}
describe('fixed source read receipts', () => {
  it('records exactly returned safe UTF-8 pages, with honest gaps, duplicate and out-of-order coverage', async () => {
    const context = fixture();
    const secret = 'a-real-private-value';
    const original = '中'.repeat(12000) + secret + '文'.repeat(12000);
    const safe = original.replace(secret, '[REDACTED]');
    const tool = createSourceTextTool(
      { ...context.options, sanitize: (value) => value.replace(secret, '[REDACTED]') },
      'read_target_file',
      async () => ({ status: 'ok', content: original }),
    );
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await invoke(tool, { path: 'src/main.ts', ...(cursor ? { cursor } : {}) });
      assert.equal(page.receipt.pageHash, sourceHash(page.content));
      assert.equal(page.receipt.contentHash, sourceHash(safe));
      assert.equal(page.receipt.redacted, true);
      assert.equal(page.range.end - page.range.start, Buffer.byteLength(page.content));
      assert.ok(page.bytes <= 32 * 1024);
      assert.doesNotMatch(page.content, /\ufffd/);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(pages.map((page) => page.content).join(''), safe);
    const receipts = pages.map((page) => page.receipt as SourceReadReceipt);
    assert.equal(sourceCoverage([receipts[0], receipts[2]]).fullSafeText, false);
    assert.equal(
      sourceCoverage([receipts[2], receipts[0], receipts[1], receipts[0]]).fullSafeText,
      true,
    );
    assert.equal(
      sourceCoverage([receipts[2], receipts[0], receipts[1], receipts[0]]).coveredBytes,
      Buffer.byteLength(safe),
    );
    assert.doesNotMatch(context.saved(), new RegExp(secret));
    assert.ok(!context.saved().includes('中中中'));
    assert.ok(!context.saved().includes('private-call-id'));
  });

  it('binds opaque cursors to Session, file, version, tool and safe content identity', async () => {
    const context = fixture();
    let content = 'x'.repeat(70000);
    const options = {
      ...context.options,
      listChanges: async () => [],
      readDiff: async () => ({ status: 'ok' as const, content }),
      readFile: async () => ({ status: 'ok' as const, content }),
    };
    const tools = createTargetChangeEvidenceTools(options);
    const file = tools.find((tool) => tool.name === 'read_target_file_version')!;
    const first = await invoke(file, { version: 'target', path: 'file.ts' });
    for (const params of [
      { version: 'base', path: 'file.ts' },
      { version: 'target', path: 'other.ts' },
    ]) {
      assert.equal(
        (await invoke(file, { ...params, cursor: first.nextCursor })).reason,
        'invalid_request',
      );
    }
    const other = createTargetChangeEvidenceTools(options).find((tool) => tool.name === file.name)!;
    assert.equal(
      (await invoke(other, { version: 'target', path: 'file.ts', cursor: first.nextCursor }))
        .status,
      'unavailable',
    );
    assert.equal(
      (await invoke(tools[1], { path: 'file.ts', cursor: first.nextCursor })).status,
      'unavailable',
    );
    assert.equal(
      (await invoke(file, { version: 'target', path: 'file.ts', cursor: 'forged-offset' })).status,
      'unavailable',
    );
    content += 'changed sanitizer output';
    assert.equal(
      (await invoke(file, { version: 'target', path: 'file.ts', cursor: first.nextCursor })).status,
      'unavailable',
    );
  });

  it('distinguishes successful empty files, absent base, unreadable content and dependency failures', async () => {
    const context = fixture();
    for (const status of ['empty', 'no_baseline', 'unreadable', 'unavailable'] as const) {
      const tool = createSourceTextTool(context.options, 'read_target_file', async () => ({
        status,
        content: '',
        reason: 'SECRET_ERROR_DO_NOT_RETURN',
      }));
      const result = await invoke(tool, { path: 'file.ts' });
      assert.equal(result.status, status);
      assert.equal(sourceCoverage([result.receipt]).fullSafeText, status === 'empty');
      assert.ok(!JSON.stringify(result).includes('SECRET_ERROR_DO_NOT_RETURN'));
    }
    const failing = createSourceTextTool(context.options, 'read_target_file', async () => {
      throw new Error('PRIVATE_LOCAL_PATH');
    });
    const result = await invoke(failing, { path: 'file.ts' });
    assert.equal(result.reason, 'read_failed');
    assert.equal(result.receipt.path, null);
    assert.ok(!context.saved().includes('PRIVATE_LOCAL_PATH'));
  });

  it('does not return source text or phantom receipts when persistence fails, and can recover', async () => {
    let fail = true;
    const context = fixture(async () => {
      if (fail) throw new Error('disk-private-path');
    });
    const tool = createSourceTextTool(context.options, 'read_target_file', async () => ({
      status: 'ok',
      content: 'CONTENT_NOT_DELIVERED_ON_FAILURE',
    }));
    const first = await invoke(tool, { path: 'file.ts' });
    assert.deepEqual(first, { status: 'unavailable', reason: 'source_receipt_write_failed' });
    assert.equal((await invoke(context.store.queryTool(identity))).receipts.length, 0);
    fail = false;
    assert.equal((await invoke(tool, { path: 'file.ts' })).status, 'ok');
    assert.equal((await invoke(context.store.queryTool(identity))).receipts.length, 1);
  });

  it('paginates paths and changes without claiming body coverage or storing search inputs', async () => {
    const context = fixture();
    const paths = Array.from({ length: 101 }, (_, index) => `src/file-${index}.ts`);
    const tools = createSourceListTools({
      ...context.options,
      listFiles: async () => paths,
      search: async () => ({
        paths: paths.slice(0, 100),
        scannedFiles: 100,
        limits: ['match_limit', 'large_files_skipped', 'unreadable_or_unavailable_files_skipped'],
      }),
    });
    const first = await invoke(tools[0]);
    const last = await invoke(tools[0], { cursor: first.nextCursor });
    assert.equal(first.paths.length, 100);
    assert.equal(last.paths.length, 1);
    assert.equal(last.receipt.category, 'paths');
    assert.equal(sourceCoverage([first.receipt, last.receipt]).fullSafeText, false);
    const search = await invoke(tools[1], { query: 'PRIVATE_SEARCH_INPUT' });
    assert.ok(search.limits.includes('match_limit'));
    assert.equal(search.receipt.category, 'search');
    assert.ok(!context.saved().includes('PRIVATE_SEARCH_INPUT'));
    const changed = createTargetChangeEvidenceTools({
      ...context.options,
      listChanges: async () => [
        {
          oldPath: 'old.ts',
          newPath: 'new.ts',
          kind: 'renamed',
          oldMode: '100644',
          newMode: '100644',
          oldType: 'blob',
          newType: 'blob',
          readable: true,
        },
      ],
      readFile: async () => ({ status: 'empty' }),
      readDiff: async () => ({ status: 'ok', content: 'a diff' }),
    });
    const change = await invoke(changed[0]);
    assert.equal(change.changes[0].oldPath, 'old.ts');
    assert.equal(change.receipt.category, 'changes');
    assert.equal(
      sourceCoverage([(await invoke(changed[1], { path: 'new.ts' })).receipt]).fullSafeText,
      false,
    );
  });

  it('scopes paginated queries to the Run and stage, rejects foreign cursors and returns no source', async () => {
    const context = fixture();
    const tool = createSourceTextTool(context.options, 'read_target_file', async () => ({
      status: 'ok',
      content: 'SOURCE_BODY',
    }));
    await Promise.all(
      Array.from({ length: 27 }, (_, index) => invoke(tool, { path: `file-${index}.ts` })),
    );
    const query = context.store.queryTool(identity);
    const first = await invoke(query, { stage: 'main-planning' });
    assert.ok(first.nextCursor);
    const last = await invoke(query, { stage: 'main-planning', cursor: first.nextCursor });
    assert.equal(first.receipts.length + last.receipts.length, 27);
    assert.equal((await invoke(query, { stage: 'initialization-candidate' })).receipts.length, 0);
    assert.equal(
      (await invoke(query, { stage: 'initialization-candidate', cursor: first.nextCursor })).status,
      'unavailable',
    );
    assert.equal((await invoke(query, { runId: 'other' })).status, 'unavailable');
    assert.equal((await invoke(query, { path: '../outside' })).status, 'unavailable');
    assert.equal(
      (await invoke(fixture().store.queryTool(identity), { cursor: first.nextCursor })).status,
      'unavailable',
    );
    assert.ok(!JSON.stringify(first).includes('SOURCE_BODY'));
    assert.ok(
      first.receipts.every(
        (r: SourceReadReceipt) => r.stage === 'main-planning' && r.runId === 'run-one',
      ),
    );
    const candidate = createSourceTextTool(
      { ...context.options, sourceReads: context.store.session('initialization-candidate') },
      'read_target_file',
      async () => ({ status: 'empty' }),
    );
    const next = await invoke(candidate, { path: 'empty.ts' });
    assert.notEqual(next.receipt.sessionId, first.receipts[0].sessionId);
    assert.equal(next.receipt.stage, 'initialization-candidate');
    assert.equal(
      (await invoke(query, { stage: 'main-planning', path: 'file-1.ts' })).receipts.length,
      1,
    );
  });

  it('keeps persisted metadata outside public artifacts/evidence and rejects symlink replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-source-reads-'));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    const workspace = new RunWorkspace('01ARZ3NDEKTSV4RRFFQ69G5FAV', root);
    await workspace.create();
    const context = fixture((content) => workspace.writeSourceReads(content));
    const tool = createSourceTextTool(context.options, 'read_target_file', async () => ({
      status: 'ok',
      content: 'body',
    }));
    await invoke(tool, { path: 'file.ts' });
    const location = join(workspace.runningDirectory, 'source-reads.json');
    const saved = JSON.parse(await readFile(location, 'utf8'));
    assert.equal(saved.receipts.length, 1);
    assert.deepEqual(await workspace.list(), {});
    assert.deepEqual(await workspace.listEvidence(), []);
    await rm(location);
    const external = join(root, 'outside');
    await mkdir(external);
    await symlink(external, location, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await invoke(tool, { path: 'file.ts' })).reason, 'source_receipt_write_failed');
  });

  it('redacts credentials before assigning byte coordinates and never persists private paths', async () => {
    const context = fixture();
    const sanitize = (text: string) =>
      redactCommandText(text, ['private-account'], Number.MAX_SAFE_INTEGER);
    const tool = createSourceTextTool(
      { ...context.options, sanitize },
      'read_target_file',
      async () => ({ status: 'ok', content: 'token="sensitive-value"\nprivate-account' }),
    );
    const result = await invoke(tool, { path: 'private-account.ts' });
    assert.equal(result.receipt.path, null);
    assert.equal(result.range.total, Buffer.byteLength(result.content));
    assert.equal(result.redacted, true);
    assert.ok(!context.saved().includes('private-account'));
    assert.ok(!result.content.includes('sensitive-value'));
  });
});
