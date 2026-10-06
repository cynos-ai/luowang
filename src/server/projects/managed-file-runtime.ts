import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DockerRuntime } from './execution-container.js';
import type { ExecutionAdapter } from './execution-adapter.js';
import { ControlledCommandError } from '../runs/command-runner.js';
import { isManagedFilePath } from './managed-file-path.js';

const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;
export type ManagedFileRuntimeInput = {
  id: string;
  revision: number;
  path: string;
  serviceName: string | null;
  content: string;
};

export async function injectManagedFiles(input: {
  docker: DockerRuntime;
  executionAdapter?: ExecutionAdapter;
  containerId: string;
  serviceName?: string | null;
  destinationRoot?: string;
  files: ManagedFileRuntimeInput[];
  signal?: AbortSignal;
}): Promise<void> {
  const selected = input.files.filter(
    (file) => file.serviceName === null || file.serviceName === (input.serviceName ?? null),
  );
  if (selected.length === 0) return;
  const destinationRoot = input.destinationRoot ?? '/luowang-source';
  if (!destinationRoot.startsWith('/') || destinationRoot.includes('..'))
    throw new ControlledCommandError('COMMAND_INVALID', '受控配置文件目标根目录无效');
  let total = 0;
  const seen = new Set<string>();
  for (const file of selected) {
    validatePath(file.path);
    const size = Buffer.byteLength(file.content, 'utf8');
    if (!file.content || size > MAX_FILE || (total += size) > MAX_TOTAL)
      throw new ControlledCommandError('COMMAND_INVALID', '受控配置文件超过大小限制');
    if (seen.has(file.path))
      throw new ControlledCommandError('COMMAND_INVALID', '受控配置文件路径冲突');
    seen.add(file.path);
  }
  const staging = await mkdtemp(join(tmpdir(), 'luowang-managed-'));
  try {
    input.signal?.throwIfAborted();
    const state = await input.docker.run(
      ['inspect', '--format', '{{.State.Running}}', input.containerId],
      { timeoutMs: 10_000, signal: input.signal },
    );
    input.signal?.throwIfAborted();
    if (state.exitCode !== 0)
      throw new ControlledCommandError('COMMAND_FAILED', '无法核对配置文件容器状态');
    if (state.stdout.trim() === 'false') {
      await injectIntoStoppedContainer(input, selected, staging, destinationRoot);
      return;
    }
    for (const [index, file] of selected.entries()) {
      input.signal?.throwIfAborted();
      const destination = `${destinationRoot.replace(/\/$/, '')}/${file.path}`;
      const exists = await input.docker.run(
        [
          'exec',
          input.containerId,
          'sh',
          '-c',
          'test -e "$1" || test -L "$1"',
          'luowang',
          destination,
        ],
        { timeoutMs: 10_000, signal: input.signal },
      );
      if (exists.exitCode === 0)
        throw new ControlledCommandError(
          'COMMAND_NOT_ALLOWED',
          `受控配置文件目标已存在：${file.path}`,
        );
      const parent = destination.slice(0, destination.lastIndexOf('/'));
      const parentCheck = await input.docker.run(
        [
          'exec',
          input.containerId,
          'sh',
          '-eu',
          '-c',
          'current=$1; rest=$2; old_ifs=$IFS; IFS=/; for part in $rest; do current="$current/$part"; test ! -L "$current"; if test -e "$current"; then test -d "$current"; else mkdir -- "$current"; fi; done; IFS=$old_ifs',
          'luowang',
          destinationRoot,
          parent.slice(destinationRoot.replace(/\/$/, '').length + 1),
        ],
        { timeoutMs: 10_000, signal: input.signal },
      );
      if (parentCheck.exitCode !== 0)
        throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '受控配置文件父路径无效');
      const local = join(staging, String(index));
      await writeFile(local, file.content, { mode: 0o600, flag: 'wx' });
      input.signal?.throwIfAborted();
      const dockerSource = input.executionAdapter?.locationId.startsWith('server:')
        ? `/tmp/luowang-managed/${input.containerId}/${index}`
        : local;
      if (dockerSource !== local) {
        await input.executionAdapter!.upload(local, dockerSource, {
          signal: input.signal,
          timeoutMs: 60_000,
        });
        input.signal?.throwIfAborted();
      }
      const copied = await input.docker.run(
        // Docker's archive copy-to-container resolves ownership from Config.User.
        ['cp', '--archive', dockerSource, `${input.containerId}:${destination}`],
        { timeoutMs: 30_000, signal: input.signal },
      );
      input.signal?.throwIfAborted();
      if (copied.exitCode !== 0)
        throw new ControlledCommandError('COMMAND_FAILED', '受控配置文件注入失败');
    }
  } finally {
    if (input.executionAdapter?.locationId.startsWith('server:'))
      await input.executionAdapter
        .removeTree(`/tmp/luowang-managed/${input.containerId}`)
        .catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
  }
}

async function injectIntoStoppedContainer(
  input: {
    docker: DockerRuntime;
    executionAdapter?: ExecutionAdapter;
    containerId: string;
    signal?: AbortSignal;
  },
  files: ManagedFileRuntimeInput[],
  staging: string,
  destinationRoot: string,
): Promise<void> {
  const inspection = join(staging, 'inspection');
  const payload = join(staging, 'payload');
  await mkdir(inspection, { recursive: true });
  await mkdir(payload, { recursive: true });
  input.signal?.throwIfAborted();
  const remote = input.executionAdapter?.locationId.startsWith('server:');
  const remoteRoot = `/tmp/luowang-managed/${input.containerId}`;
  const remoteInspection = `${remoteRoot}/inspection`;
  if (remote)
    await input.executionAdapter!.uploadTree(inspection, remoteInspection, {
      signal: input.signal,
      timeoutMs: 60_000,
    });
  const copiedOut = await input.docker.run(
    ['cp', `${input.containerId}:${destinationRoot}/.`, remote ? remoteInspection : inspection],
    { timeoutMs: 120_000, signal: input.signal },
  );
  if (copiedOut.exitCode !== 0)
    throw new ControlledCommandError('COMMAND_FAILED', '无法核对容器内的配置文件目标');
  if (remote) {
    await input.executionAdapter!.downloadTree(remoteInspection, inspection, {
      signal: input.signal,
      timeoutMs: 120_000,
    });
    input.signal?.throwIfAborted();
  }
  for (const file of files) {
    input.signal?.throwIfAborted();
    await assertSafeDestination(inspection, file.path);
    const target = join(payload, ...file.path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
  }
  const dockerSource = remote ? `${remoteRoot}/payload` : payload;
  if (remote) {
    await input.executionAdapter!.uploadTree(payload, dockerSource, {
      signal: input.signal,
      timeoutMs: 120_000,
    });
    input.signal?.throwIfAborted();
  }
  const copiedIn = await input.docker.run(
    ['cp', '--archive', `${dockerSource}/.`, `${input.containerId}:${destinationRoot}`],
    { timeoutMs: 30_000, signal: input.signal },
  );
  input.signal?.throwIfAborted();
  if (copiedIn.exitCode !== 0)
    throw new ControlledCommandError('COMMAND_FAILED', '受控配置文件注入失败');
  if (remote) await input.executionAdapter!.removeTree(remoteRoot).catch(() => undefined);
}

async function assertSafeDestination(root: string, relativePath: string): Promise<void> {
  let current = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '受控配置文件父路径无效');
      if (index === parts.length - 1)
        throw new ControlledCommandError(
          'COMMAND_NOT_ALLOWED',
          `受控配置文件目标已存在：${relativePath}`,
        );
      if (!info.isDirectory())
        throw new ControlledCommandError('COMMAND_NOT_ALLOWED', '受控配置文件父路径无效');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export class StreamingSecretRedactor {
  private carry = '';
  private readonly variants: string[];
  private readonly tail: number;
  constructor(values: string[]) {
    this.variants = [
      ...new Set(
        values.flatMap((value) => secretVariants(value)).filter((value) => value.length >= 4),
      ),
    ].sort((a, b) => b.length - a.length);
    this.tail = Math.max(0, ...this.variants.map((value) => value.length - 1));
  }
  push(chunk: string): string {
    const combined = this.carry + chunk;
    const safeLength = Math.max(0, combined.length - this.tail);
    const visible = combined.slice(0, safeLength);
    this.carry = combined.slice(safeLength);
    return this.redact(visible);
  }
  finish(): string {
    const value = this.redact(this.carry);
    this.carry = '';
    return value;
  }
  redact(value: string): string {
    let result = value;
    for (const secret of this.variants) result = result.split(secret).join('[REDACTED]');
    return result;
  }
}

/** Values that must be registered before any application output is persisted. */
export function managedFileSensitiveValues(files: readonly ManagedFileRuntimeInput[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => secretVariants(file.content)).filter((value) => value.length >= 4),
    ),
  ];
}

function secretVariants(content: string): string[] {
  const values = [content];
  for (const line of content.split(/\r?\n/)) {
    const env = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/
      .exec(line)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    if (env) values.push(env);
    const scalar = /^[^:#]+:\s*(.+)$/
      .exec(line)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    if (scalar) values.push(scalar);
  }
  for (const match of content.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try {
      values.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      /* Ignore malformed quoted scalars; the full content remains registered. */
    }
  }
  try {
    const parsed = JSON.parse(content);
    collectScalars(parsed, values);
  } catch {
    /* Non-JSON managed files are handled by env/YAML scalar extraction above. */
  }
  return values;
}
function collectScalars(value: unknown, result: string[]): void {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectScalars(item, result));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => collectScalars(item, result));
}
function validatePath(path: string): void {
  if (!isManagedFilePath(path))
    throw new ControlledCommandError('COMMAND_INVALID', '受控配置文件路径无效');
}
