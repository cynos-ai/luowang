import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import { createBrowserObservationExtension } from '../src/server/runs/browser-observation.js';
import { readInlineBrowserSnapshot } from '../src/server/runs/browser-snapshot.js';
import {
  createRunEvidenceStore,
  createReviewerEvidenceTools,
} from '../src/server/runs/evidence.js';
import { createScenarioProgressController } from '../src/server/runs/scenario-progress.js';
import type { RunState } from '../src/server/runs/types.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { localEvidenceTransport } from './acceptance/local-evidence.js';

const directories: string[] = [];
it.each(['mcp', 'mcp__playwright'])(
  'blocks unknown %s tools before execution and rejects mismatched result identities',
  async (gateway) => {
    const f = await fixture(gateway);
    const blocked = await f.call('browser_future_tool', {}, 'must not run');
    assert.equal((blocked as { block: boolean }).block, true);
    assert.match((blocked as { reason: string }).reason, /没有受控证据采集/);
    assert.equal(f.failures(), 0);
    assert.equal(f.store.commandEvidenceIds().length, 0);
    const mismatch = await f.call('browser_click', {}, 'untrusted-result', {
      details: { mode: 'call', server: 'playwright', tool: 'browser_future_tool' },
    });
    assert.doesNotMatch(JSON.stringify(mismatch), /untrusted-result/);
    assert.equal(f.failures(), 1);
    assert.equal(f.store.commandEvidenceIds().length, 0);
    await f.call('browser_click', {}, 'not persisted as content');
    const record = (await f.records())[0].observation;
    assert.equal(record.evidencePolicy.capture, 'receipt');
    assert.equal(record.evidencePolicy.readTool, 'read_command_evidence');
    assert.match(record.output, /Output omitted/);
  },
);
it.each(['mcp', 'mcp__playwright'])(
  'links %s navigation snapshots to sanitized readable files',
  async (gateway) => {
    const f = await fixture(gateway);
    const filename = 'page-2026-09-21T00-00-00-001Z.yml';
    const secret = randomUUID();
    await writeFile(
      join(f.workspace.evidenceDirectory, filename),
      `- heading "Rejected"\n- textbox "Account": ${secret}\n`,
    );
    const result = await f.call(
      'browser_navigate',
      {},
      `### Snapshot\n- [Snapshot](${filename})\n`,
    );
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(f.store.redactText!(secret), '[REDACTED]');
    const record = (await f.records())[0].observation.browserSnapshot;
    assert.equal(record.filename, filename);
    assert.equal(record.status, 'sanitized-local');
    f.store.allowBrowserRecords!();
    const upload = await f.store.uploadAll();
    assert.equal(upload.failures.length, 0);
    assert.equal(
      upload.references.find((ref) => ref.filename === filename)!.sha256,
      record.capturedSha256,
    );
    const reader = createReviewerEvidenceTools(f.store).find(
      (tool) => tool.name === 'read_browser_evidence',
    )!;
    const read = await reader.execute('read', { filename }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(read), /Rejected/);
    assert.ok(!JSON.stringify(read).includes(secret));
  },
);

it('rejects missing, escaping, malformed and overwritten navigation snapshots', async () => {
  const f = await fixture();
  const filename = 'page-2026-09-21T00-00-00-001Z.yml';
  for (const name of [filename, '../' + filename, '/tmp/' + filename]) {
    await f.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${name})\n`);
  }
  assert.equal(f.failures(), 3);
  await writeFile(join(f.workspace.evidenceDirectory, filename), '- textbox "A": [unsupported]');
  await f.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${filename})\n`);
  assert.doesNotMatch((await f.workspace.readEvidence(filename)).toString(), /unsupported/);
  await assert.rejects(() => f.store.upload(filename));
  assert.equal(f.transport.objects.size, 0);
  const other = await fixture();
  await writeFile(join(other.workspace.evidenceDirectory, filename), '- heading "Original"');
  await other.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${filename})\n`);
  await writeFile(join(other.workspace.evidenceDirectory, filename), '- heading "Changed"');
  await assert.rejects(() => other.store.upload(filename), /内容已改变/);
  assert.equal(other.transport.objects.size, 0);
});
it.each(['mcp', 'mcp__playwright'])(
  'registers filling input before %s returns and preserves failed operation evidence',
  async (gateway) => {
    const f = await fixture(gateway);
    const value = randomUUID();
    const identify = f.store.identifySensitiveValue!.bind(f.store);
    let registered = false;
    f.store.identifySensitiveValue = (input) => {
      registered = true;
      return identify(input);
    };
    const result = await f.call(
      'browser_fill_form',
      {
        fields: [
          { name: 'Account', target: 'e1', type: 'textbox', value },
          { name: 'Confirm', target: 'e2', type: 'textbox', value },
          { name: 'Remember', target: 'e3', type: 'checkbox', value: 'true' },
        ],
      },
      `Error after first field: ${value}`,
      { isError: true },
    );
    assert.ok(registered);
    assert.ok(!JSON.stringify(result).includes(value));
    const record = (await f.records())[0].observation;
    assert.equal(record.isError, true);
    assert.equal(record.arguments.fields[0].value, '[REDACTED]');
    assert.equal(
      record.arguments.fields[0].valueReference,
      record.arguments.fields[1].valueReference,
    );
    assert.equal(record.arguments.fields[2].value, 'true');
    assert.match(record.output, /Error after first field/);
    assert.ok(!JSON.stringify(record).includes(value));
    assert.equal(f.store.redactText!(`未记录 ${value}`), '未记录 [REDACTED]');
    const other = await fixture();
    assert.equal(other.store.redactText!(value), value);
    const typed = await f.call(
      'browser_type',
      { target: 'e1', text: value, submit: true, type: 'checkbox' },
      `Typed ${value}`,
    );
    assert.ok(!JSON.stringify(typed).includes(value));
    assert.equal(
      (await f.records())[1].observation.arguments.valueReference,
      record.arguments.fields[0].valueReference,
    );
  },
);

it('blocks malformed batches and registration failures before the filling tool runs', async () => {
  const f = await fixture();
  for (const args of [
    {
      fields: [
        { target: 'e1', name: 'A', type: 'textbox', value: 'good' },
        { target: 'e2', type: 'unknown', value: 'bad' },
      ],
    },
    { fields: 'bad' },
    { fields: [{ name: 'A', ref: 'e1', type: 'textbox', value: 'old-contract' }] },
  ]) {
    const result = await f.call('browser_fill_form', args, 'must not run');
    assert.equal((result as { block: boolean }).block, true);
    assert.match((result as { reason: string }).reason, /填写参数无效/);
  }
  assert.equal(f.store.redactText!('good'), 'good');
  assert.equal(f.store.redactText!('old-contract'), 'old-contract');
  assert.equal(f.failures(), 0);
  f.store.identifySensitiveValue = () => {
    throw new Error('private failure');
  };
  const result = await f.call('browser_type', { target: 'e1', text: randomUUID() }, 'must not run');
  assert.equal((result as { block: boolean }).block, true);
  assert.match((result as { reason: string }).reason, /敏感值保护不可用/);
  assert.doesNotMatch(JSON.stringify(result), /private failure/);
  assert.equal(f.failures(), 1);
  assert.equal(f.store.commandEvidenceIds().length, 0);
});

it.each(['mcp', 'mcp__playwright'])(
  'accepts a current target retry after %s rejects a legacy ref without blocking evidence',
  async (gateway) => {
    const f = await fixture(gateway);
    const value = randomUUID();
    const rejected = await f.call(
      'browser_fill_form',
      { fields: [{ name: 'Account', ref: 'e1', type: 'textbox', value }] },
      'must not run',
    );
    assert.equal((rejected as { block: boolean }).block, true);
    assert.match((rejected as { reason: string }).reason, /填写参数无效/);
    assert.equal(f.failures(), 0);
    assert.equal(f.store.redactText!(value), value);

    await f.call(
      'browser_fill_form',
      { fields: [{ name: 'Account', target: 'e1', type: 'textbox', value }] },
      `Filled ${value}`,
    );
    assert.equal(f.failures(), 0);
    assert.equal(f.store.redactText!(value), '[REDACTED]');
    const records = await f.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].observation.arguments.fields[0].target, 'e1');
    assert.equal(records[0].observation.arguments.fields[0].value, '[REDACTED]');
  },
);
it('decodes nested and multiline snapshot field values without treating headings as credentials', () => {
  const snapshot = readInlineBrowserSnapshot(
    '### Snapshot\n```yaml\n- generic:\n  - heading "Public label"\n  - textbox "Notes": |-\n      first line\n      second line\n  - spinbutton "Code": 12345\n```',
  );
  assert.deepEqual(snapshot?.fieldValues, ['first line\nsecond line', '12345']);
  const playwrightForm = readInlineBrowserSnapshot(
    '### Snapshot\n```yaml\n- textbox "Email" [ref=e1]:\n  - /placeholder: name@example.com\n  - text: synthetic@example.test\n- textbox "Password" [ref=e2]:\n  - /placeholder: Password\n  - text: synthetic-password\n- textbox "Empty" [ref=e3]:\n  - /placeholder: Optional\n```',
  );
  assert.deepEqual(playwrightForm?.fieldValues, ['synthetic@example.test', 'synthetic-password']);
  for (const text of [
    '- textbox "A": &value secret\n- textbox "B": *value',
    '- textbox "A": [secret]',
    '- textbox "A":\n  - text: [secret]',
    '- textbox "A":\n  - unknown: secret',
    '- textbox "A": secret\n  textbox "A": other',
  ])
    assert.throws(() => readInlineBrowserSnapshot(`### Snapshot\n\`\`\`yaml\n${text}\n\`\`\``));
});

it('sanitizes nested Playwright form snapshots and discards raw values on capture failure', async () => {
  const filename = 'page-2026-09-21T00-00-00-001Z.yml';
  const form = (email: string, password: string) =>
    `- textbox "Email" [ref=e1]:\n  - /placeholder: name@example.com\n  - text: ${email}\n- textbox "Password" [ref=e2]:\n  - /placeholder: Password\n  - text: ${password}\n`;
  const f = await fixture();
  const email = `account-${randomUUID()}@example.test`;
  const password = randomUUID();
  await writeFile(join(f.workspace.evidenceDirectory, filename), form(email, password));
  await f.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${filename})\n`);
  const sanitized = (await f.workspace.readEvidence(filename)).toString();
  assert.match(sanitized, /name@example\.com|Password/);
  assert.ok(!sanitized.includes(email));
  assert.ok(!sanitized.includes(password));
  assert.equal(f.store.redactText!(email), '[REDACTED]');
  assert.equal(f.store.redactText!(password), '[REDACTED]');

  const failed = await fixture();
  const failedSecret = randomUUID();
  await writeFile(
    join(failed.workspace.evidenceDirectory, filename),
    form(`failed-${randomUUID()}@example.test`, failedSecret),
  );
  failed.store.registerSensitiveValue = () => {
    throw new Error('registration failed');
  };
  await failed.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${filename})\n`);
  const discarded = (await failed.workspace.readEvidence(filename)).toString();
  assert.match(discarded, /snapshot discarded/);
  assert.ok(!discarded.includes(failedSecret));
  await assert.rejects(() => failed.store.upload(filename), /采集失败/);

  const removed = await fixture();
  const removedSecret = randomUUID();
  await writeFile(
    join(removed.workspace.evidenceDirectory, filename),
    form(`removed-${randomUUID()}@example.test`, removedSecret),
  );
  removed.workspace.replaceBrowserEvidence = async () => {
    throw new Error('replacement failed');
  };
  await removed.call('browser_navigate', {}, `### Snapshot\n- [Snapshot](${filename})\n`);
  await assert.rejects(() => removed.workspace.readEvidence(filename), /不存在/);
});
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each(['mcp', 'mcp__playwright'])(
  'captures sanitized inline snapshots through %s and retains values for later writing',
  async (gateway) => {
    const f = await fixture(gateway);
    const result = await f.call(
      'browser_navigate',
      {},
      '### Snapshot\n```yaml\n- heading "Login rejected"\n- textbox "Account" [ref=e1]: page-only-account\n- textbox "Passphrase" [ref=e2]: "page-only-passphrase"\n```',
    );
    assert.doesNotMatch(JSON.stringify(result), /page-only-account|page-only-passphrase/);
    await f.store.uploadAll();
    const record = (await f.records())[0];
    assert.match(record.observation.output, /Login rejected/);
    assert.doesNotMatch(JSON.stringify(record), /page-only-account|page-only-passphrase/);
    assert.equal(
      f.store.redactText!('未记录 page-only-account 和 page-only-passphrase'),
      '未记录 [REDACTED] 和 [REDACTED]',
    );
    const other = await fixture();
    assert.equal(other.store.redactText!('page-only-account'), 'page-only-account');
  },
);

it('rejects file snapshots and fails closed on unknown or unavailable snapshot protection', async () => {
  const f = await fixture();
  assert.ok(
    ((await f.call('browser_snapshot', { filename: 'raw.yml' }, 'unused')) as { block: boolean })
      .block,
  );
  for (const raw of [
    '### Snapshot\n[Snapshot](raw.yml)',
    '### Snapshot\n```yaml\n- textbox "Account": {unknown: raw-private-value}\n```',
  ]) {
    const result = await f.call('browser_snapshot', {}, raw);
    assert.doesNotMatch(JSON.stringify(result), /raw-private-value|raw.yml/);
  }
  f.store.registerSensitiveValue = () => {
    throw new Error('raw-private-value');
  };
  const result = await f.call(
    'browser_snapshot',
    {},
    '### Snapshot\n```yaml\n- textbox "Account": raw-private-value\n```',
  );
  assert.doesNotMatch(JSON.stringify(result), /raw-private-value/);
  assert.equal(f.failures(), 3);
  assert.equal(f.store.commandEvidenceIds().length, 0);
});

async function fixture(gateway = 'mcp', operationContext?: () => Record<string, unknown>) {
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
    operationContext: operationContext ?? (() => ({ scenarioId })),
    onEvidenceFailure: () => {
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
    const blocked = await hooks.get('tool_call')!({ toolName: gateway, toolCallId, input });
    if (blocked) return blocked;
    return hooks.get('tool_result')!({
      toolName: gateway,
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

it.each(['mcp', 'mcp__playwright'])(
  '%s blocks raw network filenames, ignores untrusted identities and preserves tool errors',
  async (gateway) => {
    const f = await fixture(gateway);
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
  },
);

it('does not accept a forged playwright result from another namespace', async () => {
  const f = await fixture('mcp__other');
  await f.call('browser_cookie_get', {}, 'forged');
  assert.deepEqual(f.store.commandEvidenceIds(), []);
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

it('keeps cross-scenario and auxiliary evidence unchanged when a second scenario is reported late', async () => {
  const state = {} as RunState;
  let tick = 0;
  const controller = createScenarioProgressController({
    state,
    allowedScenarios: [
      { id: 'SESSION', name: 'Session recovery' },
      { id: 'DELETE', name: 'Account deletion' },
    ],
    now: () => new Date(Date.UTC(2026, 8, 20, 0, 0, tick++)),
  });
  const f = await fixture('mcp', () => controller.recordOperation('browser'));
  const invoke = async (name: string, params: Record<string, unknown>) => {
    const result = await controller.tools
      .find((tool) => tool.name === name)!
      .execute('progress', params, undefined, undefined, {} as never);
    assert.notEqual((result.details as Record<string, unknown>).error, true);
  };
  await invoke('begin_scenario_execution', { scenarioIds: ['SESSION', 'DELETE'] });
  await invoke('start_scenario', { scenarioId: 'SESSION' });
  await f.call('browser_click', { ref: 'session-check' }, 'Session verified');
  // A model performs DELETE work while SESSION is active. The Harness must not infer
  // its business meaning or retroactively relabel it when DELETE is started later.
  await f.call('browser_click', { ref: 'delete-account' }, 'Account deleted');
  await invoke('finish_scenario', { scenarioId: 'SESSION' });
  await f.call(
    'browser_snapshot',
    {},
    '### Snapshot\n```yaml\n- heading "Auxiliary inspection"\n```',
  );
  const before = await f.records();
  await invoke('start_scenario', { scenarioId: 'DELETE' });
  await invoke('finish_scenario', { scenarioId: 'DELETE' });
  assert.deepEqual(await f.records(), before);
  assert.deepEqual(
    before.map((record) => record.observation.execution),
    [
      { scenarioId: 'SESSION', scope: 'scenario', declared: true, completed: [] },
      { scenarioId: 'SESSION', scope: 'scenario', declared: true, completed: [] },
      { scenarioId: null, scope: 'auxiliary', declared: true, completed: ['SESSION'] },
    ],
  );
  assert.deepEqual(state.scenarioProgress, { completed: 2, total: 2 });
  // Completion counts alone do not certify attribution or product correctness.
  assert.equal(controller.completionError(), null);
  const messages = state.activities!.map((activity) => activity.message);
  assert.ok(
    messages.indexOf('辅助操作（无当前场景）：开始浏览器操作') <
      messages.indexOf('开始场景 DELETE · Account deletion'),
  );
});
