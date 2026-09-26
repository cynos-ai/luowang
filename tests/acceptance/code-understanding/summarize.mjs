import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Recalculate a frozen round without changing its plans, audit, or failed attempts. */
export function summarizeEvaluation(directory) {
  const root = resolve(directory);
  const manifestBytes = readFileSync(join(root, 'manifest.json'));
  const protocol = readJson(join(root, 'protocol.json'));
  const budget = readJson(join(root, 'formal', 'budget.json'));
  const audit = readJson(join(root, 'audit.json'));
  if (audit.manifestSha256 !== hash(manifestBytes) || budget.manifest !== hash(manifestBytes))
    throw new Error('评测 manifest 与审计或预算记录不一致');
  if (!Array.isArray(budget.cases) || !Array.isArray(budget.attempts) || !Array.isArray(audit.rows))
    throw new Error('评测案例、调用或审计记录缺失');
  if (budget.requests !== budget.attempts.length || audit.caseAttempts !== budget.cases.length)
    throw new Error('调用或案例总数与原始记录不一致');
  const cases = new Map();
  for (const entry of budget.cases) {
    if (cases.has(entry.name)) throw new Error(`重复案例：${entry.name}`);
    cases.set(entry.name, entry);
  }
  const rows = new Map();
  for (const row of audit.rows) {
    if (rows.has(row.name) || !cases.has(row.name)) throw new Error(`审计案例无效：${row.name}`);
    rows.set(row.name, row);
    if (row.disposition === 'scored') {
      const plan = readFileSync(join(root, 'formal', row.name, 'plan.md'));
      if (row.planSha256 !== hash(plan)) throw new Error(`计划哈希不一致：${row.name}`);
    }
  }
  if (rows.size !== cases.size) throw new Error('审计记录未覆盖全部案例尝试');
  const attempts = new Map();
  for (const attempt of budget.attempts) {
    if (!cases.has(attempt.case)) throw new Error(`模型调用没有案例归属：${attempt.case}`);
    attempts.set(attempt.case, (attempts.get(attempt.case) ?? 0) + 1);
  }
  for (const [name, entry] of cases) {
    if (attempts.get(name) !== entry.requests) throw new Error(`案例调用数不一致：${name}`);
  }
  const pairs = new Map();
  for (const row of rows.values()) {
    if (row.disposition !== 'scored') continue;
    const key = `${row.id}:${row.repeat}`;
    const pair = pairs.get(key) ?? new Set();
    pair.add(row.revision);
    pairs.set(key, pair);
  }
  const completePairKeys = new Set(
    [...pairs]
      .filter(([, pair]) => pair.has('baseline') && pair.has('candidate'))
      .map(([key]) => key),
  );
  const completePairs = completePairKeys.size;
  if (completePairs !== audit.completePairs) throw new Error('有效配对数与审计记录不一致');
  const metrics = {};
  for (const revision of ['baseline', 'candidate']) {
    const scored = [...rows.values()].filter(
      (row) =>
        row.revision === revision &&
        row.disposition === 'scored' &&
        completePairKeys.has(`${row.id}:${row.repeat}`),
    );
    const calls = budget.attempts.filter((attempt) => attempt.case.endsWith(`-${revision}`));
    metrics[revision] = {
      pairedCases: scored.length,
      criteria: scored.reduce((sum, row) => sum + row.critical.length, 0),
      criticalOmissions: scored.reduce(
        (sum, row) => sum + row.critical.filter((item) => item.status !== 'met').length,
        0,
      ),
      unsupportedOrWeakenedExpectations: scored.filter(
        (row) => row.unsupportedOrWeakenedExpectations.length > 0,
      ).length,
      unnecessaryMutations: scored.filter((row) => row.unnecessaryMutations.length > 0).length,
      provenanceErrors: scored.filter((row) => row.provenanceErrors.length > 0).length,
      requests: calls.length,
      promptTokens: calls.reduce((sum, call) => sum + (call.usage?.prompt_tokens ?? 0), 0),
      completionTokens: calls.reduce((sum, call) => sum + (call.usage?.completion_tokens ?? 0), 0),
      elapsedMs: calls.reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0),
    };
    if (JSON.stringify(metrics[revision]) !== JSON.stringify(audit.metrics[revision]))
      throw new Error(`${revision} 指标与原始记录不一致`);
  }
  return {
    protocol: { cases: protocol.cases, pairedRepeats: protocol.pairedRepeats },
    caseAttempts: budget.cases.length,
    modelRequestAttempts: budget.attempts.length,
    failedRequests: budget.attempts.filter((attempt) => attempt.status !== 'completed').length,
    failedAttempts: budget.cases
      .filter((entry) => entry.status !== 'awaiting_ai_audit')
      .map((entry) => ({ name: entry.name, status: entry.status })),
    completePairs,
    humanScoring: audit.humanScoring,
    scope: audit.scope,
    metrics,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('用法: node summarize.mjs <frozen-round-directory>');
  console.log(JSON.stringify(summarizeEvaluation(process.argv[2]), null, 2));
}
