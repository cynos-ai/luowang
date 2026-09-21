import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { caseIds, fixture, rubric } from './acceptance/record-accuracy/fixtures.mjs';
import {
  createBudget,
  freeze,
  verify,
  requireScoredCase,
  sha,
  stopForDeliveryFailure,
} from './acceptance/record-accuracy/control.mjs';
import { runCase } from './acceptance/record-accuracy/driver.mjs';
import { modelProxy } from './acceptance/record-accuracy/proxy.mjs';

const directories: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'record-accuracy-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

test.each(caseIds)(
  '%s exercises production evidence reads and isolated final delivery without a model',
  async (id) => {
    const out = join(await temp(), id);
    const { result, sessions } = await runCase(fixture(id), out);
    expect(result.status).toBe('preflight_passed');
    expect(result.humanScoring).toBe('not_run');
    expect(sessions.map((s) => s.role)).toEqual(['reviewer', 'main-b']);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
    expect(sessions.every((s) => s.disposed)).toBe(true);
    const final = sessions[1];
    expect(final.allowedTools).not.toContain('read_browser_evidence');
    expect(
      final.tools.filter((t) => t.name === 'read_run_artifact').map((t) => t.input.name),
    ).toEqual(['plan.md', 'review.md']);
    const review = sessions[0].tools.find((t) => t.name === 'write_review').input.content;
    expect(
      JSON.stringify(
        final.tools.find((t) => t.name === 'read_run_artifact' && t.input.name === 'review.md')
          .output,
      ),
    ).toContain(review.replaceAll('\n', '\\n'));
    expect(JSON.stringify(sessions)).not.toContain(rubric[id]);
    expect(
      sessions[0].tools.some(
        (t) =>
          ['read_browser_evidence', 'read_command_evidence'].includes(t.name) &&
          t.status === 'returned',
      ),
    ).toBe(true);
    const executionRead = sessions[0].tools.findIndex(
      (tool) =>
        tool.name === 'read_run_artifact' &&
        tool.input.name === 'execution.md' &&
        tool.status === 'returned',
    );
    const reviewWrite = sessions[0].tools.findIndex((tool) => tool.name === 'write_review');
    expect(executionRead).toBeGreaterThan(-1);
    expect(reviewWrite).toBeGreaterThan(executionRead);
    await expect(runCase(fixture(id), out)).rejects.toThrow();
  },
  30000,
);

test('paired fixtures vary only the intended facts', () => {
  for (const family of ['SOURCE', 'TIME', 'COUNT']) {
    const p = fixture(`${family}-P`),
      n = fixture(`${family}-N`);
    expect(p.scenario).toBe(n.scenario);
    expect(p.plan).toBe(n.plan);
    expect(p.snapshot).toBe(n.snapshot);
    if (family === 'TIME') {
      expect(p.execution).toBe(n.execution);
      const { timeOriginUnixMs, ...rest } = p.observation;
      expect(timeOriginUnixMs).toBe(Date.parse('2026-09-21T00:00:00Z'));
      expect(rest).toEqual(n.observation);
    } else expect(p.observation).toEqual(n.observation);
  }
});

test('freezing detects input tampering and refuses reuse', async () => {
  const out = join(await temp(), 'frozen');
  freeze(process.cwd(), out);
  expect(verify(process.cwd(), out).cap).toBe(120);
  expect(() => freeze(process.cwd(), out)).toThrow();
  await writeFile(
    join(out, 'inputs.json'),
    (await readFile(join(out, 'inputs.json'), 'utf8')) + ' ',
  );
  expect(() => verify(process.cwd(), out)).toThrow('Frozen inputs changed');
});

test('budget counts attempted calls including failures and refuses all work after stop', async () => {
  let calls = 0;
  const budget = createBudget(() => {});
  await expect(
    budget.request('reviewer', async () => {
      calls++;
      throw new Error('secret must not be recorded');
    }),
  ).rejects.toThrow('stopped');
  await expect(
    budget.request('retry', async () => {
      calls++;
    }),
  ).rejects.toThrow('stopped');
  expect(calls).toBe(1);
  expect(budget.state.requests).toBe(1);
  expect(JSON.stringify(budget.state)).not.toContain('secret');
  const full = createBudget(() => {});
  for (let i = 0; i < 120; i++) await full.request('fixture', async () => {});
  await expect(
    full.request('overflow', async () => {
      calls++;
    }),
  ).rejects.toThrow('stopped');
  expect(full.state.requests).toBe(120);
  expect(calls).toBe(1);
});

test('delivery failure keeps the earlier transport stop reason', () => {
  const stopped = createBudget(() => {});
  stopped.stop('transport-or-response-failure');
  stopForDeliveryFailure(stopped);
  expect(stopped.state.reason).toBe('transport-or-response-failure');

  const delivery = createBudget(() => {});
  stopForDeliveryFailure(delivery);
  expect(delivery.state.stopped).toBe(true);
  expect(delivery.state.reason).toBe('case-delivery-failure');
});

test('scoring requires both role assessments and unchanged writer artifacts', async () => {
  const out = join(await temp(), 'scoring-test');
  const { result } = await runCase(fixture('SOURCE-P'), out);
  // Fabricated receipt only for exercising the gate, never retained as model scoring.
  result.status = 'awaiting_scoring';
  const bytes = JSON.stringify(result);
  await writeFile(join(out, 'result.json'), bytes);
  const score = {
    result: 'passed',
    reviewer: 'synthetic-test',
    notes: 'gate test only',
    resultSha256: sha(bytes),
    reviewerAssessment: { result: 'passed', notes: 'synthetic' },
    mainAssessment: { result: 'passed', notes: 'synthetic' },
  };
  const budget = createBudget(() => {});
  expect(() => requireScoredCase(out, budget)).toThrow();
  await writeFile(join(out, 'score.json'), JSON.stringify({ ...score, mainAssessment: null }));
  expect(() => requireScoredCase(out, budget)).toThrow('needs artifact-bound scoring');
  await writeFile(join(out, 'score.json'), JSON.stringify(score));
  expect(() => requireScoredCase(out, budget)).not.toThrow();
  await writeFile(join(out, 'evaluation/running', result.runId, 'review.md'), 'changed');
  expect(() => requireScoredCase(out, budget)).toThrow('Scored artifact changed');
  await writeFile(join(out, 'score.json'), JSON.stringify({ ...score, result: 'failed' }));
  expect(() => requireScoredCase(out, budget)).toThrow('Previous case failed');
  expect(budget.state.stopped).toBe(true);
});

test('proxy completes a valid streamed response and counts it once', async () => {
  const budget = createBudget(() => {});
  const server = modelProxy(
    budget,
    'https://invalid.example',
    'synthetic',
    async () =>
      new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
    });
    expect(await response.text()).toContain('[DONE]');
    expect(budget.state.requests).toBe(1);
    expect(budget.state.stopped).toBe(false);
    expect(budget.state.attempts[0].status).toBe('completed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.each(['http-error', 'stream-error', 'missing-done', 'timeout'])(
  'proxy latches %s without forwarding retries',
  async (failure) => {
    let calls = 0;
    const budget = createBudget(() => {});
    const server = modelProxy(
      budget,
      'https://invalid.example/v1/chat/completions',
      'synthetic-key',
      async () => {
        calls++;
        if (failure === 'http-error') return new Response('', { status: 429 });
        if (failure === 'timeout') throw new DOMException('synthetic', 'TimeoutError');
        if (failure === 'missing-done') return new Response('data: {}\n\n');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('synthetic'));
            },
          }),
        );
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
        });
        expect(response.status).toBe(403);
      }
      expect(calls).toBe(1);
      expect(budget.state.stopped).toBe(true);
      expect(budget.state.requests).toBe(1);
      expect(budget.state.attempts[0].failureCategory).toBe(
        (
          {
            'http-error': 'upstream-http',
            'stream-error': 'response-stream-error',
            'missing-done': 'response-incomplete',
            timeout: 'upstream-timeout',
          } as Record<string, string>
        )[failure],
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
