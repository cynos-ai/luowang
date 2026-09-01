import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { GitCommandError, RepositoryError } from './errors.js';
import {
  SCENARIO_DIRECTORY,
  ScenarioPatchError,
  validateScenarioContents,
  validateScenarioPatchText,
  type ScenarioPatchChange,
  type ScenarioPatchValidation,
} from './scenario-patch.js';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REF_PATTERN = /^[^\s~^:?*\\[\]]{1,255}$/;
const REPORT_FILE_NAMES = ['draft-report.md', 'review.md', 'report.md'] as const;

export type ReportFileName = (typeof REPORT_FILE_NAMES)[number];

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

export interface GitCommitChanges {
  sha: string;
  paths: string[];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export type PreparedMergeMode = 'existing-branch' | 'initial-create';

export interface PreparedMergeResult {
  mode: PreparedMergeMode;
  sourceCommit: string;
  originalHead: string | null;
  preparedCommit: string;
  alreadyIncluded: boolean;
}

export interface ReportPublishResult {
  status: 'published' | 'already_published';
  commitSha: string;
  scenarioBranchHead: string;
}

export type ScenarioPublicationMode = 'direct' | 'pull-request';

export interface ScenarioPatchPublishResult {
  status: 'published' | 'already_published';
  commitSha: string;
  scenarioBranchHead: string;
  branchName: string | null;
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

  async prepareMergeRequest(
    branch: string,
    sourceRef: string,
    queueId: number,
    initialization: boolean,
  ): Promise<PreparedMergeResult> {
    assertBranchName(branch);
    assertQueueId(queueId);
    await this.fetch();
    const internalRef = mergeRequestRef(queueId);
    if (await this.readInternalRef(queueId)) {
      throw new RepositoryError(
        'MERGE_REQUEST_STATE_INVALID',
        'merge 请求 internal ref 已存在',
        409,
      );
    }
    const originalHead = await this.remoteBranchHead(branch);
    const sourceCommit = await this.resolvePublishedSourceCommit(sourceRef);
    if (!originalHead) {
      if (!initialization) {
        throw new RepositoryError(
          'SCENARIO_BRANCH_NOT_FOUND',
          '场景测试分支尚未创建；首次创建必须提交 initialization merge-source 请求',
          409,
        );
      }
      await this.createInternalRef(internalRef, sourceCommit, 'initial-create');
      return {
        mode: 'initial-create',
        sourceCommit,
        originalHead: null,
        preparedCommit: sourceCommit,
        alreadyIncluded: false,
      };
    }

    if (await this.isAncestor(sourceCommit, originalHead)) {
      await this.createInternalRef(internalRef, originalHead, 'existing-branch');
      return {
        mode: 'existing-branch',
        sourceCommit,
        originalHead,
        preparedCommit: originalHead,
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
          '-m',
          `luowang merge request #${queueId}`,
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
      const preparedCommit = normalizeSha((await this.run(['rev-parse', 'HEAD'])).stdout);
      await this.createInternalRef(internalRef, preparedCommit, 'existing-branch');
      return {
        mode: 'existing-branch',
        sourceCommit,
        originalHead,
        preparedCommit,
        alreadyIncluded: false,
      };
    } finally {
      await this.cleanWorkspace();
    }
  }

  async publishPreparedMerge(
    branch: string,
    queueId: number,
    preparedCommit: string,
    mode: PreparedMergeMode | null,
  ): Promise<string> {
    assertBranchName(branch);
    assertQueueId(queueId);
    const prepared = normalizeSha(preparedCommit);
    await this.fetch();
    const remoteHead = await this.remoteBranchHead(branch);
    if (remoteHead && (await this.isAncestor(prepared, remoteHead))) return prepared;

    const internal = await this.readInternalRef(queueId);
    if (internal !== prepared) {
      throw new RepositoryError(
        'MERGE_REQUEST_STATE_INVALID',
        'prepared merge commit 与 internal ref 不一致',
        409,
      );
    }
    if (mode !== 'initial-create' && mode !== 'existing-branch') {
      throw new RepositoryError(
        'MERGE_REQUEST_STATE_INVALID',
        'prepared merge commit 缺少持久化准备模式',
        409,
      );
    }
    if (mode === 'initial-create' && remoteHead) {
      throw new RepositoryError(
        'SCENARIO_BRANCH_REMOTE_CHANGED',
        '首次创建场景测试分支时发生远端竞争，未发布 prepared commit',
        409,
      );
    }
    if (mode === 'existing-branch' && !remoteHead) {
      throw new RepositoryError(
        'SCENARIO_BRANCH_REMOTE_CHANGED',
        '准备 merge 后远端场景测试分支已被删除，未重新创建',
        409,
      );
    }

    try {
      // An empty expected object is a create-only compare-and-swap: despite Git's
      // option name, it cannot update or overwrite an existing remote ref.
      const pushArguments =
        mode === 'initial-create'
          ? [
              'push',
              `--force-with-lease=refs/heads/${branch}:`,
              'origin',
              `${prepared}:refs/heads/${branch}`,
            ]
          : ['push', 'origin', `${prepared}:refs/heads/${branch}`];
      await this.run(pushArguments);
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      await this.fetch();
      const recoveredHead = await this.remoteBranchHead(branch);
      if (recoveredHead && (await this.isAncestor(prepared, recoveredHead))) return prepared;
      throw new RepositoryError(
        'PUSH_REJECTED',
        mode === 'initial-create'
          ? '首次创建场景测试分支时发生远端竞争，未发布 prepared commit'
          : '场景测试分支推送被拒绝，未执行 force push',
        409,
      );
    }
    await this.fetch();
    const publishedHead = await this.remoteBranchHead(branch);
    if (!publishedHead || !(await this.isAncestor(prepared, publishedHead))) {
      throw new RepositoryError('PUSH_REJECTED', 'prepared commit 发布后无法在远端分支验证', 502);
    }
    return prepared;
  }

  async isPublishedOnBranch(branch: string, commit: string): Promise<boolean> {
    assertBranchName(branch);
    const normalized = normalizeSha(commit);
    await this.fetch();
    const remoteHead = await this.remoteBranchHead(branch);
    return remoteHead !== null && (await this.isAncestor(normalized, remoteHead));
  }

  async readInternalRef(queueId: number): Promise<string | null> {
    assertQueueId(queueId);
    await this.ensureClone();
    try {
      return normalizeSha(
        (await this.run(['rev-parse', '--verify', mergeRequestRef(queueId)])).stdout,
      );
    } catch (error) {
      if (error instanceof GitCommandError) return null;
      throw error;
    }
  }

  async listInternalMergeRequestIds(): Promise<number[]> {
    await this.ensureClone();
    const output = await this.run([
      'for-each-ref',
      '--format=%(refname)',
      'refs/luowang/merge-requests/',
    ]);
    return output.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^refs\/luowang\/merge-requests\/(\d+)$/)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((left, right) => left - right);
  }

  async deleteInternalRef(queueId: number): Promise<void> {
    assertQueueId(queueId);
    await this.ensureClone();
    if (!(await this.readInternalRef(queueId))) return;
    await this.run(['update-ref', '-d', mergeRequestRef(queueId)]);
  }

  async publishRunReports(
    branch: string,
    runId: string,
    files: Record<ReportFileName, string>,
  ): Promise<ReportPublishResult> {
    assertBranchName(branch);
    assertRunId(runId);
    for (const name of REPORT_FILE_NAMES) assertReportContent(name, files[name]);

    await this.fetch();
    const originalHead = await this.remoteBranchHead(branch);
    if (!originalHead) {
      throw new RepositoryError('SCENARIO_BRANCH_NOT_FOUND', '场景测试分支尚未创建', 409);
    }

    try {
      await this.checkoutTarget(originalHead);
      const paths = REPORT_FILE_NAMES.map(
        (name) => `docs/scenario-testing/reports/${runId}/${name}`,
      );
      await ensureSafeDirectory(this.directory, `docs/scenario-testing/reports/${runId}`);
      const missing: ReportFileName[] = [];
      for (const name of REPORT_FILE_NAMES) {
        const path = `docs/scenario-testing/reports/${runId}/${name}`;
        const localPath = join(this.directory, path);
        let existing: string | undefined;
        try {
          const info = await lstat(localPath);
          if (info.isSymbolicLink() || !info.isFile()) {
            throw new RepositoryError(
              'REPORT_CONFLICT',
              `报告路径不是普通文件，拒绝覆盖：${path}`,
              409,
            );
          }
          existing = (await this.run(['show', `${originalHead}:${path}`])).stdout;
        } catch (error) {
          if (error instanceof RepositoryError) throw error;
          if (
            !(error instanceof GitCommandError) &&
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw error;
          }
        }
        if (existing !== undefined && existing !== files[name]) {
          throw new RepositoryError(
            'REPORT_CONFLICT',
            `报告文件已存在且内容不同，拒绝覆盖：${path}`,
            409,
          );
        }
        if (existing === undefined) missing.push(name);
      }

      if (missing.length === 0) {
        return {
          status: 'already_published',
          commitSha: originalHead,
          scenarioBranchHead: originalHead,
        };
      }

      for (const name of missing) {
        const path = `docs/scenario-testing/reports/${runId}/${name}`;
        await mkdir(dirname(join(this.directory, path)), { recursive: true });
        await writeFile(join(this.directory, path), files[name], {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      await this.run(['add', '--', ...paths]);
      const staged = (await this.run(['diff', '--cached', '--name-only', '-z', '--'])).stdout
        .split('\0')
        .filter(Boolean);
      const expected = new Set(
        missing.map((name) => `docs/scenario-testing/reports/${runId}/${name}`),
      );
      if (staged.length !== expected.size || staged.some((path) => !expected.has(path))) {
        throw new RepositoryError('REPORT_CONFLICT', '报告发布超出当前 Run 的文件 allowlist', 409);
      }
      await this.run([
        '-c',
        'user.name=LuoWang Report Archiver',
        '-c',
        'user.email=luowang-report-archiver@localhost',
        'commit',
        '-m',
        `test: archive run ${runId}`,
      ]);

      // Re-read the remote head after the local commit. A normal push is
      // deliberately used below; a concurrent update must never be replaced.
      await this.fetch();
      const latestRemoteHead = await this.remoteBranchHead(branch);
      if (latestRemoteHead !== originalHead) {
        throw new RepositoryError(
          'REPORT_PUBLISH_CONFLICT',
          '报告发布期间远端场景测试分支发生变化，请重试',
          409,
        );
      }
      try {
        await this.run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      } catch (error) {
        if (error instanceof GitCommandError) {
          throw new RepositoryError(
            'REPORT_PUBLISH_CONFLICT',
            '报告发布被远端并发更新拒绝，未执行 force push',
            409,
          );
        }
        throw error;
      }
      const scenarioBranchHead = await this.remoteBranchHead(branch);
      if (!scenarioBranchHead) {
        throw new RepositoryError('PUSH_REJECTED', '报告提交后无法读取远端场景测试分支 HEAD', 502);
      }
      const commitSha = (await this.run(['rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
      return { status: 'published', commitSha, scenarioBranchHead };
    } finally {
      await this.cleanWorkspace();
    }
  }

  async validateScenarioPatch(baseCommit: string, patch: string): Promise<ScenarioPatchValidation> {
    const baseSha = await this.resolveCommit(baseCommit);
    try {
      await this.checkoutTarget(baseSha);
      return await this.materializeScenarioPatch(baseSha, patch);
    } finally {
      await this.cleanWorkspace();
    }
  }

  /** Apply a validated scenario patch to the exclusive Run worktree. */
  async applyScenarioPatch(baseCommit: string, patch: string): Promise<ScenarioPatchValidation> {
    const baseSha = await this.resolveCommit(baseCommit);
    await this.checkoutTarget(baseSha);
    try {
      return await this.materializeScenarioPatch(baseSha, patch);
    } catch (error) {
      await this.cleanWorkspace();
      throw error;
    }
  }

  async listWorkingScenarioFiles(): Promise<string[]> {
    const files = await this.readWorkingScenarioFiles();
    return [...files.keys()].sort();
  }

  async readWorkingScenarioFile(path: string): Promise<string> {
    assertRelativePath(path);
    if (!path.startsWith(SCENARIO_DIRECTORY) || !path.endsWith('.md')) {
      throw new RepositoryError('TARGET_INVALID', '只能读取场景目录中的 Markdown 文件', 400);
    }
    const localPath = join(this.directory, path);
    try {
      const info = await lstat(localPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RepositoryError('SCENARIO_PATCH_INVALID', `场景文件不是普通文件：${path}`, 422);
      }
      return await readFile(localPath, 'utf8');
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RepositoryError('TARGET_INVALID', `场景文件不存在：${path}`, 404);
      }
      throw error;
    }
  }

  async publishScenarioPatch(
    branch: string,
    runId: string,
    patch: string,
    mode: ScenarioPublicationMode,
  ): Promise<ScenarioPatchPublishResult> {
    assertBranchName(branch);
    assertRunId(runId);
    const metadata = validateScenarioPatchText(patch);
    const branchName = mode === 'pull-request' ? `luowang/scenario/${runId}` : null;
    if (branchName) assertBranchName(branchName);

    await this.fetch();
    const originalHead = await this.remoteBranchHead(branch);
    if (!originalHead) {
      throw new RepositoryError('SCENARIO_BRANCH_NOT_FOUND', '场景测试分支尚未创建', 409);
    }

    if (branchName) {
      const existingBranch = await this.remoteBranchHead(branchName);
      if (existingBranch) {
        return {
          status: 'already_published',
          commitSha: existingBranch,
          scenarioBranchHead: originalHead,
          branchName,
        };
      }
    }

    try {
      await this.checkoutTarget(originalHead);
      if (mode === 'direct' && (await this.canApplyPatch(patch, true))) {
        return {
          status: 'already_published',
          commitSha: originalHead,
          scenarioBranchHead: originalHead,
          branchName: null,
        };
      }
      const applied = await this.materializeScenarioPatch(originalHead, patch);
      // Keep the pure metadata and the resulting worktree in lockstep. This
      // also makes it impossible for a future caller to stage an unrelated
      // file accidentally.
      if (applied.changedPaths.join('\u0000') !== metadata.changedPaths.join('\u0000')) {
        throw new ScenarioPatchError('patch 解析结果不一致，拒绝发布');
      }
      await this.stageScenarioPatch(applied.changes);
      await this.run([
        '-c',
        'user.name=LuoWang Scenario Archiver',
        '-c',
        'user.email=luowang-scenario-archiver@localhost',
        'commit',
        '-m',
        `test: update scenarios for run ${runId}`,
      ]);
      const commitSha = (await this.run(['rev-parse', 'HEAD'])).stdout.trim().toLowerCase();

      await this.fetch();
      if (mode === 'direct') {
        const latestRemoteHead = await this.remoteBranchHead(branch);
        if (latestRemoteHead !== originalHead) {
          throw new RepositoryError(
            'SCENARIO_PUBLISH_CONFLICT',
            '场景变更发布期间远端分支发生变化，请重试',
            409,
          );
        }
        await this.pushScenarioCommit(branch);
        const scenarioBranchHead = await this.remoteBranchHead(branch);
        if (!scenarioBranchHead) {
          throw new RepositoryError('PUSH_REJECTED', '场景变更提交后无法读取远端 HEAD', 502);
        }
        return { status: 'published', commitSha, scenarioBranchHead, branchName: null };
      }

      try {
        await this.run(['push', 'origin', `HEAD:refs/heads/${branchName}`]);
      } catch (error) {
        if (error instanceof GitCommandError) {
          throw new RepositoryError(
            'SCENARIO_PUBLISH_CONFLICT',
            '场景 PR 分支已被远端并发创建，未执行 force push',
            409,
          );
        }
        throw error;
      }
      return {
        status: 'published',
        commitSha,
        scenarioBranchHead: originalHead,
        branchName,
      };
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

  private async materializeScenarioPatch(
    baseCommit: string,
    patch: string,
  ): Promise<ScenarioPatchValidation> {
    const metadata = validateScenarioPatchText(patch);
    const baseFiles = await this.readScenarioFilesAtCommit(baseCommit);
    const patchDirectory = await mkdtemp(join(tmpdir(), 'luowang-scenario-patch-'));
    const patchPath = join(patchDirectory, 'changes.patch');
    try {
      await writeFile(patchPath, patch, { encoding: 'utf8', mode: 0o600 });
      try {
        await this.run(['apply', '--check', '--recount', '--whitespace=nowarn', patchPath]);
        await this.run(['apply', '--recount', '--whitespace=nowarn', patchPath]);
      } catch (error) {
        if (error instanceof GitCommandError) {
          throw new ScenarioPatchError('patch 无法干净地应用到固定 target，未发布任何部分变更');
        }
        throw error;
      }
      const files = await this.readWorkingScenarioFiles();
      validateScenarioContents(files, baseFiles, metadata.changes);
      return metadata;
    } finally {
      await rm(patchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async canApplyPatch(patch: string, reverse: boolean): Promise<boolean> {
    const patchDirectory = await mkdtemp(join(tmpdir(), 'luowang-scenario-patch-check-'));
    const patchPath = join(patchDirectory, 'changes.patch');
    try {
      await writeFile(patchPath, patch, { encoding: 'utf8', mode: 0o600 });
      try {
        await this.run([
          'apply',
          '--check',
          '--recount',
          '--whitespace=nowarn',
          ...(reverse ? ['--reverse'] : []),
          patchPath,
        ]);
        return true;
      } catch (error) {
        if (error instanceof GitCommandError) return false;
        throw error;
      }
    } finally {
      await rm(patchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async stageScenarioPatch(changes: readonly ScenarioPatchChange[]): Promise<void> {
    const expected = new Set(
      changes
        .flatMap((change) => [change.oldPath, change.newPath])
        .filter((path): path is string => path !== null),
    );
    await this.run(['add', '-A', '--', SCENARIO_DIRECTORY.slice(0, -1)]);
    const staged = stagedPaths(
      (await this.run(['diff', '--cached', '--name-status', '--find-renames', '-z', '--'])).stdout,
    );
    if (
      staged.length !== expected.size ||
      staged.some((path) => !expected.has(path)) ||
      [...expected].some((path) => !staged.includes(path))
    ) {
      throw new ScenarioPatchError('场景 patch 试图提交 allowlist 之外的文件');
    }
  }

  private async pushScenarioCommit(branch: string): Promise<void> {
    try {
      await this.run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new RepositoryError(
          'SCENARIO_PUBLISH_CONFLICT',
          '场景变更发布被远端并发更新拒绝，未执行 force push',
          409,
        );
      }
      throw error;
    }
  }

  private async readScenarioFilesAtCommit(commit: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const entry of await this.listTree(commit)) {
      if (!entry.path.startsWith(SCENARIO_DIRECTORY)) continue;
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw new ScenarioPatchError(`场景文件必须是普通 Markdown 文件：${entry.path}`);
      }
      if (!entry.path.endsWith('.md')) continue;
      files.set(entry.path, await this.readFile(commit, entry.path));
    }
    validateScenarioContents(files);
    return files;
  }

  private async readWorkingScenarioFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const root = join(this.directory, SCENARIO_DIRECTORY);
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const relativePath = `${prefix}${entry.name}`;
        const localPath = join(directory, entry.name);
        const info = await lstat(localPath);
        if (info.isSymbolicLink()) {
          throw new ScenarioPatchError(`场景目录不允许符号链接：${relativePath}`);
        }
        if (info.isDirectory()) {
          await walk(localPath, `${relativePath}/`);
          continue;
        }
        if (!info.isFile()) continue;
        if (!relativePath.endsWith('.md')) continue;
        const path = `${SCENARIO_DIRECTORY}${relativePath}`;
        files.set(path, await readFile(localPath, 'utf8'));
      }
    };
    await walk(root, '');
    return files;
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

  async commitsBetween(base: string, target: string): Promise<GitCommitChanges[]> {
    const baseSha = await this.resolveCommit(base);
    const targetSha = await this.resolveCommit(target);
    await this.assertAncestor(baseSha, targetSha);
    const commits = (await this.run(['rev-list', '--reverse', `${baseSha}..${targetSha}`])).stdout
      .split(/\r?\n/)
      .map((sha) => sha.trim())
      .filter((sha) => SHA_PATTERN.test(sha));
    const changes: GitCommitChanges[] = [];
    for (const sha of commits) {
      const output = await this.run([
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        sha,
        '--',
      ]);
      changes.push({ sha: sha.toLowerCase(), paths: output.stdout.split('\0').filter(Boolean) });
    }
    return changes;
  }

  private async resolvePublishedSourceCommit(sourceRef: string): Promise<string> {
    assertRef(sourceRef);
    if (sourceRef.startsWith('refs/luowang/') || sourceRef.startsWith('refs/remotes/')) {
      throw new RepositoryError('TARGET_INVALID', '无法解析或验证远端来源 Git ref', 400);
    }

    if (SHA_PATTERN.test(sourceRef)) {
      let commit: string;
      try {
        commit = await this.resolveCommit(sourceRef);
      } catch {
        throw new RepositoryError('TARGET_INVALID', '无法解析或验证远端来源 Git ref', 400);
      }
      const containing = await this.run([
        'for-each-ref',
        '--contains',
        commit,
        '--format=%(refname)',
        'refs/remotes/origin/',
      ]);
      const onRemoteBranch = containing.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some(
          (ref) => ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD',
        );
      const remoteTags = await this.run(['ls-remote', '--tags', 'origin']);
      const isAdvertisedTagCommit = remoteTags.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/, 2)[0]?.toLowerCase())
        .some((sha) => sha === commit);
      if (!onRemoteBranch && !isAdvertisedTagCommit) {
        throw new RepositoryError('TARGET_INVALID', '无法解析或验证远端来源 Git ref', 400);
      }
      return commit;
    }

    const candidates: Array<{
      localRef: string;
      remoteKind: 'heads' | 'tags';
      remoteRef: string;
    }> = [];
    if (sourceRef.startsWith('refs/heads/')) {
      candidates.push({
        localRef: `refs/remotes/origin/${sourceRef.slice('refs/heads/'.length)}`,
        remoteKind: 'heads',
        remoteRef: sourceRef,
      });
    } else if (sourceRef.startsWith('refs/tags/')) {
      candidates.push({ localRef: sourceRef, remoteKind: 'tags', remoteRef: sourceRef });
    } else if (!sourceRef.startsWith('refs/')) {
      candidates.push(
        {
          localRef: `refs/remotes/origin/${sourceRef}`,
          remoteKind: 'heads',
          remoteRef: `refs/heads/${sourceRef}`,
        },
        {
          localRef: `refs/tags/${sourceRef}`,
          remoteKind: 'tags',
          remoteRef: `refs/tags/${sourceRef}`,
        },
      );
    }
    for (const candidate of candidates) {
      try {
        const advertised = await this.run([
          'ls-remote',
          `--${candidate.remoteKind}`,
          'origin',
          candidate.remoteRef,
        ]);
        const advertisedObject = normalizeSha(advertised.stdout.trim().split(/\s+/, 1)[0] ?? '');
        const localObject = normalizeSha(
          (await this.run(['rev-parse', '--verify', '--end-of-options', candidate.localRef]))
            .stdout,
        );
        if (advertisedObject !== localObject) continue;
        return normalizeSha(
          (
            await this.run([
              'rev-parse',
              '--verify',
              '--end-of-options',
              `${candidate.localRef}^{commit}`,
            ])
          ).stdout,
        );
      } catch {
        // Try the next explicitly allowed and currently advertised remote namespace.
      }
    }
    throw new RepositoryError('TARGET_INVALID', '无法解析或验证远端来源 Git ref', 400);
  }

  private async createInternalRef(
    ref: string,
    commit: string,
    mode: PreparedMergeMode,
  ): Promise<void> {
    await this.run([
      'update-ref',
      '--create-reflog',
      '-m',
      `luowang-${mode}`,
      ref,
      normalizeSha(commit),
      '0000000000000000000000000000000000000000',
    ]);
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

function normalizeSha(value: string): string {
  const normalized = value.trim().split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
  if (!SHA_PATTERN.test(normalized)) {
    throw new RepositoryError('TARGET_INVALID', 'Git commit SHA 格式无效', 400);
  }
  return normalized;
}

function mergeRequestRef(queueId: number): string {
  assertQueueId(queueId);
  return `refs/luowang/merge-requests/${queueId}`;
}

function assertQueueId(queueId: number): void {
  if (!Number.isSafeInteger(queueId) || queueId <= 0) {
    throw new RepositoryError('TARGET_INVALID', 'merge 请求队列 ID 无效', 400);
  }
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

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new RepositoryError('TARGET_INVALID', 'Run ID 格式无效', 400);
  }
}

function assertReportContent(name: ReportFileName, content: string): void {
  if (typeof content !== 'string' || content.trim() === '' || content.includes('\u0000')) {
    throw new RepositoryError('REPORT_CONFLICT', `报告文件不能为空：${name}`, 400);
  }
}

function stagedPaths(output: string): string[] {
  const tokens = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      const path = tokens[index++];
      if (path) paths.push(path);
    }
  }
  return paths;
}

async function ensureSafeDirectory(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new RepositoryError(
          'REPORT_CONFLICT',
          `报告目录不是普通目录，拒绝写入：${relativePath}`,
          409,
        );
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}
