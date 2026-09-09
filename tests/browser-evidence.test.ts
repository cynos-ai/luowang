import { strict as assert } from 'node:assert';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent';
import {
  createRunEvidenceStore,
  createReviewerEvidenceTools,
  createRunnerEvidenceTools,
} from '../src/server/runs/evidence.js';
import { createReviewReadOrder } from '../src/server/runs/review-order.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';

const snapshot = 'page-2026-09-08T05-59-05-339Z.yml';
const consoleFile = 'console-2026-09-08T05-58-41-973Z.log';
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(secrets: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'luowang-browser-evidence-'));
  cleanup.push(dir);
  const workspace = new RunWorkspace('01K00000000000000000000000', dir);
  await workspace.create();
  const transport = localEvidenceTransport();
  const store = createRunEvidenceStore(workspace, transport.oss, {
    reviewSecrets: () => secrets,
  });
  store.allowBrowserRecords!();
  const tools = createReviewerEvidenceTools(store);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { workspace, transport, store, tool };
}
const execute = async (tool: ToolDefinition, filename?: string) =>
  (await tool.execute(
    'read',
    filename ? { filename } : {},
    undefined,
    undefined,
    {} as never,
  )) as AgentToolResult<Record<string, unknown>>;
const text = (result: Awaited<ReturnType<typeof execute>>) =>
  result.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

it('lists browser records with their reader and reads actual post-return state without another screenshot', async () => {
  const { workspace, store, tool } = await fixture();
  await writeFile(
    join(workspace.evidenceDirectory, snapshot),
    '- heading "登录 Cynos"\n- textbox "邮箱"\n',
  );
  await writeFile(join(workspace.evidenceDirectory, consoleFile), '[INFO] initialized\n');
  await writeFile(join(workspace.evidenceDirectory, 'arbitrary.txt'), 'not a browser record');
  await store.uploadAll();
  const list = JSON.parse(text(await execute(tool('list_evidence_files'))));
  assert.equal(list.length, 2);
  assert.ok(
    list.every(
      (r: { kind: string; readTool: string }) =>
        r.kind === 'browser' && r.readTool === 'read_browser_evidence',
    ),
  );
  const result = JSON.parse(text(await execute(tool('read_browser_evidence'), snapshot)));
  assert.match(result.content, /登录 Cynos/);
  assert.doesNotMatch(result.content, /昵称/);
  assert.equal(result.filename, snapshot);
  assert.equal(store.reviewReadCount!(), 1);
});

it('redacts browser records before upload and again at read, without giving the model a text writer', async () => {
  const secrets = ['synthetic-known-secret'];
  const { workspace, store, transport } = await fixture(secrets);
  await writeFile(
    join(workspace.evidenceDirectory, snapshot),
    'synthetic-known-secret\nCookie: session=raw-cookie\nfuture-secret\n',
  );
  await store.upload(snapshot);
  const local = (await workspace.readEvidence(snapshot)).toString();
  assert.doesNotMatch(local, /synthetic-known-secret|raw-cookie/);
  assert.equal(transport.objects.get(`${workspace.runId}/${snapshot}`)!.toString(), local);
  secrets.push('future-secret');
  assert.doesNotMatch(await store.readBrowserEvidence!(snapshot), /future-secret/);
});

it('rejects wrong readers and unknown IDs without I/O, failure counters or satisfying image read order', async () => {
  const { workspace, store, tool, transport } = await fixture();
  await writeFile(join(workspace.evidenceDirectory, snapshot), '- heading "登录"');
  await writeFile(join(workspace.evidenceDirectory, 'login.png'), Buffer.from([137, 80, 78, 71]));
  await store.uploadAll();
  let failures = 0;
  const order = createReviewReadOrder(
    async () => 'artifact',
    ['login.png'],
    () => {
      failures++;
    },
  );
  await order.readArtifact('plan.md');
  for (const [reader, filename] of [
    ['read_command_evidence', snapshot],
    ['read_evidence_image', snapshot],
    ['read_browser_evidence', 'login.png'],
    ['read_browser_evidence', '../plan.md'],
    ['read_browser_evidence', '/etc/passwd'],
    ['read_browser_evidence', 'other-run/' + snapshot],
    ['read_browser_evidence', 'notes.txt'],
  ]) {
    const result = await execute(order.wrap(tool(reader)), filename);
    assert.equal(result.details?.errorKind, 'invalid_evidence_request');
  }
  assert.equal(store.readFailureCount!(), 0);
  assert.equal(failures, 0);
  assert.deepEqual(transport.reads, []);
  assert.throws(order.assertReady, /原始图片/);
  await execute(order.wrap(tool('read_evidence_image')), 'login.png');
  await execute(order.wrap(tool('read_browser_evidence')), snapshot);
  assert.doesNotThrow(order.assertReady);
  assert.equal(failures, 0);
});

it.each(['missing', 'mutated'])(
  'keeps a genuinely %s uploaded browser record blocking',
  async (mode) => {
    const { workspace, store, tool, transport } = await fixture();
    await writeFile(join(workspace.evidenceDirectory, snapshot), '- heading "登录"');
    await store.upload(snapshot);
    const key = `${workspace.runId}/${snapshot}`;
    if (mode === 'missing') transport.objects.delete(key);
    else transport.objects.set(key, Buffer.from('different'));
    let failures = 0;
    const order = createReviewReadOrder(
      async () => 'artifact',
      [],
      () => {},
      false,
      () => {},
      () => {
        failures++;
      },
    );
    await order.readArtifact('plan.md');
    const result = await execute(order.wrap(tool('read_browser_evidence')), snapshot);
    assert.equal(result.details?.error, true);
    assert.equal(failures, 1);
    assert.ok(store.readFailureCount!() > 0);
  },
);

it('requires plan and existing patch first, without making all browser records mandatory', async () => {
  const { workspace, store, tool, transport } = await fixture();
  await writeFile(join(workspace.evidenceDirectory, snapshot), '- heading "登录"');
  await store.upload(snapshot);
  const order = createReviewReadOrder(
    async () => 'artifact',
    [],
    () => {},
    true,
  );
  const read = () => execute(order.wrap(tool('read_browser_evidence')), snapshot);
  assert.equal((await read()).details?.error, true);
  await order.readArtifact('plan.md');
  assert.equal((await read()).details?.error, true);
  assert.deepEqual(transport.reads, []);
  await order.readArtifact('scenario-changes.patch');
  assert.doesNotThrow(order.assertReady);
  assert.equal((await read()).details?.error, undefined);
});

it('defers Runner text uploads and sends a sanitized immutable byte snapshot, not a reopened file', async () => {
  const { workspace, store, transport } = await fixture(['synthetic-secret']);
  await writeFile(join(workspace.evidenceDirectory, snapshot), 'synthetic-secret\n原始状态');
  const upload = createRunnerEvidenceTools(store).find((t) => t.name === 'upload_evidence')!;
  assert.equal((await execute(upload, snapshot)).details?.status, 'deferred');
  assert.equal(transport.objects.size, 0);
  const put = transport.oss.putObject.bind(transport.oss);
  transport.oss.putObject = async (key, body, type) => {
    await writeFile(
      join(workspace.evidenceDirectory, snapshot),
      'synthetic-secret\nlate producer write',
    );
    return put(key, body, type);
  };
  await store.upload(snapshot);
  const read = await store.readBrowserEvidence!(snapshot);
  assert.doesNotMatch(read, /synthetic-secret|late producer/);
  assert.match(read, /原始状态/);
});

it('validates the requested image ID before consulting vision metadata and never delivers an unsupported image', async () => {
  const { workspace, store, transport } = await fixture();
  await writeFile(join(workspace.evidenceDirectory, snapshot), '- heading "登录"');
  await writeFile(join(workspace.evidenceDirectory, 'login.png'), Buffer.from([137, 80, 78, 71]));
  await store.uploadAll();
  let checks = 0;
  const image = createReviewerEvidenceTools(store, async () => {
    checks++;
    return false;
  }).find((t) => t.name === 'read_evidence_image')!;
  assert.equal((await execute(image, snapshot)).details?.errorKind, 'invalid_evidence_request');
  assert.equal(checks, 0);
  const result = await execute(image, 'login.png');
  assert.equal(checks, 1);
  assert.equal(result.details?.error, true);
  assert.ok(!result.content.some((c) => c.type === 'image'));
  assert.deepEqual(transport.reads, []);
});

it('bounds output with explicit truncation but rejects binary and oversized browser uploads', async () => {
  const { workspace, store } = await fixture();
  await writeFile(join(workspace.evidenceDirectory, snapshot), '检查'.repeat(20000));
  await store.upload(snapshot);
  const result = JSON.parse(await store.readBrowserEvidence!(snapshot));
  assert.match(result.content, /\[browser evidence truncated\]$/);
  assert.doesNotMatch(result.content, /\uFFFD/);
  for (const bytes of [Buffer.from([255, 0]), Buffer.alloc(1024 * 1024 + 1, 97)]) {
    await writeFile(join(workspace.evidenceDirectory, consoleFile), bytes);
    await assert.rejects(() => store.upload(consoleFile));
  }
});

it('does not authorize browser text based on a filename alone when MCP is not enabled for this Run', async () => {
  const { workspace, transport } = await fixture();
  const store = createRunEvidenceStore(workspace, transport.oss);
  await writeFile(join(workspace.evidenceDirectory, snapshot), '- heading "登录"');
  await store.upload(snapshot);
  assert.deepEqual(store.browserEvidenceIds!(), []);
  await assert.rejects(() => store.readBrowserEvidence!(snapshot));
  assert.deepEqual(transport.reads, []);
});

it('refuses unuploaded, other-store, forged arbitrary names and symlink records', async () => {
  const { workspace, store, transport } = await fixture(['sensitive']);
  await writeFile(join(workspace.evidenceDirectory, snapshot), 'sensitive');
  await assert.rejects(() => store.readBrowserEvidence!(snapshot));
  await store.upload(snapshot);
  const other = await fixture();
  await assert.rejects(() => other.store.readBrowserEvidence!(snapshot));
  assert.deepEqual(other.transport.reads, []);
  const outside = join(workspace.evidenceDirectory, '..', 'private.txt');
  await writeFile(outside, 'sensitive');
  await symlink(outside, join(workspace.evidenceDirectory, consoleFile));
  await assert.rejects(() => store.upload(consoleFile));
  await assert.rejects(() => workspace.replaceBrowserEvidence('../private.txt', 'changed'));
  assert.equal(transport.objects.size, 1);
});
