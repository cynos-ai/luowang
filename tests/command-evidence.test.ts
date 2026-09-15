import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import {
  createRunEvidenceStore,
  createReviewerEvidenceTools,
} from '../src/server/runs/evidence.js';
import { createReviewReadOrder } from '../src/server/runs/review-order.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';
import {
  commandFailureMessage,
  ControlledCommandError,
} from '../src/server/runs/command-runner.js';
import { createTestDataManager, createTestDataTools } from '../src/server/runs/test-data.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'luowang-command-evidence-'));
  cleanup.push(dir);
  const workspace = new RunWorkspace('01K00000000000000000000000', dir);
  await workspace.create();
  const transport = localEvidenceTransport();
  return { workspace, transport, store: createRunEvidenceStore(workspace, transport.oss) };
}
const output = (exitCode: number | null = 0) => ({
  stdout: '4 checks\n',
  stderr: '',
  exitCode,
  environmentKeys: ['PATH'],
});

it.each([0, 1, null])(
  'retains the actual exit code %s and output without interpreting it as a product result',
  async (exitCode) => {
    const { store, transport } = await fixture();
    const id = await store.captureCommand('npm test', 'fixed-target', output(exitCode), []);
    await store.uploadAll();
    const captured = JSON.parse(await store.readCommandEvidence(id));
    assert.equal(captured.runId, '01K00000000000000000000000');
    assert.equal(captured.targetCommit, 'fixed-target');
    assert.equal(captured.result.exitCode, exitCode);
    assert.equal(captured.result.stdout, '4 checks\n');
    assert.equal(transport.reads.length, 1);
  },
);

it('distinguishes execution errors and redacts known and quoted credentials before persistence', async () => {
  const { store, workspace } = await fixture();
  const secret = 'known "credential" with spaces';
  const result = output(1);
  result.stdout = `${secret}\n${JSON.stringify(secret)}\n${encodeURIComponent(secret)}\nSet-Cookie: session=RAW_SESSION; another=SECOND_COOKIE\n{"password":"unknown spaced password"}\nAuthorization: Bearer RAW_AUTH\n401 != 200`;
  const id = await store.captureCommand(`npm test ${secret}`, 'fixed', result, [secret]);
  const text = (await workspace.readEvidence(id)).toString();
  for (const sensitive of [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    'RAW_SESSION',
    'SECOND_COOKIE',
    'unknown spaced password',
    'RAW_AUTH',
  ])
    assert.ok(!text.includes(sensitive));
  assert.match(text, /401 != 200/);
  const errorId = await store.captureCommand('npm test', 'fixed', { error: `timeout ${secret}` }, [
    secret,
  ]);
  assert.deepEqual(JSON.parse(await store.readCommandEvidence(errorId)).result, {
    error: 'timeout [REDACTED]',
  });
});

it('only lists captured command IDs and refuses other Runs, forged files, cleanup files and arbitrary paths', async () => {
  const { store, workspace } = await fixture();
  const other = await fixture();
  const id = await store.captureCommand('npm test', 'fixed', output(), []);
  for (const filename of ['command-99.json', 'cleanup-query-fake.json', 'notes.txt'])
    await writeFile(join(workspace.evidenceDirectory, filename), 'not command evidence');
  const tools = createReviewerEvidenceTools(store);
  const list = await tools
    .find((t) => t.name === 'list_evidence_files')!
    .execute('list', {}, undefined, undefined, {} as never);
  assert.equal(JSON.stringify(list.content).includes(id), true);
  assert.equal(JSON.stringify(list.content).includes('command-99'), false);
  for (const filename of [
    'command-99.json',
    'cleanup-query-fake.json',
    '../plan.md',
    '/etc/passwd',
  ])
    await assert.rejects(() => store.readCommandEvidence(filename), /不是本 Run/);
  await assert.rejects(() => other.store.readCommandEvidence(id), /不是本 Run/);
  assert.deepEqual(other.transport.reads, []);
});

it('rejects mutated local and uploaded command evidence', async () => {
  const { store, workspace, transport } = await fixture();
  const id = await store.captureCommand('npm test', 'fixed', output(), []);
  const original = await workspace.readEvidence(id);
  await writeFile(join(workspace.evidenceDirectory, id), 'changed');
  await assert.rejects(() => store.readCommandEvidence(id), /内容已改变/);
  assert.equal((await store.uploadAll()).failures.length, 1);
  await writeFile(join(workspace.evidenceDirectory, id), original);
  await store.uploadAll();
  transport.objects.set(`${workspace.runId}/${id}`, Buffer.from('changed remotely'));
  await assert.rejects(() => store.readCommandEvidence(id), /内容已改变/);
});

it('does not hide a captured command when its file disappears before upload', async () => {
  const { store, workspace } = await fixture();
  const id = await store.captureCommand('npm test', 'fixed', output(), []);
  await rm(join(workspace.evidenceDirectory, id));
  assert.ok((await store.list()).some((file) => file.name === id));
  assert.equal((await store.uploadAll()).failures.length, 1);
  await assert.rejects(() => store.readCommandEvidence(id));
});

it('retains local command evidence without OSS but does not pretend publication succeeded', async () => {
  const { workspace } = await fixture();
  const store = createRunEvidenceStore(workspace);
  const id = await store.captureCommand('npm test', 'fixed', output(), []);
  assert.equal(JSON.parse(await store.readCommandEvidence(id)).result.exitCode, 0);
  const uploaded = await store.uploadAll();
  assert.equal(uploaded.references.length, 0);
  assert.equal(uploaded.failures.length, 1);
});

it('marks bounded UTF-8 output as truncated rather than complete', async () => {
  const { store } = await fixture();
  const result = output();
  result.stdout = '检查'.repeat(40000);
  const id = await store.captureCommand('npm test', 'fixed', result, []);
  const captured = JSON.parse(await store.readCommandEvidence(id));
  assert.match(captured.result.stdout, /\[command evidence truncated\]$/);
  assert.ok(!captured.result.stdout.includes('\uFFFD'));
  assert.ok(Buffer.byteLength(captured.result.stdout) < 66 * 1024);
});

it('keeps known command diagnostics redacted and unknown or lookalike errors opaque', async () => {
  const { store } = await fixture();
  const diagnostic = commandFailureMessage(
    new ControlledCommandError('COMMAND_FAILED', '执行服务不可用，token=known-credential'),
  );
  const id = await store.captureCommand('npm test', 'fixed', { error: diagnostic }, [
    'known-credential',
  ]);
  const result = JSON.parse(await store.readCommandEvidence(id)).result;
  assert.match(result.error, /COMMAND_FAILED.*执行服务不可用/);
  assert.doesNotMatch(result.error, /known-credential/);
  assert.equal(result.exitCode, undefined);
  for (const error of [
    new Error('/private/path secret-value'),
    { name: 'ControlledCommandError', code: 'COMMAND_FAILED', message: 'secret-value' },
  ]) {
    const message = commandFailureMessage(error);
    assert.match(message, /具体原因未确认/);
    assert.doesNotMatch(message, /private|secret-value/);
  }
});

it('states Harness cleanup ownership without exposing cleanup claims', () => {
  const managed = createTestDataManager({
    cleanupAdapter: {
      id: 'owned',
      async cleanupAndVerify() {
        return { absent: true, content: 'synthetic boundary only' };
      },
    },
  });
  const tools = createTestDataTools(managed, '01K00000000000000000000000', undefined);
  assert.match(
    tools.find((t) => t.name === 'get_test_data_prefix')!.description,
    /最终 Main 结束后/,
  );
  assert.ok(!tools.some((t) => t.name === 'capture_test_data_cleanup_query'));
  assert.ok(!tools.some((t) => t.name === 'submit_test_data_cleanup_claim'));
});

it('requires plan and existing patch before reading commands, without requiring a proof for every command', async () => {
  const { store, workspace } = await fixture();
  const id = await store.captureCommand('npm test', 'fixed', output(), []);
  let failures = 0;
  const order = createReviewReadOrder(
    async () => 'artifact',
    [],
    () => {},
    true,
    () => {
      failures++;
    },
  );
  const tool = order.wrap(
    createReviewerEvidenceTools(store).find((t) => t.name === 'read_command_evidence')!,
  );
  const read = async (filename: string) => {
    const result = await tool.execute('read', { filename }, undefined, undefined, {} as never);
    return result.details as { error?: boolean } | undefined;
  };
  assert.equal((await read(id))?.error, true);
  await order.readArtifact('plan.md');
  assert.equal((await read(id))?.error, true);
  assert.equal(store.reviewReadCount!(), 0);
  await order.readArtifact('scenario-changes.patch');
  assert.doesNotThrow(() => order.assertReady());
  assert.equal((await read(id))?.error, undefined);
  assert.equal((await read('../plan.md'))?.error, true);
  assert.equal(failures, 0);
  await writeFile(join(workspace.evidenceDirectory, id), 'changed');
  assert.equal((await read(id))?.error, true);
  assert.equal(failures, 1);
  assert.doesNotThrow(() => order.assertReady());
});
