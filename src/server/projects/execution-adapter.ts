import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, type ConnectConfig } from 'ssh2';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;
export type ExecutionResult = { stdout: string; stderr: string; code: number };
export type ExecutionTransferOptions = { signal?: AbortSignal; timeoutMs?: number };
export interface ExecutionAdapter {
  readonly locationId: string;
  execute(
    program: 'docker',
    args: readonly string[],
    options?: {
      cwd?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      isolateEnvironment?: boolean;
    },
  ): Promise<ExecutionResult>;
  upload(localPath: string, remotePath: string, options?: ExecutionTransferOptions): Promise<void>;
  download(
    remotePath: string,
    localPath: string,
    options?: ExecutionTransferOptions,
  ): Promise<void>;
  uploadTree(
    localDirectory: string,
    remoteDirectory: string,
    options?: ExecutionTransferOptions,
  ): Promise<void>;
  downloadTree(
    remoteDirectory: string,
    localDirectory: string,
    options?: ExecutionTransferOptions,
  ): Promise<void>;
  removeFile?(remotePath: string): Promise<void>;
  removeTree(remoteDirectory: string): Promise<void>;
  openTunnel?(
    remoteHost: string,
    remotePort: number,
  ): Promise<{ port: number; close(): Promise<void> }>;
  close(): Promise<void>;
}

export function createLocalExecutionAdapter(locationId: string): ExecutionAdapter {
  return {
    locationId,
    async execute(program, args, options = {}) {
      try {
        const result = await execFileAsync(program, [...args], {
          cwd: options.cwd,
          signal: options.signal,
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: MAX_OUTPUT,
          encoding: 'utf8',
          env: options.isolateEnvironment
            ? {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                DOCKER_CONFIG: process.env.DOCKER_CONFIG,
                DOCKER_HOST: process.env.DOCKER_HOST,
              }
            : process.env,
        });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? failure.message,
          code: typeof failure.code === 'number' ? failure.code : 1,
        };
      }
    },
    async upload(localPath, remotePath, options) {
      await controlledTransfer(options, async () => {
        await mkdir(dirname(remotePath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(localPath);
          const write = createWriteStream(remotePath, { flags: 'wx' });
          read.on('error', reject);
          write.on('error', reject);
          write.on('finish', resolve);
          read.pipe(write);
        });
      });
    },
    async download(remotePath, localPath, options) {
      await controlledTransfer(options, async () => {
        await mkdir(dirname(localPath), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(remotePath);
          const write = createWriteStream(localPath, { flags: 'wx' });
          read.on('error', reject);
          write.on('error', reject);
          write.on('finish', resolve);
          read.pipe(write);
        });
      });
    },
    async uploadTree(localDirectory, remoteDirectory, options) {
      await controlledTransfer(options, () =>
        cp(localDirectory, remoteDirectory, { recursive: true, errorOnExist: true }),
      );
    },
    async downloadTree(remoteDirectory, localDirectory, options) {
      await controlledTransfer(options, () =>
        cp(remoteDirectory, localDirectory, { recursive: true, errorOnExist: true }),
      );
    },
    async removeFile(remotePath) {
      await rm(remotePath, { force: true });
    },
    async removeTree() {},
    async close() {},
  };
}

export async function createSshExecutionAdapter(input: {
  locationId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  pinnedFingerprint: string;
  readyTimeoutMs?: number;
}): Promise<ExecutionAdapter> {
  const client = new Client();
  const config: ConnectConfig = {
    host: input.host,
    port: input.port,
    username: input.username,
    password: input.password,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    agent: undefined,
    agentForward: false,
    readyTimeout: input.readyTimeoutMs ?? 15_000,
    hostVerifier: (key: Buffer) =>
      `SHA256:${createHash('sha256').update(key).digest('base64')}` === input.pinnedFingerprint,
  };
  await new Promise<void>((resolve, reject) =>
    client.once('ready', resolve).once('error', reject).connect(config),
  );
  const sftp = () =>
    new Promise<import('ssh2').SFTPWrapper>((resolve, reject) =>
      client.sftp((error, value) => (error ? reject(error) : resolve(value))),
    );
  const mkdirRemote = async (channel: import('ssh2').SFTPWrapper, path: string) => {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      await new Promise<void>((resolve, reject) =>
        channel.mkdir(current, { mode: 0o700 }, (error) => {
          if (!error) {
            resolve();
            return;
          }
          channel.stat(current, (statError, attributes) => {
            if (!statError && (attributes.mode & 0o170000) === 0o040000) resolve();
            else reject(error);
          });
        }),
      );
    }
  };
  const removeRemote = async (channel: import('ssh2').SFTPWrapper, path: string): Promise<void> => {
    const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) =>
      channel.readdir(path, (error, list) => (error ? reject(error) : resolve(list))),
    );
    for (const entry of entries) {
      const target = posix.join(path, entry.filename);
      if ((entry.attrs.mode & 0o170000) === 0o040000) await removeRemote(channel, target);
      else
        await new Promise<void>((resolve, reject) =>
          channel.unlink(target, (error) => (error ? reject(error) : resolve())),
        );
    }
    await new Promise<void>((resolve, reject) =>
      channel.rmdir(path, (error) => (error ? reject(error) : resolve())),
    );
  };
  return {
    locationId: input.locationId,
    execute(program, args, options = {}) {
      if (
        program !== 'docker' ||
        args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 16_384)
      )
        return Promise.reject(new Error('远程执行参数无效'));
      if (options.cwd && (!options.cwd.startsWith('/') || options.cwd.includes('\0')))
        return Promise.reject(new Error('远程工作目录无效'));
      const dockerCommand = ['docker', ...args].map(posixQuote).join(' ');
      const effectiveCommand = options.isolateEnvironment
        ? `env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ${dockerCommand}`
        : dockerCommand;
      const command = options.cwd
        ? `cd ${posixQuote(options.cwd)} && ${effectiveCommand}`
        : effectiveCommand;
      return new Promise<ExecutionResult>((resolve, reject) => {
        let settled = false;
        let activeStream: import('ssh2').ClientChannel | undefined;
        const onAbort = () => {
          activeStream?.close();
          fail(options.signal?.reason ?? new Error('操作已取消'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (value: ExecutionResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          activeStream?.close();
          fail(new Error('远程命令超时，执行结果未知'));
        }, options.timeoutMs ?? 120_000);
        timer.unref();
        client.exec(command, (error, stream) => {
          if (error) {
            fail(error);
            return;
          }
          activeStream = stream;
          let stdout = '';
          let stderr = '';
          const append = (target: string, chunk: Buffer) => {
            const next = target + chunk.toString('utf8');
            if (Buffer.byteLength(next) > MAX_OUTPUT) {
              stream.close();
              fail(new Error('远程命令输出超过限制'));
              return target;
            }
            return next;
          };
          stream.on('data', (chunk: Buffer) => {
            stdout = append(stdout, chunk);
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            stderr = append(stderr, chunk);
          });
          stream.on('close', (code: number) => finish({ stdout, stderr, code: code ?? 1 }));
          stream.on('error', fail);
        });
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    async upload(localPath, remotePath, options) {
      await controlledTransfer(
        options,
        async () => {
          const channel = await sftp();
          try {
            await mkdirRemote(channel, posix.dirname(remotePath));
            await new Promise<void>((resolve, reject) =>
              channel.fastPut(localPath, remotePath, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          } finally {
            channel.end();
          }
        },
        () => client.end(),
      );
    },
    async download(remotePath, localPath, options) {
      await controlledTransfer(
        options,
        async () => {
          await mkdir(dirname(localPath), { recursive: true });
          const channel = await sftp();
          try {
            await new Promise<void>((resolve, reject) =>
              channel.fastGet(remotePath, localPath, (error) =>
                error ? reject(error) : resolve(),
              ),
            );
          } finally {
            channel.end();
          }
        },
        () => client.end(),
      );
    },
    async uploadTree(localDirectory, remoteDirectory, options) {
      await controlledTransfer(
        options,
        async () => {
          const channel = await sftp();
          await mkdirRemote(channel, remoteDirectory);
          const walk = async (local: string, remote: string): Promise<void> => {
            for (const entry of await readdir(local, { withFileTypes: true })) {
              const source = `${local}/${entry.name}`;
              const target = posix.join(remote, entry.name);
              if (entry.isSymbolicLink()) throw new Error('远程传输拒绝符号链接');
              if (entry.isDirectory()) {
                await mkdirRemote(channel, target);
                await walk(source, target);
              } else if (entry.isFile()) {
                const info = await stat(source);
                if (info.size > 512 * 1024 * 1024) throw new Error('远程传输文件超过限制');
                await new Promise<void>((resolve, reject) =>
                  channel.fastPut(source, target, { mode: info.mode & 0o777 }, (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
              } else throw new Error('远程传输拒绝特殊文件');
            }
          };
          try {
            await walk(localDirectory, remoteDirectory);
          } finally {
            channel.end();
          }
        },
        () => client.end(),
      );
    },
    async downloadTree(remoteDirectory, localDirectory, options) {
      await controlledTransfer(
        options,
        async () => {
          const channel = await sftp();
          let total = 0;
          const walk = async (remote: string, local: string): Promise<void> => {
            await mkdir(local, { recursive: true });
            const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) =>
              channel.readdir(remote, (error, list) => (error ? reject(error) : resolve(list))),
            );
            for (const entry of entries) {
              const kind = entry.attrs.mode & 0o170000;
              const source = posix.join(remote, entry.filename);
              const target = `${local}/${entry.filename}`;
              if (kind === 0o120000) throw new Error('远程下载拒绝符号链接');
              if (kind === 0o040000) await walk(source, target);
              else if (kind === 0o100000) {
                total += entry.attrs.size;
                if (total > 512 * 1024 * 1024) throw new Error('远程下载目录超过限制');
                await new Promise<void>((resolve, reject) =>
                  channel.fastGet(source, target, (error) => (error ? reject(error) : resolve())),
                );
              } else throw new Error('远程下载拒绝特殊文件');
            }
          };
          try {
            await walk(remoteDirectory, localDirectory);
          } finally {
            channel.end();
          }
        },
        () => client.end(),
      );
    },
    async removeFile(remotePath) {
      const channel = await sftp();
      try {
        await new Promise<void>((resolve, reject) =>
          channel.unlink(remotePath, (error) => (error ? reject(error) : resolve())),
        );
      } finally {
        channel.end();
      }
    },
    async removeTree(remoteDirectory) {
      const channel = await sftp();
      try {
        await removeRemote(channel, remoteDirectory);
      } finally {
        channel.end();
      }
    },
    async openTunnel(remoteHost, remotePort) {
      const server = createServer((socket) => {
        client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, stream) => {
          if (error) {
            socket.destroy(error);
            return;
          }
          socket.pipe(stream).pipe(socket);
        });
      });
      await new Promise<void>((resolve, reject) =>
        server.once('error', reject).listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('SSH 隧道端口无效');
      return {
        port: address.port,
        close: () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      };
    },
    async close() {
      client.end();
    },
  };
}

async function controlledTransfer<T>(
  options: ExecutionTransferOptions | undefined,
  operation: () => Promise<T>,
  interrupt: () => void = () => undefined,
): Promise<T> {
  options?.signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (action: typeof resolve | typeof reject, value: T | unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      action(value as T);
    };
    const stop = (error: unknown) => {
      interrupt();
      finish(reject, error);
    };
    const onAbort = () => stop(options?.signal?.reason ?? new Error('操作已取消'));
    const timer = setTimeout(
      () => stop(new Error('文件传输超时，结果未知')),
      options?.timeoutMs ?? 5 * 60_000,
    );
    timer.unref();
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    operation().then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

export async function readSshHostFingerprint(input: {
  host: string;
  port: number;
  username: string;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint: string | null = null;
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('SSH 主机指纹检查超时'));
    }, input.timeoutMs ?? 10_000);
    timer.unref();
    client.on('error', (error) => {
      clearTimeout(timer);
      if (fingerprint) resolve(fingerprint);
      else reject(error);
    });
    client.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: input.timeoutMs ?? 10_000,
      hostVerifier: (key: Buffer) => {
        fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`;
        return false;
      },
    });
  });
}
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
