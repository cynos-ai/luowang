import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';

import { LIVE_INPUT_NAMES, readLivePreparation, runPreflight } from './acceptance/closure.js';
import {
  parseLiveQueueResponse,
  parseLiveRunResponse,
  parseLiveRunsResponse,
} from './acceptance/live-contract.js';

const projectId = '4b1cb89c-539c-4b1d-a197-688389e808c8';
const projectPath = `/api/projects/${projectId}`;

function environment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(LIVE_INPUT_NAMES.map((name) => [name, 'synthetic-input']));
  for (const key of LIVE_INPUT_NAMES) {
    if (/CONFIRMED$|APPROVED$|AUTHORIZED$/.test(key)) env[key] = 'true';
    if (/THINKING$/.test(key)) env[key] = 'off';
  }
  return {
    ...env,
    LUOWANG_LIVE_PROJECT_ID: projectId,
    LUOWANG_LIVE_REPOSITORY: 'https://github.com/example/fixture',
  };
}

function server(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method: string }> = [];
  const responses: Record<string, unknown> = {
    [projectPath]: {
      project: { projectId, repositoryOwner: 'example', repositoryName: 'fixture' },
    },
    [`${projectPath}/readiness`]: {
      projectId,
      checkedAt: '2026-09-29T00:00:00.000Z',
      ready: true,
      checks: ['repository', 'deployment', 'environment', 'image', 'credentials'].map((id) => ({
        id,
        status: 'ok',
      })),
    },
    [`${projectPath}/queue`]: { queue: [] },
    [`${projectPath}/runs`]: { runs: [] },
    ...overrides,
  };
  responses[`${projectPath}/readiness/status`] = {
    readiness: responses[`${projectPath}/readiness`],
  };
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? 'GET' });
    if (path === '/api/auth/login') {
      assert.equal(init?.method, 'POST');
      return new Response('{}', {
        headers: { 'set-cookie': 'session=synthetic-session; HttpOnly' },
      });
    }
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('cookie'), 'session=synthetic-session');
    assert.ok(Object.hasOwn(responses, path), `Unexpected request ${path}`);
    return Response.json(responses[path]);
  };
  return { request, calls };
}

describe('v0.7.1 acceptance preparation and API contracts', () => {
  it('accepts empty history but makes no live/release or AC claim and starts no test work', async () => {
    const mock = server();
    const report = await runPreflight(environment(), mock.request);
    assert.equal(report.status, 'passed');
    assert.equal(report.schema, 'luowang.acceptance-preflight.v1');
    assert.equal(report.readinessCheckedAt, '2026-09-29T00:00:00.000Z');
    assert.equal('live' in report || 'release' in report || 'acEvidence' in report, false);
    assert.deepEqual(mock.calls, [
      { path: '/api/auth/login', method: 'POST' },
      ...[
        projectPath,
        `${projectPath}/readiness/status`,
        `${projectPath}/queue`,
        `${projectPath}/runs`,
      ].map((path) => ({ path, method: 'GET' })),
    ]);
    assert.doesNotMatch(JSON.stringify(report), /synthetic-input|synthetic-session/);
  });

  it('blocks missing inputs before authentication and lists only names', async () => {
    const mock = server();
    const report = await runPreflight(
      { LUOWANG_ADMIN_PASSWORD: 'canary-private-value' },
      mock.request,
    );
    assert.equal(report.status, 'blocked');
    assert.ok(report.missing.includes('LUOWANG_LIVE_PROJECT_ID'));
    assert.equal(mock.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(report), /canary-private-value/);
  });

  it('uses the same preparation checks as live for wrong identity, readiness and malformed history', async () => {
    for (const overrides of [
      {
        [projectPath]: {
          project: { projectId, repositoryOwner: 'other', repositoryName: 'fixture' },
        },
      },
      { [`${projectPath}/readiness`]: { projectId, ready: false, checks: [] } },
      { [`${projectPath}/readiness`]: null },
      { [`${projectPath}/queue`]: { queue: {} } },
      {
        [`${projectPath}/runs`]: {
          runs: [{ runId: 'bad', status: 'completed', archive: { progressed: 'false' } }],
        },
      },
    ]) {
      const mock = server(overrides);
      assert.equal((await runPreflight(environment(), mock.request)).status, 'failed');
      await assert.rejects(() => readLivePreparation(environment(), mock.request));
      assert.equal(
        mock.calls.some((call) => call.method !== 'GET' && call.path !== '/api/auth/login'),
        false,
      );
    }
  });

  it('rejects malformed JSON and invalid project IDs without exposing values', async () => {
    const mock = server();
    const invalid = await runPreflight(
      { ...environment(), LUOWANG_LIVE_PROJECT_ID: '../foreign' },
      mock.request,
    );
    assert.equal(invalid.status, 'failed');
    assert.equal(mock.calls.length, 0);
    const malformed: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/auth/login')) return mock.request(input, init);
      return new Response('canary-private-json is not JSON');
    };
    const report = await runPreflight(environment(), malformed);
    assert.equal(report.status, 'failed');
    assert.equal(report.message, '候选实例返回了无效 JSON');
    assert.doesNotMatch(JSON.stringify(report), /canary/);
  });

  it('writes blocked CLI evidence, exits nonzero, and refuses a second use of that directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'preflight-cli-'));
    try {
      const directory = join(parent, 'attempt');
      const invoke = () =>
        promisify(execFile)(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'tests/acceptance/closure.ts', 'preflight'],
          { env: { PATH: process.env.PATH, LUOWANG_ACCEPTANCE_ARTIFACT_DIR: directory } },
        );
      await assert.rejects(invoke, (error: Error & { code?: number }) => error.code === 1);
      const original = await readFile(join(directory, 'report.json'), 'utf8');
      assert.equal(JSON.parse(original).status, 'blocked');
      assert.equal(JSON.parse(original).missing.length, LIVE_INPUT_NAMES.length);
      await assert.rejects(invoke, (error: Error & { stderr?: string }) =>
        /历史结果不能覆盖/.test(error.stderr ?? ''),
      );
      assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), original);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not expose arbitrary upstream error credential values', async () => {
    const env = { ...environment(), LUOWANG_ADMIN_PASSWORD: 'opaque-canary-value' };
    const report = await runPreflight(env, async () => {
      throw new Error('failed opaque-canary-value');
    });
    assert.equal(report.status, 'failed');
    assert.doesNotMatch(JSON.stringify(report), /opaque-canary-value/);
  });

  it('accepts nullable lifecycle fields, nested archives and unknown extension fields', () => {
    const run = {
      runId: 'synthetic',
      status: 'interrupted',
      archive: null,
      scenarioProgress: null,
      extra: true,
    };
    assert.equal(parseLiveRunResponse({ run }).runId, 'synthetic');
    assert.equal(parseLiveRunsResponse({ runs: [run] }).length, 1);
    assert.deepEqual(parseLiveQueueResponse({ queue: [] }), []);
    assert.equal(
      parseLiveRunResponse({
        run: {
          ...run,
          archive: {
            reportStatus: 'not_applicable',
            archiveStatus: 'completed',
            progressed: false,
            scenarioStatus: 'pull_request',
          },
          issues: [{ status: 'pending', issueUrl: null, issueNumber: null }],
        },
      }).archive?.progressed,
      false,
    );
  });

  it('rejects flattened archives and wrong field types without echoing payloads', () => {
    for (const fields of [
      { reportStatus: 'published' },
      {
        archive: {
          reportStatus: 'published',
          archiveStatus: 'completed',
          progressed: 'false',
          scenarioStatus: 'none',
        },
      },
      { scenarioProgress: { completed: '1', total: 1 } },
      { blockingReasons: 'canary-payload' },
      { artifacts: { 'canary-secret-key': 123 } },
      { issues: [{ issueNumber: '12' }] },
      { evidence: [{ sizeBytes: '100' }] },
    ]) {
      const run = { runId: 'synthetic', status: 'completed', ...fields };
      for (const parse of [
        () => parseLiveRunResponse({ run }),
        () => parseLiveRunsResponse({ runs: [run] }),
      ]) {
        assert.throws(parse, (error: Error) => {
          assert.doesNotMatch(error.message, /canary/);
          return /格式错误|archive/.test(error.message);
        });
      }
    }
    assert.throws(
      () =>
        parseLiveQueueResponse({
          queue: [
            {
              queueId: 1,
              requestKind: 'manual-current-head',
              status: 'completed',
              initialization: 'true',
            },
          ],
        }),
      /格式错误/,
    );
  });
});
