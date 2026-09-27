import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from 'vitest';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const script = join(process.cwd(), 'tests/acceptance/code-understanding/summarize.mjs');
const summarize = (directory: string) =>
  spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });

it('recalculates paired quality and all request costs, then rejects a changed audited plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-eval-summary-'));
  try {
    const manifest = Buffer.from('{}');
    await writeFile(join(directory, 'manifest.json'), manifest);
    await writeFile(
      join(directory, 'protocol.json'),
      JSON.stringify({ cases: 1, pairedRepeats: 1 }),
    );
    const names = ['sample-0-baseline', 'sample-0-candidate'];
    const rows: Record<string, unknown>[] = [];
    const cases: Record<string, unknown>[] = [];
    const attempts: Record<string, unknown>[] = [];
    for (const [index, revision] of ['baseline', 'candidate'].entries()) {
      const name = names[index];
      const plan = `# ${revision}\n`;
      const folder = join(directory, 'formal', name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'plan.md'), plan);
      rows.push({
        name,
        id: 'sample',
        repeat: 0,
        revision,
        disposition: 'scored',
        planSha256: sha(plan),
        critical: [{ criterion: 'risk', status: revision === 'baseline' ? 'missed' : 'met' }],
        unsupportedOrWeakenedExpectations: [],
        unnecessaryMutations: [],
        provenanceErrors: [],
      });
      cases.push({ name, requests: 1, status: 'awaiting_ai_audit' });
      attempts.push({
        case: name,
        status: 'completed',
        usage: { prompt_tokens: 10 + index, completion_tokens: 2 },
        elapsedMs: 100 + index,
      });
    }
    cases.push({ name: 'sample-1-baseline', requests: 1, status: 'budget_exhausted' });
    attempts.push({ case: 'sample-1-baseline', status: 'failed', elapsedMs: 5 });
    rows.push({
      name: 'sample-1-baseline',
      id: 'sample',
      repeat: 1,
      revision: 'baseline',
      disposition: 'incomplete',
    });
    await writeFile(
      join(directory, 'formal', 'budget.json'),
      JSON.stringify({ manifest: sha(manifest), requests: 3, cases, attempts }),
    );
    const metric = (revision: string, index: number) => ({
      pairedCases: 1,
      criteria: 1,
      criticalOmissions: revision === 'baseline' ? 1 : 0,
      unsupportedOrWeakenedExpectations: 0,
      unnecessaryMutations: 0,
      provenanceErrors: 0,
      requests: revision === 'baseline' ? 2 : 1,
      promptTokens: 10 + index,
      completionTokens: 2,
      elapsedMs: 100 + index + (revision === 'baseline' ? 5 : 0),
    });
    await writeFile(
      join(directory, 'audit.json'),
      JSON.stringify({
        manifestSha256: sha(manifest),
        caseAttempts: 3,
        completePairs: 1,
        humanScoring: 'not_run',
        scope: 'synthetic',
        rows,
        metrics: { baseline: metric('baseline', 0), candidate: metric('candidate', 1) },
      }),
    );
    const success = summarize(directory);
    assert.equal(success.status, 0, success.stderr);
    const summary = JSON.parse(success.stdout);
    assert.equal(summary.completePairs, 1);
    assert.equal(summary.metrics.baseline.criticalOmissions, 1);
    assert.equal(summary.metrics.candidate.promptTokens, 11);
    assert.equal(summary.modelRequestAttempts, 3);
    assert.equal(summary.failedRequests, 1);
    assert.deepEqual(summary.failedAttempts, [
      { name: 'sample-1-baseline', status: 'budget_exhausted' },
    ]);
    const planPath = join(directory, 'formal', names[1], 'plan.md');
    await writeFile(planPath, `${await readFile(planPath, 'utf8')}changed\n`);
    const failure = summarize(directory);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /计划哈希不一致/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
