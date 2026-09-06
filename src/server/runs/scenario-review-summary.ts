import { parseExecutionScenarioPlan } from './execution-plan.js';
import { redactSensitiveText } from './test-data.js';

/** Copy only the candidate/gap summary, never the entire planning artifact. */
export function scenarioReviewSummary(plan: string, secrets: readonly string[]): string {
  // Redact before clipping, so clipping cannot turn a credential into an unmatched prefix.
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    plan = plan.split(secret).join('[REDACTED]');
  }
  plan = redactSensitiveText(plan)
    .replace(/(?:https?|file):\/\/[^\s)<>]+/gi, '[link omitted]')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:[^\s/]+\/)+)[^\s)<>]*/g, '[path omitted]');
  const lines = plan.split(/\r?\n/);
  let fence: string | null = null;
  let selected = false;
  const summary: string[] = [];
  for (const line of lines) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##\s/.test(line)) {
      selected =
        /^##\s+(?:scenario_review_summary|候选范围|覆盖缺口|Candidate scope|Coverage gaps)\s*$/i.test(
          line,
        );
      if (selected) summary.push(line);
      continue;
    }
    if (/^(?:diff --git |@@)/.test(line)) selected = false;
    if (selected && !/^(?:[+-]{3} |---\s*$)/.test(line)) summary.push(line);
  }
  // Keep the authoritative execution scope separate from the AI-authored summary.
  const ids = parseExecutionScenarioPlan(plan).scenarioIds;
  const scope = ids.length ? ids.join(', ') : '0';
  const text =
    summary.join('\n').trim() ||
    '候选计划未提供可保留的候选范围/覆盖缺口摘要；不能据此认定覆盖完整。';
  const bounded =
    text.length > 8000 ? `${text.slice(0, 8000)}\n[摘要已截断，覆盖说明可能不完整]` : text;
  return `## 候选范围与覆盖缺口摘要\n\n计划执行清单：${scope}\n\n${bounded}`;
}
