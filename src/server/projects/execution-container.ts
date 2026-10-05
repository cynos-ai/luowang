import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ControlledCommandError,
  type CommandRunResult,
  type ControlledCommandRunner,
} from '../runs/command-runner.js';

import type { ProjectRunSource } from './run-source.js';
import type { ExecutionAdapter } from './execution-adapter.js';

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

/** Attach Runner commands to the application owner's fixed command service. */
export async function createAttachedProjectCommandSession(
  input: {
    projectId: string;
    runId: string;
    targetCommit: string;
    repositoryDirectory: string;
    containerId: string;
    sourceRoot: string;
    workingDirectory: string;
  },
  docker: DockerRuntime,
): Promise<ProjectCommandSession> {
  if (
    !PROJECT_ID.test(input.projectId) ||
    !RUN_ID.test(input.runId) ||
    !COMMIT_SHA.test(input.targetCommit) ||
    !/^[0-9a-f]{12,64}$/.test(input.containerId) ||
    !input.sourceRoot.startsWith('/') ||
    posix.normalize(input.sourceRoot) !== input.sourceRoot ||
    (input.workingDirectory !== input.sourceRoot &&
      !input.workingDirectory.startsWith(`${input.sourceRoot}/`))
  )
    throw new ControlledCommandError('COMMAND_INVALID', '项目测试服务身份无效');
  const inspected = await requireDockerSuccess(
    docker,
    ['inspect', '--format', '{{json .Config.Labels}}', input.containerId],
    10_000,
  );
  let labels: Record<string, unknown>;
  try {
    labels = JSON.parse(inspected.stdout) as Record<string, unknown>;
  } catch {
    throw new ControlledCommandError('COMMAND_FAILED', '测试服务归属无法核验');
  }
  if (
    labels['luowang.project-id'] !== input.projectId ||
    (labels['luowang.run-id'] !== input.runId && labels['luowang.attempt-id'] !== input.runId)
  )
    throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '测试服务不属于当前 Run');
  return {
    containerId: input.containerId,
    async run(command, options) {
      if (
        options.runId !== input.runId ||
        options.targetCommit !== input.targetCommit ||
        resolve(options.cwd) !== resolve(input.repositoryDirectory)
      )
        throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '命令与项目 Run 上下文不符');
      const args = containerShellCommand(command);
      options.signal?.throwIfAborted();
      let result: DockerRuntimeResult;
      try {
        result = await docker.run(
          [
            'exec',
            '--workdir',
            input.workingDirectory,
            '--env',
            `LUOWANG_RUN_ID=${input.runId}`,
            '--env',
            `LUOWANG_TARGET_COMMIT=${input.targetCommit}`,
            input.containerId,
            ...args,
          ],
          { timeoutMs: 120_000, signal: options.signal },
        );
      } catch (error) {
        // Closing an SSH/Docker client does not prove the exec process exited.
        // Stop the owned command service so the Run owner can perform final cleanup.
        await docker.run(['kill', input.containerId], { timeoutMs: 30_000 }).catch(() => undefined);
        throw error;
      }
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        environmentKeys: ['LUOWANG_RUN_ID', 'LUOWANG_TARGET_COMMIT'],
      };
    },
    async close() {},
  };
}

export function createDockerRuntime(): DockerRuntime {
  return {
    async run(args, options) {
      try {
        const result = await execFileAsync('docker', args, {
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          signal: options.signal,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            ProgramFiles: process.env.ProgramFiles,
            DOCKER_CONFIG: process.env.DOCKER_CONFIG,
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

export function createDockerRuntimeFromAdapter(adapter: ExecutionAdapter): DockerRuntime {
  return {
    async run(args, options) {
      const result = await adapter.execute('docker', args, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
    },
  };
}

/** Start one Run container from a pinned image and its isolated Run source. */
export async function startProjectCommandSession(
  input: {
    signal?: AbortSignal;
    onExitUnconfirmed?: () => void;
    projectId: string;
    instanceId: string;
    runId: string;
    targetCommit: string;
    imageId: string;
    repositoryDirectory: string;
    sourceRoot: string;
    runSource: ProjectRunSource;
    /** A source tree already copied to a fixed execution-server workspace. */
    executionSourceDirectory?: string;
  },
  docker: DockerRuntime = createDockerRuntime(),
): Promise<ProjectCommandSession> {
  if (
    !PROJECT_ID.test(input.projectId) ||
    !PROJECT_ID.test(input.instanceId) ||
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
  const sourceDirectory = input.executionSourceDirectory ?? resolve(input.runSource.directory);
  const expectedRoot = resolve(input.sourceRoot, 'projects', input.projectId, 'run-sources');
  if (input.executionSourceDirectory) {
    const expected = `/tmp/luowang/${input.instanceId}/${input.projectId}/command-${input.runId}`;
    if (sourceDirectory !== expected)
      throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '远程 Run 源码路径不受控');
  } else {
    const sourceParts = relative(expectedRoot, sourceDirectory).split(sep);
    if (
      sourceParts.length !== 2 ||
      !/^source-[a-zA-Z0-9_-]+$/.test(sourceParts[0]) ||
      sourceParts[1] !== 'context'
    )
      throw new ControlledCommandError('COMMAND_NOT_ALLOWED', 'Run 源码不在当前项目受控目录');
    const sourceInfo = await lstat(sourceDirectory);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
      throw new ControlledCommandError('COMMAND_INVALID', 'Run 源码目录无效');
    if ((await realpath(sourceDirectory)) !== sourceDirectory)
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
  input.signal?.throwIfAborted();
  const created = await requireDockerSuccess(
    docker,
    [
      'create',
      '--name',
      name,
      '--label',
      `luowang.project-id=${input.projectId}`,
      '--label',
      `luowang.instance-id=${input.instanceId}`,
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
  ).catch(async (error: unknown) => {
    if (input.signal?.aborted) {
      // A canceled create may have reached Docker even if its reply was lost.
      // Reconcile the reserved name and all ownership labels before releasing.
      for (;;) {
        try {
          const found = await requireDockerSuccess(
            docker,
            ['ps', '--all', '--no-trunc', '--quiet', '--filter', `name=^/${name}$`],
            30_000,
          );
          const id = found.stdout.trim();
          if (!id) break;
          if (!CONTAINER_ID.test(id)) throw new Error('无法确认准备容器身份');
          const inspected = await requireDockerSuccess(
            docker,
            ['inspect', '--format', '{{json .Config.Labels}}', id],
            30_000,
          );
          const labels = JSON.parse(inspected.stdout) as Record<string, string>;
          if (
            labels['luowang.instance-id'] !== input.instanceId ||
            labels['luowang.project-id'] !== input.projectId ||
            labels['luowang.run-id'] !== input.runId ||
            labels['luowang.target-commit'] !== input.targetCommit
          )
            throw new Error('准备容器归属尚未确认');
          await requireDockerSuccess(docker, ['rm', '--force', id], 30_000);
          break;
        } catch {
          input.onExitUnconfirmed?.();
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      }
    }
    throw error;
  });
  const containerId = created.stdout.trim();
  if (!CONTAINER_ID.test(containerId)) {
    throw new ControlledCommandError('COMMAND_FAILED', 'Docker 未返回有效容器 ID');
  }
  try {
    input.signal?.throwIfAborted();
    await requireDockerSuccess(
      docker,
      ['cp', `${sourceDirectory}/.`, `${containerId}:/luowang-source`],
      120_000,
    );
    input.signal?.throwIfAborted();
    await requireDockerSuccess(docker, ['start', containerId], 30_000);
    input.signal?.throwIfAborted();
  } catch (error) {
    const owned = new BoundProjectCommandSession(docker, containerId, {
      runId: input.runId,
      targetCommit: input.targetCommit,
      repositoryDirectory: resolve(input.repositoryDirectory),
    });
    for (;;) {
      try {
        await owned.close();
        break;
      } catch {
        input.onExitUnconfirmed?.();
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    }
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
  private closing: Promise<void> | undefined;

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
    if (this.closed || this.closing)
      throw new ControlledCommandError('COMMAND_FAILED', '项目执行容器已关闭或正在关闭');
    if (
      options.runId !== this.binding.runId ||
      options.targetCommit !== this.binding.targetCommit ||
      resolve(options.cwd) !== this.binding.repositoryDirectory
    ) {
      throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '命令与项目 Run 上下文不符');
    }
    const args = containerShellCommand(command);
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
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        await requireDockerSuccess(this.docker, ['rm', '--force', this.containerId], 30_000);
      } catch (error) {
        // Removal can succeed even when its response is lost. Only a successful
        // daemon query proving absence makes a repeated close successful.
        const remaining = await requireDockerSuccess(
          this.docker,
          ['ps', '--all', '--no-trunc', '--quiet', '--filter', `id=${this.containerId}`],
          30_000,
        );
        if (remaining.stdout.trim()) throw error;
      }
      this.closed = true;
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}

function containerShellCommand(command: string): string[] {
  if (
    typeof command !== 'string' ||
    command.trim() === '' ||
    command.length > 16_384 ||
    command.includes('\0')
  )
    throw new ControlledCommandError('COMMAND_INVALID', '项目命令无效');
  return ['/bin/sh', '-lc', command];
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
