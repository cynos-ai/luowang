import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { GitCommandError, RepositoryError } from './errors.js';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_PATTERN = /^[^\s~^:?*\\[\]]{1,255}$/;

export interface GitRepositoryOptions {
  directory: string;
  remoteUrl: string;
  tokenProvider?: () => string | undefined;
}

export interface GitLogEntry {
  sha: string;
  authoredAt: string;
  subject: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface GitMergeResult {
  originalHead: string;
  sourceCommit: string;
  mergeCommit: string | null;
  scenarioBranchHead: string;
  alreadyIncluded: boolean;
}

export class GitRepository {
  readonly directory: string;
  readonly remoteUrl: string;
  private readonly tokenProvider?: () => string | undefined;

  constructor(options: GitRepositoryOptions) {
    this.directory = resolve(options.directory);
    this.remoteUrl = options.remoteUrl;
    this.tokenProvider = options.tokenProvider;
  }

  async ensureClone(): Promise<void> {
    if (await this.isGitWorktree()) {
      return;
    }

    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory);
    if (entries.length > 0) {
      throw new RepositoryError(
        'REPOSITORY_INVALID',
        'Repository 目录不是空目录且不是 Git 工作树',
        409,
      );
    }
    await this.run(
      ['clone', '--no-tags', '--', this.remoteUrl, this.directory],
      dirname(this.directory),
    );
  }

  async fetch(): Promise<void> {
    await this.ensureClone();
    await this.run(['fetch', '--prune', 'origin', '--tags']);
  }

  async remoteBranchHead(branch: string): Promise<string | null> {
    assertBranchName(branch);
    await this.ensureClone();
    const output = await this.run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    const line = output.stdout.trim().split(/\r?\n/, 1)[0];
    if (!line) {
      return null;
    }
    const sha = line.split(/\s+/, 1)[0];
    return SHA_PATTERN.test(sha) ? sha.toLowerCase() : null;
  }

  async resolveCommit(ref: string): Promise<string> {
    assertRef(ref);
    await this.ensureClone();
    const candidates = [ref];
    if (!ref.startsWith('refs/')) {
      candidates.push(`refs/remotes/origin/${ref}`, `refs/tags/${ref}`);
    }
    for (const candidate of candidates) {
      try {
        const result = await this.run([
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${candidate}^{commit}`,
        ]);
        const sha = result.stdout.trim().split(/\r?\n/, 1)[0];
        if (SHA_PATTERN.test(sha)) {
          return sha.toLowerCase();
        }
      } catch {
        // Try the next ref namespace.
      }
    }
    const remote = await this.resolveRemoteRef(ref);
    if (remote) {
      return remote;
    }
    throw new RepositoryError('TARGET_INVALID', `无法解析 Git ref：${ref}`, 400);
  }

  async resolveRemoteRef(ref: string): Promise<string | null> {
    assertRef(ref);
    await this.ensureClone();
    const output = await this.run(['ls-remote', '--refs', 'origin', ref]);
    const line = output.stdout.trim().split(/\r?\n/, 1)[0];
    if (line) {
      const sha = line.split(/\s+/, 1)[0];
      if (SHA_PATTERN.test(sha)) return sha.toLowerCase();
    }
    if (!ref.startsWith('refs/')) {
      const branch = await this.run(['ls-remote', '--heads', 'origin', `refs/heads/${ref}`]);
      const branchSha = branch.stdout.trim().split(/\s+/, 1)[0];
      if (SHA_PATTERN.test(branchSha)) return branchSha.toLowerCase();
      const tag = await this.run(['ls-remote', '--tags', 'origin', `refs/tags/${ref}`]);
      const tagSha = tag.stdout.trim().split(/\s+/, 1)[0];
      if (SHA_PATTERN.test(tagSha)) return tagSha.toLowerCase();
    }
    return null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const a = await this.resolveCommit(ancestor);
    const d = await this.resolveCommit(descendant);
    try {
      await this.run(['merge-base', '--is-ancestor', a, d]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
    }
  }

  async assertAncestor(ancestor: string, descendant: string): Promise<void> {
    if (!(await this.isAncestor(ancestor, descendant))) {
      throw new RepositoryError(
        'SCENARIO_BRANCH_HISTORY_BROKEN',
        '场景测试分支历史已断裂，拒绝自动同步或覆盖，请重新指定起点',
        409,
      );
    }
  }

  async checkoutTarget(target: string): Promise<string> {
    const sha = await this.resolveCommit(target);
    await this.cleanWorkspace();
    await this.run(['checkout', '--detach', '--force', sha]);
    await this.run(['reset', '--hard', sha]);
    await this.run(['clean', '-ffd']);
    return sha;
  }

  async cleanWorkspace(): Promise<void> {
    if (!(await this.isGitWorktree())) return;
    try {
      await this.run(['merge', '--abort']);
    } catch {
      // No merge is in progress, or the repository is already clean.
    }
    try {
      await this.run(['reset', '--hard']);
    } catch {
      // A repository without a checked out commit can still be cleaned below.
    }
    try {
      await this.run(['clean', '-ffd']);
    } catch {
      // The caller will receive the original Git failure; cleanup is best effort.
    }
  }

  async createScenarioBranch(branch: string, initialRef: string): Promise<string> {
    assertBranchName(branch);
    await this.fetch();
    if (await this.remoteBranchHead(branch)) {
      throw new RepositoryError(
        'SCENARIO_BRANCH_REMOTE_CHANGED',
        '场景测试分支已被其他请求创建，请重新读取状态',
        409,
      );
    }
    const source = await this.resolveRemoteRef(initialRef);
    if (!source) {
      throw new RepositoryError('TARGET_INVALID', `无法解析初始 Git ref：${initialRef}`, 400);
    }
    try {
      await this.checkoutTarget(source);
      await this.run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      const head = await this.remoteBranchHead(branch);
      if (!head)
        throw new RepositoryError('PUSH_REJECTED', '场景测试分支创建后无法读取远端 HEAD', 502);
      return head;
    } catch (error) {
      await this.cleanWorkspace();
      throw error;
    } finally {
      await this.cleanWorkspace();
    }
  }

  async mergeNoFastForward(
    branch: string,
    sourceRef: string,
    confirmed: boolean,
  ): Promise<GitMergeResult> {
    assertBranchName(branch);
    if (!confirmed) {
      throw new RepositoryError(
        'MERGE_CONFIRMATION_REQUIRED',
        '合并到场景测试分支前需要操作者确认',
        400,
      );
    }
    await this.fetch();
    const originalHead = await this.remoteBranchHead(branch);
    if (!originalHead) {
      throw new RepositoryError('SCENARIO_BRANCH_NOT_FOUND', '场景测试分支尚未创建', 409);
    }
    const sourceCommit = await this.resolveRemoteRef(sourceRef);
    if (!sourceCommit) {
      throw new RepositoryError('TARGET_INVALID', `无法解析来源 Git ref：${sourceRef}`, 400);
    }
    if (await this.isAncestor(sourceCommit, originalHead)) {
      await this.cleanWorkspace();
      return {
        originalHead,
        sourceCommit,
        mergeCommit: null,
        scenarioBranchHead: originalHead,
        alreadyIncluded: true,
      };
    }

    try {
      await this.checkoutTarget(originalHead);
      try {
        await this.run([
          '-c',
          'user.name=LuoWang Repository Service',
          '-c',
          'user.email=luowang-repository-service@localhost',
          'merge',
          '--no-ff',
          '--no-edit',
          sourceCommit,
        ]);
      } catch (error) {
        await this.cleanWorkspace();
        if (error instanceof GitCommandError) {
          throw new RepositoryError(
            'MERGE_CONFLICT',
            '来源 ref 与场景测试分支存在冲突，未自动解决',
            409,
          );
        }
        throw error;
      }
      const latestRemoteHead = await this.remoteBranchHead(branch);
      if (latestRemoteHead !== originalHead) {
        await this.cleanWorkspace();
        throw new RepositoryError(
          'SCENARIO_BRANCH_REMOTE_CHANGED',
          '合并期间远端场景测试分支发生变化，请重新尝试',
          409,
        );
      }
      const mergeCommit = (await this.run(['rev-parse', 'HEAD'])).stdout.trim();
      await this.run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      const scenarioBranchHead = await this.remoteBranchHead(branch);
      if (!scenarioBranchHead) {
        throw new RepositoryError('PUSH_REJECTED', '推送成功后无法读取场景测试分支 HEAD', 502);
      }
      return {
        originalHead,
        sourceCommit,
        mergeCommit,
        scenarioBranchHead,
        alreadyIncluded: false,
      };
    } catch (error) {
      await this.cleanWorkspace();
      if (error instanceof GitCommandError) {
        throw new RepositoryError(
          'PUSH_REJECTED',
          '场景测试分支推送被拒绝，未执行 force push',
          409,
        );
      }
      throw error;
    } finally {
      await this.cleanWorkspace();
    }
  }

  async listTree(commit: string): Promise<GitTreeEntry[]> {
    const sha = await this.resolveCommit(commit);
    const output = await this.run(['ls-tree', '-r', '-z', '--full-tree', sha, '--']);
    return output.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const [metadata, path] = entry.split('\t', 2);
        const [mode, type, objectSha] = metadata.split(' ');
        if (!path || !mode || !type || !objectSha) {
          throw new RepositoryError('GIT_COMMAND_FAILED', 'Git tree 输出格式无效', 502);
        }
        return {
          path,
          mode,
          type: type as GitTreeEntry['type'],
          sha: objectSha,
        };
      });
  }

  async readFile(commit: string, path: string): Promise<string> {
    assertRelativePath(path);
    const sha = await this.resolveCommit(commit);
    const output = await this.run(['show', `${sha}:${path}`]);
    return output.stdout;
  }

  async history(ref: string, limit = 200): Promise<GitLogEntry[]> {
    const sha = await this.resolveCommit(ref);
    const output = await this.run([
      'log',
      `--max-count=${Math.max(1, Math.min(limit, 500))}`,
      '--format=%H%x1f%aI%x1f%s%x1e',
      sha,
      '--',
    ]);
    return output.stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [commitSha, authoredAt, subject] = record.split('\x1f');
        return { sha: commitSha, authoredAt, subject };
      });
  }

  async changedPaths(base: string | null, target: string): Promise<string[]> {
    const targetSha = await this.resolveCommit(target);
    if (base === null) {
      const tree = await this.listTree(targetSha);
      return tree.map((entry) => entry.path);
    }
    const baseSha = await this.resolveCommit(base);
    const output = await this.run(['diff', '--name-only', '-z', baseSha, targetSha, '--']);
    return output.stdout.split('\0').filter(Boolean);
  }

  private async isGitWorktree(): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  private async run(
    args: string[],
    cwd = this.directory,
  ): Promise<{ stdout: string; stderr: string }> {
    const token = this.tokenProvider?.();
    let authDir: string | undefined;
    let authScript: string | undefined;
    try {
      const env = safeGitEnvironment();
      env.GIT_TERMINAL_PROMPT = '0';
      if (token) {
        authDir = await mkdtemp(
          join(process.env.TEMP ?? process.env.TMP ?? tmpdir(), 'luowang-askpass-'),
        );
        if (process.platform === 'win32') {
          const scriptFile = join(authDir, 'askpass.js');
          authScript = join(authDir, 'askpass.cmd');
          await writeFile(
            scriptFile,
            `const prompt = process.argv.slice(2).join(' ');\nprocess.stdout.write(/username/i.test(prompt) ? 'x-access-token' : ${JSON.stringify(token)});\n`,
            { mode: 0o600 },
          );
          await writeFile(authScript, `@echo off\nnode "${scriptFile}" %*\n`, { mode: 0o600 });
        } else {
          const scriptFile = join(authDir, 'askpass.js');
          authScript = join(authDir, 'askpass.sh');
          await writeFile(
            scriptFile,
            `const prompt = process.argv.slice(2).join(' ');\nprocess.stdout.write(/username/i.test(prompt) ? 'x-access-token' : ${JSON.stringify(token)});\n`,
            { mode: 0o600 },
          );
          await writeFile(authScript, `#!/bin/sh\nexec node "${scriptFile}" "$@"\n`, {
            mode: 0o700,
          });
          await chmod(authScript, 0o700);
        }
        env.GIT_ASKPASS = authScript;
        env.GIT_TERMINAL_PROMPT = '0';
      }
      const result = await execFileAsync('git', args, {
        cwd,
        env,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error: unknown) {
      const details = error as { stdout?: string; stderr?: string; code?: number | string };
      const stderr = sanitize(String(details.stderr ?? ''), token);
      const exitCode = typeof details.code === 'number' ? details.code : null;
      throw new GitCommandError(args, stderr, exitCode);
    } finally {
      if (authDir) await rm(authDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
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
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}

function sanitize(value: string, secret: string | undefined): string {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

function assertRef(ref: string): void {
  if (
    !REF_PATTERN.test(ref) ||
    [...ref].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    ref.includes('..') ||
    ref.includes('@{')
  ) {
    throw new RepositoryError('TARGET_INVALID', 'Git ref 格式无效', 400);
  }
}

function assertBranchName(branch: string): void {
  assertRef(branch);
  if (branch.startsWith('refs/') || branch.endsWith('/') || branch.includes('//')) {
    throw new RepositoryError('REPOSITORY_INVALID', '场景测试分支名无效', 400);
  }
}

function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    path.includes('\u0000')
  ) {
    throw new RepositoryError('TARGET_INVALID', 'Git 文件路径无效', 400);
  }
}
