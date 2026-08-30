import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SAFE_PROCESS_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'ProgramFiles',
  'ProgramData',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'CI',
  'NODE_ENV',
]);

const SAFE_EXECUTABLES = new Set([
  'node',
  'node.exe',
  'npm',
  'npm.cmd',
  'npx',
  'npx.cmd',
  'pnpm',
  'pnpm.cmd',
  'yarn',
  'yarn.cmd',
  'python',
  'python.exe',
  'python3',
  'python3.exe',
  'pytest',
  'pytest.exe',
  'go',
  'go.exe',
  'cargo',
  'cargo.exe',
  'dotnet',
  'dotnet.exe',
  'mvn',
  'mvn.cmd',
  'gradle',
  'gradle.bat',
  'git',
  'git.exe',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'ls-files',
  'rev-parse',
  'describe',
  'branch',
]);

const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  environmentKeys: string[];
}

export interface ControlledCommandRunner {
  run(
    command: string,
    options: { cwd: string; runId: string; targetCommit: string; signal?: AbortSignal },
  ): Promise<CommandRunResult>;
}

export class ControlledCommandError extends Error {
  readonly code: 'COMMAND_INVALID' | 'COMMAND_NOT_ALLOWED' | 'COMMAND_FAILED';

  constructor(code: ControlledCommandError['code'], message: string) {
    super(message);
    this.name = 'ControlledCommandError';
    this.code = code;
  }
}

export function createControlledCommandRunner(
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): ControlledCommandRunner {
  return new DefaultControlledCommandRunner(environment, timeoutMs);
}

class DefaultControlledCommandRunner implements ControlledCommandRunner {
  constructor(
    private readonly sourceEnvironment: NodeJS.ProcessEnv,
    private readonly timeoutMs: number,
  ) {}

  async run(
    command: string,
    options: { cwd: string; runId: string; targetCommit: string; signal?: AbortSignal },
  ): Promise<CommandRunResult> {
    const args = parseCommand(command);
    const executable = normalizeExecutable(args[0]);
    if (!SAFE_EXECUTABLES.has(executable)) {
      throw new ControlledCommandError('COMMAND_NOT_ALLOWED', `不允许运行命令：${args[0]}`);
    }
    if (executable === 'git' || executable === 'git.exe') {
      const subcommand = args[1]?.toLowerCase();
      if (!subcommand || !SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
        throw new ControlledCommandError('COMMAND_NOT_ALLOWED', 'Runner 只能执行只读 Git 命令');
      }
      assertReadOnlyGitArguments(subcommand, args.slice(2));
    }
    assertSafeInterpreterArguments(executable, args.slice(1));

    const childEnvironment = makeExplicitEnvironment(this.sourceEnvironment, {
      LUOWANG_RUN_ID: options.runId,
      LUOWANG_TARGET_COMMIT: options.targetCommit,
    });
    if (options.signal?.aborted) {
      throw new ControlledCommandError('COMMAND_FAILED', '受控命令已被取消');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await execFileAsync(resolveExecutable(args[0]), args.slice(1), {
        cwd: options.cwd,
        env: childEnvironment,
        windowsHide: true,
        shell: false,
        timeout: this.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        signal: controller.signal,
      });
      return {
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
        exitCode: 0,
        environmentKeys: Object.keys(childEnvironment).sort(),
      };
    } catch (error: unknown) {
      const details = error as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: string;
      };
      const exitCode = typeof details.code === 'number' ? details.code : null;
      if (details.signal === 'SIGTERM' || details.code === 'ETIMEDOUT') {
        throw new ControlledCommandError('COMMAND_FAILED', '受控命令超时或被取消');
      }
      return {
        stdout: truncate(String(details.stdout ?? '')),
        stderr: truncate(String(details.stderr ?? '')),
        exitCode,
        environmentKeys: Object.keys(childEnvironment).sort(),
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

export function makeExplicitEnvironment(
  source: NodeJS.ProcessEnv,
  runValues: { LUOWANG_RUN_ID: string; LUOWANG_TARGET_COMMIT: string },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.LUOWANG_RUN_ID = runValues.LUOWANG_RUN_ID;
  result.LUOWANG_TARGET_COMMIT = runValues.LUOWANG_TARGET_COMMIT;
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return result;
}

export function parseCommand(command: string): string[] {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ControlledCommandError('COMMAND_INVALID', '命令不能为空');
  }
  if (/[;&|<>`\r\n]|\$\(|\)\s*\(/.test(command)) {
    throw new ControlledCommandError('COMMAND_INVALID', '命令不允许包含 shell 管道、重定向或替换');
  }
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'") {
      quote = 'single';
    } else if (character === '"') {
      quote = 'double';
    } else if (/\s/.test(character)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (quote) throw new ControlledCommandError('COMMAND_INVALID', '命令引号未闭合');
  if (current !== '') tokens.push(current);
  if (tokens.length === 0) throw new ControlledCommandError('COMMAND_INVALID', '命令不能为空');
  if (tokens.some((token) => token.includes('\u0000') || token.includes('='))) {
    throw new ControlledCommandError('COMMAND_INVALID', '命令不允许注入环境变量');
  }
  return tokens;
}

function normalizeExecutable(value: string): string {
  if (value.includes('/') || value.includes('\\')) {
    throw new ControlledCommandError(
      'COMMAND_NOT_ALLOWED',
      'Runner 只能执行白名单中的命令名，不能指定可执行文件路径',
    );
  }
  return value.toLowerCase();
}

function assertSafeInterpreterArguments(executable: string, args: string[]): void {
  const blocked =
    executable === 'node' || executable === 'node.exe'
      ? new Set([
          '-e',
          '--eval',
          '-p',
          '--print',
          '-r',
          '--require',
          '--import',
          '--loader',
          '--experimental-loader',
        ])
      : executable === 'python' ||
          executable === 'python.exe' ||
          executable === 'python3' ||
          executable === 'python3.exe'
        ? new Set(['-c', '--command'])
        : undefined;
  if (!blocked) return;
  if (
    args.some((argument) => {
      const normalized = argument.toLowerCase();
      return (
        blocked.has(normalized) ||
        [...blocked].some(
          (option) =>
            normalized.startsWith(`${option}=`) ||
            (option.length === 2 &&
              normalized.startsWith(option) &&
              normalized.length > option.length),
        )
      );
    })
  ) {
    throw new ControlledCommandError(
      'COMMAND_NOT_ALLOWED',
      'Runner 不允许解释器直接执行内联代码或加载外部代码',
    );
  }
}

function assertReadOnlyGitArguments(subcommand: string, args: string[]): void {
  const blocked = new Set([
    '-c',
    '-C',
    '--config-env',
    '--exec-path',
    '--ext-diff',
    '--git-dir',
    '--no-index',
    '--namespace',
    '--output',
    '--textconv',
    '--work-tree',
    '-o',
  ]);
  if (
    args.some((argument) => {
      const normalized = argument.toLowerCase();
      return (
        blocked.has(normalized) ||
        normalized.startsWith('--output=') ||
        normalized.startsWith('--git-dir=') ||
        normalized.startsWith('--work-tree=')
      );
    })
  ) {
    throw new ControlledCommandError(
      'COMMAND_NOT_ALLOWED',
      'Runner 只能执行不会写文件或切换 Git 工作树的命令',
    );
  }

  if (subcommand !== 'branch') return;
  const branchListingOptions = new Set([
    '--all',
    '--list',
    '--no-color',
    '--remotes',
    '--show-current',
    '-a',
    '-l',
    '-r',
  ]);
  if (args.some((argument) => !branchListingOptions.has(argument.toLowerCase()))) {
    throw new ControlledCommandError(
      'COMMAND_NOT_ALLOWED',
      'Runner 只能读取 Git 分支，不能创建、删除或移动分支',
    );
  }
}

function resolveExecutable(value: string): string {
  if (process.platform !== 'win32') return value;
  const normalized = normalizeExecutable(value);
  if (normalized.endsWith('.cmd') || normalized.endsWith('.exe') || normalized.endsWith('.bat')) {
    return value;
  }
  if (
    normalized === 'npm' ||
    normalized === 'npx' ||
    normalized === 'pnpm' ||
    normalized === 'yarn'
  ) {
    return `${value}.cmd`;
  }
  return value;
}

function truncate(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES) return value;
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`;
}
