import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { createPiAgentSessionFactory } from '../../src/server/runs/agent-session.js';
import type { PiModel, ProviderAdapter } from '../../src/server/runs/provider.js';
import type {
  AgentRole,
  AgentSession,
  AgentSessionFactory,
  AgentSessionInput,
} from '../../src/server/runs/types.js';

export type LocalModelBehavior =
  'normal' | 'revise-final-patch' | 'invalid-tool' | 'special-cleanup';

export interface LocalPiSessionRecord {
  id: string;
  role: AgentRole;
  model: string;
  thinking: string;
  tools: string[];
  systemPrompt: string;
  sessionKind: string | null;
  roleInstructionVersions: Array<{
    id: string;
    formatVersion: string;
    applicationVersion: string;
    sha256: string;
  }>;
  prompts: string[];
  disposed: boolean;
}

export interface LocalModelProtocol {
  sessions: LocalPiSessionRecord[];
  requestCount: number;
  sessionFactory: AgentSessionFactory;
  close(): Promise<void>;
}

interface ChatRequest {
  messages?: Array<{
    role?: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>;
  tools?: Array<{ function?: { name?: string } }>;
}

interface NextTool {
  name: string;
  arguments: Record<string, unknown>;
}

export async function startLocalModelProtocol(
  behavior: LocalModelBehavior = 'normal',
): Promise<LocalModelProtocol> {
  const directory = await mkdtemp(join(tmpdir(), 'luowang-local-model-'));
  const server = createServer((request, response) => {
    void handleRequest(request, response, behavior, protocolState);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地模型协议服务启动失败');
  const modelsPath = join(directory, 'models.json');
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        'luowang-local': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: 'local-protocol-placeholder',
          models: [
            {
              id: 'deterministic-tool-model',
              name: 'Deterministic local tool model',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: {
                supportsDeveloperRole: false,
                supportsUsageInStreaming: false,
                maxTokensField: 'max_tokens',
              },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(directory, 'auth.json'),
    modelsStorePath: join(directory, 'models-store.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel('luowang-local', 'deterministic-tool-model');
  if (!model) throw new Error('本地模型未注册');
  const provider = new LocalProvider(runtime, model);
  const productionFactory = createPiAgentSessionFactory({ provider });
  const sessions: LocalPiSessionRecord[] = [];
  const recordingFactory = new RecordingProductionFactory(productionFactory, sessions);
  const protocolState = { requestCount: 0 };

  return {
    sessions,
    get requestCount() {
      return protocolState.requestCount;
    },
    sessionFactory: recordingFactory,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class LocalProvider implements ProviderAdapter {
  constructor(
    private readonly runtime: ModelRuntime,
    private readonly model: PiModel,
  ) {}

  async getRuntime(): Promise<ModelRuntime> {
    return this.runtime;
  }

  async resolveModel(): Promise<PiModel> {
    return this.model;
  }

  async listModels() {
    return [
      {
        provider: this.model.provider,
        id: this.model.id,
        name: this.model.name,
        reasoning: this.model.reasoning,
        input: [...this.model.input],
        thinkingLevels: ['off' as const],
        available: true,
      },
    ];
  }

  async checkConnectivity() {
    return {
      status: 'ok' as const,
      message: '本地模型协议可用',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
  }
}

class RecordingProductionFactory implements AgentSessionFactory {
  constructor(
    private readonly delegate: AgentSessionFactory,
    private readonly records: LocalPiSessionRecord[],
  ) {}

  async create(input: AgentSessionInput): Promise<AgentSession> {
    const session = await this.delegate.create(input);
    const instructionInput = input as AgentSessionInput & {
      sessionKind?: string;
      roleInstructionVersions?: LocalPiSessionRecord['roleInstructionVersions'];
    };
    const record: LocalPiSessionRecord = {
      id: session.sessionId ?? `pi-session-${this.records.length + 1}`,
      role: input.role,
      model: input.config.model,
      thinking: input.config.thinking,
      tools: input.customTools.map((tool) => tool.name),
      systemPrompt: input.systemPrompt,
      sessionKind: instructionInput.sessionKind ?? null,
      roleInstructionVersions:
        instructionInput.roleInstructionVersions?.map((item) => ({
          ...item,
        })) ?? [],
      prompts: [],
      disposed: false,
    };
    this.records.push(record);
    return {
      sessionId: record.id,
      prompt: async (message) => {
        record.prompts.push(message);
        await session.prompt(message);
      },
      dispose: async () => {
        await session.dispose();
        record.disposed = true;
      },
    };
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  behavior: LocalModelBehavior,
  state: { requestCount: number },
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  state.requestCount += 1;
  const body = JSON.parse(await readBody(request)) as ChatRequest;
  const toolNames = (body.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name));
  const systemPrompt = messageText(body.messages?.find((message) => message.role === 'system'));
  const userPrompt = messageText(
    [...(body.messages ?? [])].reverse().find((message) => message.role === 'user'),
  );
  const called = (body.messages ?? []).flatMap(
    (message) => message.tool_calls?.map((tool) => tool.function?.name ?? '') ?? [],
  );
  const next = nextTool(toolNames, called, `${systemPrompt}\n${userPrompt}`, behavior);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (next) {
    const id = `call-${state.requestCount}`;
    sendEvent(response, {
      id: `chat-${state.requestCount}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deterministic-tool-model',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name: next.name, arguments: JSON.stringify(next.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sendEvent(response, {
      id: `chat-${state.requestCount}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deterministic-tool-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    sendEvent(response, {
      id: `chat-${state.requestCount}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deterministic-tool-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: '本阶段受控工具调用已完成。' },
          finish_reason: null,
        },
      ],
    });
    sendEvent(response, {
      id: `chat-${state.requestCount}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deterministic-tool-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  }
  response.end('data: [DONE]\n\n');
}

function nextTool(
  available: string[],
  called: string[],
  prompt: string,
  behavior: LocalModelBehavior,
): NextTool | null {
  if (behavior === 'invalid-tool') {
    if (called.length === 0) {
      return { name: 'write_outside_allowlist', arguments: { path: '/tmp/forbidden' } };
    }
    return null;
  }
  const has = (name: string) => available.includes(name);
  const count = (name: string) => called.filter((calledName) => calledName === name).length;
  const nextUnreadArtifact = (names: string[]): NextTool | null => {
    const index = count('read_run_artifact');
    return index < names.length ? readArtifact(names[index] as string) : null;
  };
  const initialization = /"initialization"\s*:\s*true/i.test(prompt);
  const candidateMain =
    has('write_scenario_patch') &&
    has('read_run_artifact') &&
    !has('write_plan') &&
    !has('write_report');
  const finalMain = has('write_report');

  if (has('write_plan')) {
    if (count('get_run_context') === 0) return tool('get_run_context');
    if (count('list_target_files') === 0) return tool('list_target_files');
    if (count('write_plan') === 0) {
      return tool('write_plan', {
        content: initialization
          ? '# 初始化计划\n\n候选场景 `ONBOARD-SMOKE-001`：验证陌生项目核心入口。\n'
          : '# 测试计划\n\n无需场景测试：本次仅验证固定 target 的生产 Pi 工件流转。\n',
      });
    }
    return null;
  }

  if (candidateMain) {
    const unreadArtifact = nextUnreadArtifact(['plan.md', 'execution.md', 'draft-report.md']);
    if (unreadArtifact) return unreadArtifact;
    if (count('write_scenario_patch') === 0) {
      return tool('write_scenario_patch', { content: scenarioAddPatch('ONBOARD-SMOKE-001') });
    }
    return null;
  }

  if (has('write_execution') && has('write_draft_report')) {
    const unreadArtifact = nextUnreadArtifact(['plan.md']);
    if (unreadArtifact) return unreadArtifact;
    if (
      behavior === 'special-cleanup' &&
      has('register_test_data') &&
      count('register_test_data') === 0
    ) {
      const context = parseRunContext(prompt);
      return tool('register_test_data', {
        id: `luowang-${context.runId}-special-review-data`,
        description: 'special review cleanup fixture',
      });
    }
    if (count('get_run_context') === 0) return tool('get_run_context');
    if (count('list_working_scenarios') === 0) return tool('list_working_scenarios');
    if (has('begin_scenario_execution') && count('begin_scenario_execution') === 0) {
      return tool('begin_scenario_execution', {
        scenarioIds: initialization ? ['ONBOARD-SMOKE-001'] : [],
      });
    }
    if (initialization && has('start_scenario') && count('start_scenario') === 0) {
      return tool('start_scenario', { scenarioId: 'ONBOARD-SMOKE-001' });
    }
    if (initialization && has('finish_scenario') && count('finish_scenario') === 0) {
      return tool('finish_scenario', { scenarioId: 'ONBOARD-SMOKE-001' });
    }
    if (count('run_fixture_command') === 0) {
      return tool('run_fixture_command', { command: 'node --version' });
    }
    if (count('write_execution') === 0) {
      return tool('write_execution', {
        content: initialization
          ? '# 执行记录\n\n候选场景 ONBOARD-SMOKE-001 已通过受控命令验证。\n'
          : '# 执行记录\n\n固定 target 的受控命令执行成功；无需产品场景。\n',
      });
    }
    if (count('write_draft_report') === 0) {
      return tool('write_draft_report', {
        content: initialization
          ? '# 草稿报告\n\nONBOARD-SMOKE-001 passed。\n'
          : '# 草稿报告\n\n无需场景测试，工件流转通过。\n',
      });
    }
    return null;
  }

  if (has('write_review')) {
    const unreadArtifact = nextUnreadArtifact(['plan.md', 'execution.md', 'draft-report.md']);
    if (unreadArtifact) return unreadArtifact;
    if (count('write_review') === 0) {
      return tool('write_review', {
        content: initialization
          ? '# 独立审核\n\n已独立确认候选场景 ONBOARD-SMOKE-001 的执行证据。\n'
          : '# 独立审核\n\n已独立确认无需场景测试的依据和执行工件。\n',
      });
    }
    return null;
  }

  if (finalMain) {
    const unreadArtifact = nextUnreadArtifact([
      'plan.md',
      'execution.md',
      'draft-report.md',
      'review.md',
    ]);
    if (unreadArtifact) return unreadArtifact;
    if (
      initialization &&
      behavior === 'revise-final-patch' &&
      has('write_scenario_patch') &&
      count('write_scenario_patch') === 0
    ) {
      return tool('write_scenario_patch', { content: scenarioAddPatch('ONBOARD-REVISED-001') });
    }
    if (count('write_report') === 0) {
      return tool('write_report', { content: reportFromPrompt(prompt, initialization) });
    }
    return null;
  }

  return null;
}

function tool(name: string, arguments_: Record<string, unknown> = {}): NextTool {
  return { name, arguments: arguments_ };
}

function readArtifact(name: string): NextTool {
  return { name: 'read_run_artifact', arguments: { name } };
}

function reportFromPrompt(prompt: string, initialization: boolean): string {
  const context = parseRunContext(prompt);
  const included = context.includedCommits.length
    ? `\n${context.includedCommits.map((commit) => `  - ${commit}`).join('\n')}`
    : ' []';
  const scenarioResults = initialization
    ? '\n  - id: ONBOARD-SMOKE-001\n    result: passed'
    : ' []';
  return `---
run_id: ${context.runId}
trigger: ${context.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits:${included}
result: passed
started_at: 2026-09-01T00:00:00Z
finished_at: 2026-09-01T00:01:00Z
scenario_results:${scenarioResults}
confirmed_bugs: []
---

# 最终报告

${initialization ? '候选场景 ONBOARD-SMOKE-001 已执行并经 Reviewer 审核。' : '无需场景测试：Reviewer 已独立确认。'}
`;
}

function parseRunContext(prompt: string): {
  runId: string;
  trigger: string;
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
} {
  const dynamic = prompt.match(/动态 Run 上下文：\s*(\{[\s\S]*\})\s*$/);
  const fixed = prompt.match(/固定 Run 上下文：\s*([\s\S]*?)\s*\n\s*(?:必须|请|先)/);
  const serialized = dynamic?.[1] ?? fixed?.[1];
  if (!serialized) throw new Error('本地模型无法读取固定 Run 上下文');
  return JSON.parse(serialized) as ReturnType<typeof parseRunContext>;
}

function scenarioAddPatch(id: string): string {
  const path = `docs/scenario-testing/scenarios/${id}.md`;
  const lines = [
    '---',
    `id: ${id}`,
    `name: ${id} 场景`,
    'description: 陌生项目核心入口可用。',
    'status: approved',
    'tags:',
    '  - core',
    '---',
    '',
    '## 期望',
    '',
    '陌生项目核心入口可用。',
  ];
  return `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/${path}
@@ -0,0 +1,${lines.length} @@
${lines.map((line) => `+${line}`).join('\n')}
`;
}

function messageText(message: ChatRequest['messages'] extends Array<infer T> ? T : never): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) =>
        typeof item === 'object' && item && 'text' in item ? String(item.text ?? '') : '',
      )
      .join('\n');
  }
  return '';
}

function sendEvent(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
