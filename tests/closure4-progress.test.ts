import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createScenarioProgressController } from '../src/server/runs/scenario-progress.js';
import type { RunState } from '../src/server/runs/types.js';

const SCENARIOS = [
  { id: 'AUTH-LOGIN-001', name: '登录状态恢复' },
  { id: 'AUTH-LOGOUT-001', name: '安全退出' },
] as const;

describe('Closure 4 Runner scenario progress', () => {
  it('updates current scenario, 0/N to N/N progress, activities, and timestamps', async () => {
    const state = runState();
    const clock = clockSequence();
    const controller = createScenarioProgressController({
      state,
      allowedScenarios: SCENARIOS,
      now: clock,
    });

    assert.deepEqual(
      await invokeJson(controller.tools, 'begin_scenario_execution', {
        scenarioIds: ['AUTH-LOGIN-001', 'AUTH-LOGOUT-001'],
      }),
      { currentScenario: null, completed: 0, total: 2 },
    );
    assert.deepEqual(state.scenarioProgress, { completed: 0, total: 2 });

    await invokeOk(controller.tools, 'start_scenario', { scenarioId: 'AUTH-LOGIN-001' });
    assert.equal(state.currentScenario, 'AUTH-LOGIN-001 · 登录状态恢复');
    assert.deepEqual(state.scenarioProgress, { completed: 0, total: 2 });

    await invokeOk(controller.tools, 'finish_scenario', { scenarioId: 'AUTH-LOGIN-001' });
    assert.equal(state.currentScenario, null);
    assert.deepEqual(state.scenarioProgress, { completed: 1, total: 2 });

    await invokeOk(controller.tools, 'start_scenario', { scenarioId: 'AUTH-LOGOUT-001' });
    assert.equal(state.currentScenario, 'AUTH-LOGOUT-001 · 安全退出');
    await invokeOk(controller.tools, 'finish_scenario', { scenarioId: 'AUTH-LOGOUT-001' });
    assert.deepEqual(state.scenarioProgress, { completed: 2, total: 2 });
    assert.equal(state.currentScenario, null);
    assert.equal(controller.completionError(), null);
    assert.equal(state.updatedAt, '2026-09-01T04:00:05.000Z');
    assert.deepEqual(
      state.activities?.slice(-5).map((activity) => activity.message),
      [
        'Runner 已声明 2 个场景的执行顺序',
        '开始场景 AUTH-LOGIN-001 · 登录状态恢复',
        '完成场景 AUTH-LOGIN-001 · 登录状态恢复',
        '开始场景 AUTH-LOGOUT-001 · 安全退出',
        '完成场景 AUTH-LOGOUT-001 · 安全退出',
      ],
    );
  });

  it('rejects undeclared, duplicate, out-of-order, and out-of-scope updates', async () => {
    const state = runState();
    const controller = createScenarioProgressController({
      state,
      allowedScenarios: SCENARIOS,
      now: clockSequence(),
    });

    await invokeError(
      controller.tools,
      'start_scenario',
      { scenarioId: 'AUTH-LOGIN-001' },
      /先声明/,
    );
    await invokeError(
      controller.tools,
      'begin_scenario_execution',
      { scenarioIds: ['UNKNOWN-SCENARIO-001'] },
      /不在 Main 计划/,
    );
    await invokeError(
      controller.tools,
      'begin_scenario_execution',
      { scenarioIds: ['AUTH-LOGIN-001', 'AUTH-LOGIN-001'] },
      /重复/,
    );
    await invokeOk(controller.tools, 'begin_scenario_execution', {
      scenarioIds: ['AUTH-LOGIN-001', 'AUTH-LOGOUT-001'],
    });
    await invokeError(
      controller.tools,
      'begin_scenario_execution',
      { scenarioIds: ['AUTH-LOGIN-001'] },
      /重复声明/,
    );
    await invokeError(
      controller.tools,
      'start_scenario',
      { scenarioId: 'AUTH-LOGOUT-001' },
      /声明顺序/,
    );
    await invokeOk(controller.tools, 'start_scenario', { scenarioId: 'AUTH-LOGIN-001' });
    await invokeError(
      controller.tools,
      'start_scenario',
      { scenarioId: 'AUTH-LOGOUT-001' },
      /先完成当前/,
    );
    await invokeError(
      controller.tools,
      'finish_scenario',
      { scenarioId: 'AUTH-LOGOUT-001' },
      /当前正在执行/,
    );
    await invokeOk(controller.tools, 'finish_scenario', { scenarioId: 'AUTH-LOGIN-001' });
    await invokeError(
      controller.tools,
      'finish_scenario',
      { scenarioId: 'AUTH-LOGIN-001' },
      /当前正在执行/,
    );
    assert.match(controller.completionError() ?? '', /只完成 1\/2/);
    assert.deepEqual(state.scenarioProgress, { completed: 1, total: 2 });
  });

  it('requires an explicit 0/0 declaration only when no planned scenario exists', async () => {
    const emptyState = runState();
    const empty = createScenarioProgressController({
      state: emptyState,
      allowedScenarios: [],
      now: clockSequence(),
    });
    await invokeOk(empty.tools, 'begin_scenario_execution', { scenarioIds: [] });
    assert.deepEqual(emptyState.scenarioProgress, { completed: 0, total: 0 });
    assert.equal(emptyState.currentScenario, null);
    assert.equal(empty.completionError(), null);

    const planned = createScenarioProgressController({
      state: runState(),
      allowedScenarios: SCENARIOS,
      now: clockSequence(),
    });
    await invokeError(
      planned.tools,
      'begin_scenario_execution',
      { scenarioIds: [] },
      /不能声明为零场景/,
    );
    assert.match(planned.completionError() ?? '', /未声明/);
  });

  it('preserves the last active scenario when Runner exits before finishing it', async () => {
    const state = runState();
    const controller = createScenarioProgressController({
      state,
      allowedScenarios: [SCENARIOS[0] as (typeof SCENARIOS)[number]],
      now: clockSequence(),
    });
    await invokeOk(controller.tools, 'begin_scenario_execution', {
      scenarioIds: ['AUTH-LOGIN-001'],
    });
    await invokeOk(controller.tools, 'start_scenario', { scenarioId: 'AUTH-LOGIN-001' });

    assert.equal(state.currentScenario, 'AUTH-LOGIN-001 · 登录状态恢复');
    assert.deepEqual(state.scenarioProgress, { completed: 0, total: 1 });
    assert.match(controller.completionError() ?? '', /仍在执行/);
  });

  it('caps activities and never records arbitrary tool parameters', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `FLOW-CASE-${String(index + 1).padStart(3, '0')}`,
      name: index === 0 ? '敏感 https://example.test/path?token=secret' : `场景 ${index + 1}`,
    }));
    const state = runState();
    const controller = createScenarioProgressController({
      state,
      allowedScenarios: many,
      now: clockSequence(),
    });
    await invokeOk(controller.tools, 'begin_scenario_execution', {
      scenarioIds: many.map((item) => item.id),
    });
    for (const scenario of many) {
      await invokeOk(controller.tools, 'start_scenario', {
        scenarioId: scenario.id,
        url: 'https://example.test/?token=secret',
      });
      await invokeOk(controller.tools, 'finish_scenario', {
        scenarioId: scenario.id,
        password: 'secret',
      });
    }
    assert.equal(state.activities?.length, 20);
    const activityText = JSON.stringify(state.activities);
    assert.doesNotMatch(activityText, /example\.test|token=|password|secret/);
  });
});

function runState(): RunState {
  return {
    runId: '01K00000000000000000000001',
    status: 'running',
    phase: 'runner',
    result: null,
    trigger: 'manual',
    request: 'fixture',
    baseCommit: null,
    targetCommit: 'a'.repeat(40),
    includedCommits: [],
    startedAt: '2026-09-01T04:00:00.000Z',
    finishedAt: null,
    errorMessage: null,
    artifactNames: [],
    completedDirectory: null,
    runningDirectory: '/tmp/fixture',
    evidence: [],
    currentScenario: null,
    scenarioProgress: { completed: 0, total: 0 },
    activities: [],
    blockingReasons: [],
    updatedAt: '2026-09-01T04:00:00.000Z',
  };
}

function clockSequence(): () => Date {
  let second = 0;
  return () => new Date(`2026-09-01T04:00:${String(++second).padStart(2, '0')}.000Z`);
}

async function invokeOk(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const result = await invoke(tools, name, params);
  assert.notEqual(result.details.error, true, textOf(result));
  return result;
}

async function invokeJson(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await invokeOk(tools, name, params);
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function invokeError(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
  expected: RegExp,
): Promise<void> {
  const result = await invoke(tools, name, params);
  assert.equal(result.details.error, true);
  assert.match(textOf(result), expected);
}

async function invoke(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(
    'closure4-tool',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

function textOf(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
}
