export const EXECUTION_SCENARIOS_HEADING = '## execution_scenarios';

const SCENARIO_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const NO_SCENARIO_EVIDENCE =
  /(?:无需\s*场景(?:测试)?|零场景|no\s+scenario(?:s)?(?:\s+testing)?|does\s+not\s+require\s+(?:a\s+)?scenario)/i;

export interface ExecutionScenarioPlan {
  scenarioIds: string[];
  noScenarioTesting: boolean;
  reason: string | null;
}

export interface ExecutionScenarioCandidate {
  id: string;
  status: 'draft' | 'approved' | 'deprecated';
  name: string;
}

export class ExecutionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionPlanError';
  }
}

/**
 * Parse the one explicit execution section used by new Run plans.
 * References elsewhere in the document are deliberately ignored.
 */
export function parseExecutionScenarioPlan(content: string): ExecutionScenarioPlan {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headingLines = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line === EXECUTION_SCENARIOS_HEADING);
  if (headingLines.length === 0) {
    throw new ExecutionPlanError(`plan.md 必须包含唯一标题 ${EXECUTION_SCENARIOS_HEADING}`);
  }
  if (headingLines.length > 1) {
    throw new ExecutionPlanError(`${EXECUTION_SCENARIOS_HEADING} 不能重复`);
  }

  const start = (headingLines[0]?.index ?? 0) + 1;
  const end = lines.findIndex((line, index) => index >= start && /^##(?:\s|$)/.test(line.trim()));
  const section = lines.slice(start, end < 0 ? lines.length : end);
  const scenarioIds: string[] = [];
  const prose: string[] = [];
  for (const line of section) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const bullet = trimmed.match(/^[-*+]\s+(.+?)\s*$/);
    if (bullet) {
      const id = bullet[1]?.trim() ?? '';
      if (!SCENARIO_ID_PATTERN.test(id) || id.length > 128) {
        throw new ExecutionPlanError(`execution_scenarios 中包含无效场景 ID：${id || '(空)'}`);
      }
      scenarioIds.push(id);
      continue;
    }
    prose.push(trimmed);
  }

  if (new Set(scenarioIds).size !== scenarioIds.length) {
    throw new ExecutionPlanError('execution_scenarios 不能包含重复场景 ID');
  }
  const reason = prose.join('\n').trim() || null;
  const noScenarioTesting =
    scenarioIds.length === 0 && reason !== null && NO_SCENARIO_EVIDENCE.test(reason);
  if (scenarioIds.length === 0 && !noScenarioTesting) {
    throw new ExecutionPlanError('空 execution_scenarios 必须明确写出“无需场景测试”及其依据');
  }
  if (scenarioIds.length > 0 && NO_SCENARIO_EVIDENCE.test(reason ?? '')) {
    throw new ExecutionPlanError('execution_scenarios 不能同时列出场景并声明无需场景测试');
  }
  return { scenarioIds, noScenarioTesting, reason };
}

/** Validate the explicit IDs against the fixed, current working scenario tree. */
export function validateExecutionScenarioPlan(
  plan: ExecutionScenarioPlan,
  candidates: readonly ExecutionScenarioCandidate[],
): void {
  const byId = new Map<string, ExecutionScenarioCandidate>();
  for (const candidate of candidates) {
    if (byId.has(candidate.id)) {
      throw new ExecutionPlanError(`当前工作场景包含重复稳定 ID：${candidate.id}`);
    }
    byId.set(candidate.id, candidate);
  }
  for (const id of plan.scenarioIds) {
    const candidate = byId.get(id);
    if (!candidate) throw new ExecutionPlanError(`execution_scenarios 引用了未知场景 ID：${id}`);
    if (candidate.status !== 'approved') {
      throw new ExecutionPlanError(
        `execution_scenarios 只能执行 approved 场景：${id} 当前为 ${candidate.status}`,
      );
    }
  }
}

export function assertScenarioResultsMatchPlan(
  plan: ExecutionScenarioPlan,
  results: readonly { id: string }[],
): void {
  if (
    results.length !== plan.scenarioIds.length ||
    results.some((result, index) => result.id !== plan.scenarioIds[index])
  ) {
    throw new ExecutionPlanError(
      '最终报告 scenario_results 必须按 execution_scenarios 的完整顺序逐项对应',
    );
  }
}
