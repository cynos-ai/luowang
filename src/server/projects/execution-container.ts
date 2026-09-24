import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ControlledCommandError,
  parseControlledCommand,
  type CommandRunResult,
  type ControlledCommandRunner,
} from '../runs/command-runner.js';

import type { ProjectRunSource } from './run-source.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface DockerRuntimeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface DockerRuntime {
  run(
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<DockerRuntimeResult>;
}

export interface ProjectCommandSession extends ControlledCommandRunner {
  readonly containerId: string;
  close(): Promise<void>;
}

export function createDockerRuntime(): DockerRuntime {
  return {
    async run(args, options) {
      try {
        const result = await execFileAsync('docker', args, {
          timeout: options.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          signal: options.signal,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: process.env.HOME,
            DOCKER_HOST: process.env.DOCKER_HOST,
          },
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const details = error as {
          code?: number | string;
          signal?: string;
          stdout?: string;
          stderr?: string;
        };
        if (
          options.signal?.aborted ||
          details.code === 'ETIMEDOUT' ||
          details.code === 'ABORT_ERR' ||
          details.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ) {
          throw new ControlledCommandError('COMMAND_FAILED', '项目容器命令超时、取消或输出超限');
        }
        return {
          stdout: String(details.stdout ?? ''),
          stderr: String(details.stderr ?? ''),
          exitCode: typeof details.code === 'number' ? details.code : null,
        };
      }
    },
  };
}

/** Start one Run container from a pinned image and its isolated Run source. */
export async function startProjectCommandSession(
  input: {
    projectId: string;
    runId: string;
    targetCommit: string;
    imageId: string;
    repositoryDirectory: string;
    sourceRoot: string;
    runSource: ProjectRunSource;
  },
  docker: DockerRuntime = createDockerRuntime(),
): Promise<ProjectCommandSession> {
  if (
    !PROJECT_ID.test(input.projectId) ||
    !RUN_ID.test(input.runId) ||
    !COMMIT_SHA.test(input.targetCommit) ||
    !IMAGE_ID.test(input.imageId) ||
    (input.runSource.scenarioPatchSha256 !== null &&
      !/^[0-9a-f]{64}$/.test(input.runSource.scenarioPatchSha256))
  ) {
    throw new ControlledCommandError('COMMAND_INVALID', '项目执行容器身份无效');
  }
  if (
    input.runSource.projectId !== input.projectId ||
    input.runSource.runId !== input.runId ||
    input.runSource.targetCommit !== input.targetCommit
  ) {
    throw new ControlledCommandError('COMMAND_NOT_ALLOWED', 'Run 源码与执行容器归属不符');
  }
  const sourceDirectory = resolve(input.runSource.directory);
  const expectedRoot = resolve(input.sourceRoot, 'projects', input.projectId, 'run-sources');
  const sourceParts = relative(expectedRoot, sourceDirectory).split(sep);
  if (
    sourceParts.length !== 2 ||
    !/^source-[a-zA-Z0-9_-]+$/.test(sourceParts[0]) ||
    sourceParts[1] !== 'context'
  ) {
    throw new ControlledCommandError('COMMAND_NOT_ALLOWED', 'Run 源码不在当前项目受控目录');
  }
  const sourceInfo = await lstat(sourceDirectory);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new ControlledCommandError('COMMAND_INVALID', 'Run 源码目录无效');
  }
  if ((await realpath(sourceDirectory)) !== sourceDirectory) {
    throw new ControlledCommandError('COMMAND_INVALID', 'Run 源码路径不能经过符号链接');
  }
  const inspected = await requireDockerSuccess(
    docker,
    ['image', 'inspect', '--format', '{{json .Config.Labels}}', input.imageId],
    10_000,
  );
  let labels: Record<string, unknown>;
  try {
    labels = JSON.parse(inspected.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new ControlledCommandError('COMMAND_FAILED', '项目镜像标签无法核验');
  }
  if (
    labels?.['luowang.project-id'] !== input.projectId ||
    labels?.['luowang.target-commit'] !== input.targetCommit
  ) {
    throw new ControlledCommandError('COMMAND_FAILED', '项目镜像与 Run 归属或目标提交不符');
  }
  const name = `luowang-run-${input.runId.toLowerCase()}`;
  const created = await requireDockerSuccess(
    docker,
    [
      'create',
      '--name',
      name,
      '--label',
      `luowang.project-id=${input.projectId}`,
      '--label',
      `luowang.run-id=${input.runId}`,
      '--label',
      `luowang.target-commit=${input.targetCommit}`,
      '--label',
      `luowang.scenario-patch-sha256=${input.runSource.scenarioPatchSha256 ?? 'none'}`,
      '--workdir',
      '/luowang-source',
      '--entrypoint',
      'sleep',
      input.imageId,
      'infinity',
    ],
    30_000,
  );
  const containerId = created.stdout.trim();
  if (!CONTAINER_ID.test(containerId)) {
    await docker.run(['rm', '--force', name], { timeoutMs: 30_000 }).catch(() => undefined);
    throw new ControlledCommandError('COMMAND_FAILED', 'Docker 未返回有效容器 ID');
  }
  try {
    await requireDockerSuccess(
      docker,
      ['cp', `${sourceDirectory}/.`, `${containerId}:/luowang-source`],
      120_000,
    );
    await requireDockerSuccess(docker, ['start', containerId], 30_000);
  } catch (error) {
    await docker.run(['rm', '--force', containerId], { timeoutMs: 30_000 }).catch(() => undefined);
    throw error;
  }
  return new BoundProjectCommandSession(docker, containerId, {
    runId: input.runId,
    targetCommit: input.targetCommit,
    repositoryDirectory: resolve(input.repositoryDirectory),
  });
}

class BoundProjectCommandSession implements ProjectCommandSession {
  private closed = false;

  constructor(
    private readonly docker: DockerRuntime,
    readonly containerId: string,
    private readonly binding: {
      runId: string;
      targetCommit: string;
      repositoryDirectory: string;
    },
  ) {}

  async run(
    command: string,
    options: { cwd: string; runId: string; targetCommit: string; signal?: AbortSignal },
  ): Promise<CommandRunResult> {
    if (this.closed) throw new ControlledCommandError('COMMAND_FAILED', '项目执行容器已关闭');
    if (
      options.runId !== this.binding.runId ||
      options.targetCommit !== this.binding.targetCommit ||
      resolve(options.cwd) !== this.binding.repositoryDirectory
    ) {
      throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '命令与项目 Run 上下文不符');
    }
    const args = parseControlledCommand(command);
    if (options.signal?.aborted) {
      throw new ControlledCommandError('COMMAND_FAILED', '受控命令已被取消');
    }
    try {
      const result = await this.docker.run(
        [
          'exec',
          '--workdir',
          '/luowang-source',
          '--env',
          `LUOWANG_RUN_ID=${this.binding.runId}`,
          '--env',
          `LUOWANG_TARGET_COMMIT=${this.binding.targetCommit}`,
          this.containerId,
          ...args,
        ],
        { timeoutMs: 120_000, signal: options.signal },
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        environmentKeys: ['LUOWANG_RUN_ID', 'LUOWANG_TARGET_COMMIT'],
      };
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await requireDockerSuccess(this.docker, ['rm', '--force', this.containerId], 30_000);
    this.closed = true;
  }
}

async function requireDockerSuccess(
  docker: DockerRuntime,
  args: string[],
  timeoutMs: number,
): Promise<DockerRuntimeResult> {
  const result = await docker.run(args, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new ControlledCommandError('COMMAND_FAILED', `Docker ${args[0]} 操作失败`);
  }
  return result;
}
