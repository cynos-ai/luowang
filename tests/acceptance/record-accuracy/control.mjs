import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, caseIds, rubric } from './fixtures.mjs';

export const sha = (value) => createHash('sha256').update(value).digest('hex');
export function requireScoredCase(directory, budget) {
  const bytes = readFileSync(join(directory, 'result.json'));
  const result = JSON.parse(bytes);
  const score = JSON.parse(readFileSync(join(directory, 'score.json')));
  if (score.result === 'failed') {
    budget.stop('semantic-failure');
    throw new Error('Previous case failed');
  }
  if (
    result.status !== 'awaiting_scoring' ||
    score.result !== 'passed' ||
    !score.reviewer ||
    !score.notes ||
    score.resultSha256 !== sha(bytes) ||
    !['reviewer', 'main'].every(
      (role) =>
        score[role + 'Assessment']?.result === 'passed' && score[role + 'Assessment']?.notes,
    )
  ) {
    throw new Error('Previous case needs artifact-bound scoring');
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(result.runId)) throw new Error('Invalid result Run');
  for (const name of ['plan.md', 'execution.md', 'review.md', 'report.md']) {
    if (
      sha(readFileSync(join(directory, 'evaluation/running', result.runId, name))) !==
      result.artifacts[name]
    )
      throw new Error('Scored artifact changed');
  }
  if (sha(readFileSync(join(directory, 'sessions.json'))) !== result.sessionsSha256)
    throw new Error('Scored trace changed');
}
export function candidateFiles(root) {
  const walk = (path) =>
    readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error('Candidate symlink refused');
      const name = `${path}/${entry.name}`;
      return entry.isDirectory() ? walk(name) : [name];
    });
  return ['src', 'resources', 'tests/acceptance/record-accuracy']
    .flatMap(walk)
    .concat(['tests/acceptance/local-evidence.ts', 'package.json', 'package-lock.json'])
    .sort();
}
export function freeze(root, out) {
  mkdirSync(out); // A new directory is mandatory; no overwrite or historical reuse.
  const inputs = JSON.stringify(caseIds.map(fixture), null, 2);
  const scoring = JSON.stringify(rubric, null, 2);
  const manifest = {
    schema: 1,
    cap: 120,
    inputs: sha(inputs),
    scoring: sha(scoring),
    files: Object.fromEntries(
      candidateFiles(root).map((name) => [name, sha(readFileSync(join(root, name)))]),
    ),
  };
  writeFileSync(join(out, 'inputs.json'), inputs);
  writeFileSync(join(out, 'rubric.json'), scoring);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
export function verify(root, frozen) {
  const manifest = JSON.parse(readFileSync(join(frozen, 'manifest.json')));
  if (manifest.schema !== 1 || manifest.cap !== 120) throw new Error('Invalid manifest');
  const actual = candidateFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files)))
    throw new Error('Candidate file set changed');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (sha(readFileSync(join(root, name))) !== hash) throw new Error(`Candidate changed: ${name}`);
  }
  for (const [file, key] of [
    ['inputs.json', 'inputs'],
    ['rubric.json', 'scoring'],
  ]) {
    if (sha(readFileSync(join(frozen, file))) !== manifest[key])
      throw new Error('Frozen inputs changed');
  }
  return manifest;
}

export function createBudget(
  save,
  initial = { cap: 120, requests: 0, stopped: false, attempts: [] },
) {
  const state = initial;
  if (
    state.cap !== 120 ||
    !Number.isInteger(state.requests) ||
    state.requests < 0 ||
    state.requests > 120 ||
    state.attempts.length !== state.requests
  )
    throw new Error('Invalid budget');
  return {
    state,
    stop(reason) {
      state.stopped = true;
      state.reason = reason;
      save(state);
    },
    async request(label, action) {
      if (state.stopped || state.requests >= state.cap) {
        this.stop('stopped-or-budget-exhausted');
        throw new Error('Evaluation stopped');
      }
      const receipt = { number: ++state.requests, label, status: 'started' };
      state.attempts.push(receipt);
      save(state); // Count and persist before attempting any upstream connection.
      try {
        const result = await action(receipt);
        receipt.status = 'completed';
        save(state);
        return result;
      } catch {
        receipt.status = 'failed';
        this.stop('request-failure');
        throw new Error('Model request failed; evaluation stopped');
      }
    },
  };
}

export function stopForDeliveryFailure(budget) {
  if (!budget.state.stopped) budget.stop('case-delivery-failure');
}
