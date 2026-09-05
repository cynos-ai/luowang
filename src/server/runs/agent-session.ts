import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type InlineExtension,
  type SessionShutdownEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import type { AgentConfig } from '../../shared/types.js';
import {
  createTargetChangeEvidenceTools,
  type TargetChangeEvidenceOptions,
} from './change-evidence.js';
import type { ProviderAdapter } from './provider.js';
import type {
  AgentRole,
  AgentSession,
  AgentSessionFactory,
  AgentSessionInput,
  AgentSessionKind,
  RoleInstructionVersion,
} from './types.js';

export interface PiAgentSessionFactoryOptions {
  provider: ProviderAdapter;
}

export function createPiAgentSessionFactory(
  options: PiAgentSessionFactoryOptions,
): AgentSessionFactory {
  return new PiAgentSessionFactory(options.provider);
}

class PiAgentSessionFactory implements AgentSessionFactory {
  constructor(private readonly provider: ProviderAdapter) {}

  async create(input: AgentSessionInput): Promise<AgentSession> {
    const model = await this.provider.resolveModel(input.role);
    const runtime = await this.provider.getRuntime();
    const settings = SettingsManager.inMemory({
      defaultProvider: model.provider,
      defaultModel: model.id,
      defaultThinkingLevel: input.config.thinking,
      defaultTools: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      // All resources are explicitly disabled. This prevents a target repository's .pi
      // directory or the host user's Pi directory from changing the Run's tool boundary.
      agentDir: input.cwd,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: input.extensionFactories ?? [],
      systemPrompt: input.systemPrompt,
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      model,
      thinkingLevel: input.config.thinking,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(input.cwd),
      settingsManager: settings,
      resourceLoader,
      noTools: 'builtin',
      customTools: input.customTools,
    });
    // The SDK creates the extension registry but does not bind it automatically.
    // Binding emits session_start, which initializes session-scoped extensions
    // such as the Playwright MCP adapter before the first prompt is handled.
    await session.bindExtensions({ mode: 'print' });
    return new ManagedAgentSession(session);
  }
}

class ManagedAgentSession implements AgentSession {
  private disposed = false;
  readonly sessionId: string;

  constructor(
    private readonly session: {
      sessionId: string;
      prompt(message: string): Promise<void>;
      dispose(): void;
      extensionRunner: {
        emit(event: SessionShutdownEvent): Promise<unknown>;
      };
    },
  ) {
    this.sessionId = session.sessionId;
  }

  prompt(message: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Agent session 已释放'));
    return this.session.prompt(message);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // AgentSession.dispose() is synchronous and does not await async
      // extension shutdown handlers. MCP owns a child process whose cwd is the
      // Run evidence directory, so wait for session_shutdown before cleanup.
      await this.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      this.session.dispose();
    }
  }
}

export function createTextResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details };
}

export function createArtifactWriterTool(
  name: string,
  label: string,
  description: string,
  write: (content: string) => Promise<void>,
): ToolDefinition {
  const parameters = Type.Object({
    content: Type.String({
      description: '要写入的完整 Markdown 文本',
      maxLength: 4 * 1024 * 1024,
    }),
  });
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params: Static<typeof parameters>) => {
      try {
        await write(params.content);
        return createTextResult(`${name} 已写入`);
      } catch (error) {
        return createTextResult(errorMessage(error), { error: true });
      }
    },
  };
}

export function createReadArtifactTool(read: (name: string) => Promise<string>): ToolDefinition {
  const parameters = Type.Object({ name: Type.String({ description: '工件文件名' }) });
  return {
    name: 'read_run_artifact',
    label: '读取 Run 工件',
    description:
      '读取本次 Run 已落盘的 plan.md、execution.md、draft-report.md、review.md 或 scenario-changes.patch；不能读取其他路径。',
    parameters,
    execute: async (_toolCallId, params: Static<typeof parameters>) => {
      try {
        const content = await read(params.name);
        return createTextResult(content);
      } catch (error) {
        return createTextResult(errorMessage(error), { error: true });
      }
    },
  };
}

export function createTargetContextTools(options: {
  readFile: (path: string) => Promise<string>;
  listFiles: () => Promise<string[]>;
  search: (query: string) => Promise<string>;
  context: () => string;
  changeEvidence?: TargetChangeEvidenceOptions;
}): ToolDefinition[] {
  const readParameters = Type.Object({
    path: Type.String({ description: '仓库相对路径' }),
  });
  const searchParameters = Type.Object({
    query: Type.String({ description: '要搜索的文本' }),
  });
  const tools: ToolDefinition[] = [
    {
      name: 'get_run_context',
      label: '读取 Run 上下文',
      description: '读取固定 target SHA、base SHA、included commits 和本次人工请求。',
      parameters: Type.Object({}),
      execute: async () => createTextResult(options.context()),
    },
    {
      name: 'list_target_files',
      label: '列出目标文件',
      description: '列出固定 target commit 中的文件路径，只读。',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          return createTextResult((await options.listFiles()).join('\n'));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'read_target_file',
      label: '读取目标文件',
      description: '从固定 target commit 读取一个非敏感文件，不能读取 .env、密钥或凭据文件。',
      parameters: readParameters,
      execute: async (_toolCallId, params: Static<typeof readParameters>) => {
        try {
          return createTextResult(await options.readFile(params.path));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'search_target_files',
      label: '搜索目标文件',
      description: '在固定 target commit 的文本文件中搜索关键词，只读。',
      parameters: searchParameters,
      execute: async (_toolCallId, params: Static<typeof searchParameters>) => {
        try {
          return createTextResult(await options.search(params.query));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
  ];
  if (options.changeEvidence)
    tools.push(...createTargetChangeEvidenceTools(options.changeEvidence));
  return tools;
}

export function createWorkingScenarioTools(options: {
  list: () => Promise<string[]>;
  read: (path: string) => Promise<string>;
}): ToolDefinition[] {
  const readParameters = Type.Object({
    path: Type.String({ description: '场景 Markdown 相对路径' }),
  });
  return [
    {
      name: 'list_working_scenarios',
      label: '列出当前场景',
      description: '列出当前 Run 已应用 patch 后工作树中的场景 Markdown 文件，只读。',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          return createTextResult((await options.list()).join('\n'));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
    {
      name: 'read_working_scenario',
      label: '读取当前场景',
      description: '读取当前 Run 工作树中的场景 Markdown，只允许场景目录内文件。',
      parameters: readParameters,
      execute: async (_toolCallId, params: Static<typeof readParameters>) => {
        try {
          return createTextResult(await options.read(params.path));
        } catch (error) {
          return createTextResult(errorMessage(error), { error: true });
        }
      },
    },
  ];
}

export function createRunnerCommandTool(
  run: (
    command: string,
    signal?: AbortSignal,
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    environmentKeys: string[];
  }>,
): ToolDefinition {
  const parameters = Type.Object({
    command: Type.String({ description: '受控命令，例如 npm test 或 node fixture.js' }),
  });
  return {
    name: 'run_fixture_command',
    label: '运行本地 Fixture 命令',
    description:
      '在固定 target 工作树中运行一个受控的本地测试/CLI 命令。不能访问 Harness Secret，也不能执行 shell 管道、重定向或任意脚本。',
    parameters,
    execute: async (_toolCallId, params: Static<typeof parameters>, signal) => {
      try {
        const result = await run(params.command, signal);
        return createTextResult(
          JSON.stringify({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            environmentKeys: result.environmentKeys,
          }),
          { exitCode: result.exitCode },
        );
      } catch (error) {
        return createTextResult(errorMessage(error), { error: true });
      }
    },
  };
}

export function buildSessionInput(
  role: AgentRole,
  sessionKind: AgentSessionKind,
  config: AgentConfig,
  cwd: string,
  customTools: ToolDefinition[],
  systemPrompt: string,
  userMessage: string,
  roleInstructionVersions: RoleInstructionVersion[],
  extensionFactories: InlineExtension[] = [],
): AgentSessionInput {
  return {
    role,
    sessionKind,
    config,
    cwd,
    toolNames: [],
    customTools,
    systemPrompt,
    userMessage,
    roleInstructionVersions,
    extensionFactories,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '工具执行失败';
}
