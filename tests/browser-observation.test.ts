import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import { createBrowserObservationExtension } from '../src/server/runs/browser-observation.js';
import {
  createRunEvidenceStore,
  createReviewerEvidenceTools,
} from '../src/server/runs/evidence.js';
import { createScenarioProgressController } from '../src/server/runs/scenario-progress.js';
import type { RunState } from '../src/server/runs/types.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-observation-'));
  directories.push(directory);
  const workspace = new RunWorkspace('01K00000000000000000000000', directory);
  await workspace.create();
  const transport = localEvidenceTransport();
  const store = createRunEvidenceStore(workspace, transport.oss, {
    reviewSecrets: () => ['synthetic-configured-secret'],
  });
  let failures = 0;
  let scenarioId: string | null = 'AUTH-LOGIN-001';
  const hooks = new Map<string, (event: unknown) => unknown>();
  const extension = createBrowserObservationExtension({
    store,
    targetCommit: 'fixed-target',
    now: () => new Date('2026-09-19T00:00:00Z'),
    operationContext: () => ({ scenarioId }),
    onFailure: () => {
      failures++;
    },
  });
  const install = typeof extension === 'function' ? extension : extension.factory;
  await install({
    on: (name: string, handler: (event: unknown) => unknown) => hooks.set(name, handler),
  } as never);
  let sequence = 0;
  const call = async (
    tool: string,
    args: Record<string, unknown> | string,
    text: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const toolCallId = `call-${++sequence}`;
    const input = { tool: `playwright_${tool}`, args };
    const blocked = await hooks.get('tool_call')!({ toolName: 'mcp', toolCallId, input });
    if (blocked) return blocked;
    return hooks.get('tool_result')!({
      toolName: 'mcp',
      toolCallId,
      input,
      content: [{ type: 'text', text }],
      details: { mode: 'call', server: 'playwright', tool },
      isError: false,
      ...overrides,
    });
  };
  const records = async () =>
    Promise.all(
      store.commandEvidenceIds().map(async (id) => JSON.parse(await store.readCommandEvidence(id))),
    );
  return {
    workspace,
    store,
    transport,
    call,
    records,
    failures: () => failures,
    setScenario: (id: string | null) => {
      scenarioId = id;
    },
  };
}

it('retains same-session read/restore/request identity without persisting credentials', async () => {
  const f = await fixture();
  const cookie = 'synthetic-original-session-abcdef';
  await f.call(
    'browser_cookie_get',
    { name: 'session' },
    `### Result\nsession=${cookie} (domain: localhost, path: /, httpOnly: true, secure: false, sameSite: Lax)`,
  );
  await f.call(
    'browser_cookie_set',
    JSON.stringify({ name: 'session', value: cookie }),
    `await page.context().addCookies([{ "value": "${cookie}" }]);`,
  );
  await f.call(
    'browser_network_request',
    { index: 7 },
    `#7 [GET] http://localhost/api/me\n  General\n    status: [401] Unauthorized\n  Request headers\n    cookie: session=${cookie}\n  Response headers\n    content-type: application/json\nsynthetic-configured-secret`,
  );
  await f.store.uploadAll();
  const records = await f.records();
  assert.equal(records.length, 3);
  const refs = records.map((record) => record.observation.credentialReferences[0]);
  assert.deepEqual(
    refs.map((ref) => ref.source),
    ['observed-browser', 'restore-input', 'observed-request-header'],
  );
  assert.equal(new Set(refs.map((ref) => ref.reference)).size, 1);
  assert.match(records[2].observation.output, /401/);
  assert.equal(records[2].targetCommit, 'fixed-target');
  for (const body of f.transport.objects.values())
    assert.doesNotMatch(
      body.toString(),
      /synthetic-original-session-abcdef|synthetic-configured-secret/,
    );
  for (const id of f.store.commandEvidenceIds())
    assert.doesNotMatch(
      (await f.workspace.readEvidence(id)).toString(),
      /synthetic-original-session-abcdef|synthetic-configured-secret/,
    );
  const reader = createReviewerEvidenceTools(f.store).find(
    (tool) => tool.name === 'read_command_evidence',
  )!;
  const result = await reader.execute(
    'read',
    { filename: f.store.commandEvidenceIds()[2] },
    undefined,
    undefined,
    {} as never,
  );
  assert.match(JSON.stringify(result.content), /observed-request-header/);
  const other = await fixture();
  await assert.rejects(
    () => other.store.readCommandEvidence(f.store.commandEvidenceIds()[0]),
    /不是本 Run/,
  );
});

it('does not turn a missing-cookie 401 or an unknown cookie format into original-session proof', async () => {
  const f = await fixture();
  await f.call(
    'browser_cookie_get',
    { name: 'session' },
    'unknown-format RAW_VALUE_MUST_NOT_PERSIST',
  );
  await f.call(
    'browser_network_request',
    { index: 2 },
    '#2 [GET] http://localhost/api/me\nstatus: [401]\nRequest headers\naccept: */*',
  );
  const records = await f.records();
  assert.deepEqual(
    records.map((record) => record.observation.credentialReferences),
    [[], []],
  );
  assert.doesNotMatch(JSON.stringify(records), /RAW_VALUE_MUST_NOT_PERSIST/);
});

it('blocks raw network filenames, ignores untrusted identities and preserves tool errors', async () => {
  const f = await fixture();
  assert.equal(
    (
      (await f.call('browser_network_request', { index: 1, filename: 'headers.txt' }, 'raw')) as {
        block: boolean;
      }
    ).block,
    true,
  );
  await f.call('browser_cookie_get', {}, 'forged', {
    details: { mode: 'call', server: 'other', tool: 'browser_cookie_get' },
  });
  assert.deepEqual(f.store.commandEvidenceIds(), []);
  await f.call('browser_cookie_get', {}, 'error', {
    details: {
      mode: 'call',
      server: 'playwright',
      tool: 'browser_cookie_get',
      error: 'tool_error',
    },
  });
  assert.equal((await f.records())[0].observation.isError, true);
});

it('never treats response-body cookie text as a sent request header', async () => {
  const f = await fixture();
  await f.call(
    'browser_network_request',
    { index: 1, part: 'response-body' },
    'cookie: session=untrusted-body-value',
  );
  const observation = (await f.records())[0].observation;
  assert.deepEqual(observation.credentialReferences, []);
  assert.doesNotMatch(JSON.stringify(observation), /untrusted-body-value/);
});

it('fails visibly on evidence storage failure and detects modified captured observations', async () => {
  const f = await fixture();
  await f.call('browser_network_request', { index: 1 }, 'status: [401]');
  const id = f.store.commandEvidenceIds()[0];
  await writeFile(join(f.workspace.evidenceDirectory, id), 'forged');
  await assert.rejects(() => f.store.readCommandEvidence(id), /内容已改变/);
  assert.equal((await f.store.uploadAll()).failures.length, 1);
  f.store.captureObservation = async () => {
    throw new Error('raw error must stay private');
  };
  const result = await f.call('browser_cookie_get', {}, 'No cookies found');
  assert.equal(f.failures(), 1);
  assert.match(JSON.stringify(result), /捕获重放证据失败/);
  assert.doesNotMatch(JSON.stringify(result), /raw error/);
});

it('refuses arbitrary text, binary and forged command uploads before OSS receives any bytes', async () => {
  const f = await fixture();
  for (const name of [
    'headers.txt',
    'response.json',
    'trace.zip',
    'command-999.json',
    'response.svg',
  ]) {
    await writeFile(join(f.workspace.evidenceDirectory, name), 'Cookie: session=DO_NOT_UPLOAD');
    await assert.rejects(() => f.store.upload(name), /不能上传/);
  }
  await writeFile(
    join(f.workspace.evidenceDirectory, 'headers.png'),
    'Cookie: session=DO_NOT_UPLOAD',
  );
  await assert.rejects(() => f.store.upload('headers.png'), /截图格式/);
  assert.equal(f.transport.objects.size, 0);
});

it('records the scene active at operation time; later events cannot relabel auxiliary work', async () => {
  const f = await fixture();
  f.setScenario(null);
  await f.call('browser_navigate', { url: 'http://localhost' }, 'page');
  f.setScenario('AUTH-LOGIN-001');
  await f.call('browser_click', { ref: 'e1' }, 'clicked');
  const records = await f.records();
  assert.equal(records[0].observation.execution.scenarioId, null);
  assert.equal(records[1].observation.execution.scenarioId, 'AUTH-LOGIN-001');
  assert.equal(records[1].observation.startedAt, '2026-09-19T00:00:00.000Z');
});

it('progress context snapshots preserve completed and auxiliary facts across later transitions', async () => {
  const controller = createScenarioProgressController({
    state: {} as RunState,
    allowedScenarios: [{ id: 'A', name: 'A' }],
    now: () => new Date(),
  });
  const invoke = async (name: string, params: Record<string, unknown>) =>
    controller.tools
      .find((tool) => tool.name === name)!
      .execute('progress', params, undefined, undefined, {} as never);
  const auxiliary = controller.operationContext();
  await invoke('begin_scenario_execution', { scenarioIds: ['A'] });
  await invoke('start_scenario', { scenarioId: 'A' });
  const active = controller.operationContext();
  await invoke('finish_scenario', { scenarioId: 'A' });
  assert.equal(auxiliary.scope, 'auxiliary');
  assert.equal(active.scenarioId, 'A');
  assert.deepEqual(active.completed, []);
  assert.deepEqual(controller.operationContext().completed, ['A']);
});
