import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { createTextResult } from './agent-session.js';
import type { RunState } from './types.js';

const MAX_DECLARED_SCENARIOS = 500;
const MAX_ACTIVITIES = 20;

export interface ProgressScenario {
  id: string;
  name: string;
}

export interface ScenarioProgressController {
  tools: ToolDefinition[];
  completionError(): string | null;
}

export function createScenarioProgressController(options: {
  state: RunState;
  allowedScenarios: readonly ProgressScenario[];
  now: () => Date;
}): ScenarioProgressController {
  return new DefaultScenarioProgressController(options).controller();
}

class DefaultScenarioProgressController {
  private readonly allowed: Map<string, ProgressScenario>;
  private declared: string[] | undefined;
  private active: string | null = null;
  private readonly completed = new Set<string>();

  constructor(
    private readonly options: {
      state: RunState;
      allowedScenarios: readonly ProgressScenario[];
      now: () => Date;
    },
  ) {
    this.allowed = new Map(options.allowedScenarios.map((scenario) => [scenario.id, scenario]));
  }

  controller(): ScenarioProgressController {
    const declarationParameters = Type.Object(
      {
        scenarioIds: Type.Array(Type.String(), {
          maxItems: MAX_DECLARED_SCENARIOS,
          description: '按实际执行顺序声明的稳定场景 ID',
        }),
      },
      { additionalProperties: false },
    );
    const scenarioParameters = Type.Object(
      { scenarioId: Type.String({ description: '已声明的稳定场景 ID' }) },
      { additionalProperties: false },
    );
    return {
      tools: [
        {
          name: 'begin_scenario_execution',
          label: '声明场景执行顺序',
          description:
            '在执行前声明本次实际场景顺序；ID 必须来自 Main 计划或当前工作场景。零场景必须显式提交空数组。',
          parameters: declarationParameters,
          execute: async (
            _toolCallId: string,
            params: Static<typeof declarationParameters>,
          ): Promise<AgentToolResult<Record<string, unknown>>> =>
            this.execute(() => this.begin(params.scenarioIds)),
        },
        {
          name: 'start_scenario',
          label: '开始场景',
          description: '开始一个已声明且尚未执行的场景，并更新控制台当前场景。',
          parameters: scenarioParameters,
          execute: async (
            _toolCallId: string,
            params: Static<typeof scenarioParameters>,
          ): Promise<AgentToolResult<Record<string, unknown>>> =>
            this.execute(() => this.start(params.scenarioId)),
        },
        {
          name: 'finish_scenario',
          label: '完成场景',
          description: '完成当前场景并增加已完成数量；不能重复完成或越过当前场景。',
          parameters: scenarioParameters,
          execute: async (
            _toolCallId: string,
            params: Static<typeof scenarioParameters>,
          ): Promise<AgentToolResult<Record<string, unknown>>> =>
            this.execute(() => this.finish(params.scenarioId)),
        },
      ],
      completionError: () => this.completionError(),
    };
  }

  private begin(values: readonly string[]): Record<string, unknown> {
    if (this.declared) throw new Error('场景执行顺序已经声明，不能重复声明');
    const scenarioIds = values.map((value) => value.trim());
    if (
      scenarioIds.some((value) => value === '') ||
      new Set(scenarioIds).size !== scenarioIds.length
    ) {
      throw new Error('场景执行顺序包含空值或重复 ID');
    }
    if (scenarioIds.some((id) => !this.allowed.has(id))) {
      throw new Error('场景 ID 不在 Main 计划或当前工作场景中');
    }
    if (scenarioIds.length === 0 && this.allowed.size > 0) {
      throw new Error('Main 计划包含可执行场景，不能声明为零场景');
    }
    this.declared = scenarioIds;
    this.options.state.currentScenario = null;
    this.options.state.scenarioProgress = { completed: 0, total: scenarioIds.length };
    this.addActivity(
      scenarioIds.length === 0
        ? 'Runner 已声明本次无需执行场景（0/0）'
        : `Runner 已声明 ${scenarioIds.length} 个场景的执行顺序`,
      'info',
    );
    return this.snapshot();
  }

  private start(value: string): Record<string, unknown> {
    const scenarioId = value.trim();
    if (!this.declared) throw new Error('必须先声明场景执行顺序');
    if (!this.declared.includes(scenarioId)) throw new Error('不能开始未声明的场景');
    if (this.completed.has(scenarioId)) throw new Error('不能重复开始已完成场景');
    if (this.active) throw new Error('必须先完成当前场景');
    const expected = this.declared[this.completed.size];
    if (scenarioId !== expected) throw new Error('场景必须按声明顺序执行');
    this.active = scenarioId;
    const scenario = this.requireScenario(scenarioId);
    this.options.state.currentScenario = displayScenario(scenario);
    this.addActivity(`开始场景 ${displayScenario(scenario)}`, 'info');
    return this.snapshot();
  }

  private finish(value: string): Record<string, unknown> {
    const scenarioId = value.trim();
    if (!this.declared) throw new Error('必须先声明场景执行顺序');
    if (this.active !== scenarioId) throw new Error('只能完成当前正在执行的场景');
    if (this.completed.has(scenarioId)) throw new Error('不能重复完成场景');
    this.completed.add(scenarioId);
    this.active = null;
    this.options.state.currentScenario = null;
    this.options.state.scenarioProgress = {
      completed: this.completed.size,
      total: this.declared.length,
    };
    this.addActivity(`完成场景 ${displayScenario(this.requireScenario(scenarioId))}`, 'info');
    return this.snapshot();
  }

  private completionError(): string | null {
    if (!this.declared) return 'Runner 未声明场景执行顺序';
    if (this.active) return `Runner 异常结束时场景 ${this.active} 仍在执行`;
    if (this.completed.size !== this.declared.length) {
      return `Runner 只完成 ${this.completed.size}/${this.declared.length} 个已声明场景`;
    }
    return null;
  }

  private snapshot(): Record<string, unknown> {
    return {
      currentScenario: this.options.state.currentScenario,
      completed: this.options.state.scenarioProgress?.completed ?? 0,
      total: this.options.state.scenarioProgress?.total ?? 0,
    };
  }

  private requireScenario(id: string): ProgressScenario {
    const scenario = this.allowed.get(id);
    if (!scenario) throw new Error('场景不在允许范围');
    return scenario;
  }

  private addActivity(message: string, kind: 'info' | 'warning'): void {
    const at = this.options.now().toISOString();
    this.options.state.updatedAt = at;
    this.options.state.activities = [
      ...(this.options.state.activities ?? []),
      { at, message: message.slice(0, 500), kind },
    ].slice(-MAX_ACTIVITIES);
  }

  private async execute(
    operation: () => Record<string, unknown>,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    try {
      const result = operation();
      return createTextResult(JSON.stringify(result), result);
    } catch (error) {
      return createTextResult(error instanceof Error ? error.message : '场景进度更新失败', {
        error: true,
      });
    }
  }
}

function displayScenario(scenario: ProgressScenario): string {
  return `${scenario.id} · ${safeScenarioName(scenario.name)}`;
}

function safeScenarioName(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/((?:password|token|secret|cookie|authorization)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:github_pat_|gh[opsur]_|sk-)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
