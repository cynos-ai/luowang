import { existsSync } from 'node:fs';

import type Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';

import type {
  ConnectivityResult,
  RepositoryIssue,
  RepositoryStatusResponse,
  ScenarioMode,
} from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { AppConfig } from '../config.js';
import type { SecretStore } from '../security/secret-store.js';
import {
  GITHUB_CHECK_IDS,
  GitHubClient,
  isGitHubRepository,
  type GithubCheckId,
} from './github.js';
import {
  GitRepository,
  type PreparedMergeResult,
  type GitTreeEntry,
  type ReportFileName,
  type ReportPublishResult,
  type ScenarioPatchPublishResult,
} from './git-repository.js';
import { RepositoryError } from './errors.js';
import type { ScenarioPatchValidation } from './scenario-patch.js';

export interface RepositoryService {
  getStatus(): Promise<RepositoryStatusResponse>;
  prepareMergeRequest(
    sourceRef: string,
    queueId: number,
    initialization: boolean,
  ): Promise<PreparedMergeResult>;
  publishPreparedMerge(
    queueId: number,
    preparedCommit: string,
    mode: PreparedMergeResult['mode'] | null,
  ): Promise<string>;
  isPublishedTarget(commit: string): Promise<boolean>;
  readMergeRequestRef(queueId: number): Promise<string | null>;
  listMergeRequestRefs(): Promise<number[]>;
  cleanupMergeRequestRef(queueId: number): Promise<void>;
  checkoutTarget(target: string): Promise<string>;
  assertScenarioHistory(baseCommit: string, targetCommit: string): Promise<void>;
  cleanWorkspace(): Promise<void>;
  getRepository(): Promise<GitRepository>;
  getRepositoryUrl(): string;
  getScenarioBranch(): string;
  checkConnectivity(checkId: GithubCheckId): Promise<ConnectivityResult>;
  listIssues(): Promise<RepositoryIssue[]>;
  findIssuesByMarkers(markers: readonly string[]): Promise<RepositoryIssue[]>;
  createIssue(title: string, body: string): Promise<RepositoryIssue>;
  getIssueByUrl(issueUrl: string): Promise<RepositoryIssue>;
  publishRunReports(
    runId: string,
    files: Record<ReportFileName, string>,
  ): Promise<ReportPublishResult>;
  getScenarioMode?: () => ScenarioMode;
  validateScenarioPatch?: (baseCommit: string, patch: string) => Promise<ScenarioPatchValidation>;
  publishScenarioChanges?: (
    runId: string,
    patch: string,
    mode: 'direct' | 'pull-request',
    details?: ScenarioPublicationDetails,
  ) => Promise<ScenarioChangePublication>;
  listTree(commit: string): Promise<GitTreeEntry[]>;
}

export interface ScenarioPublicationDetails {
  targetCommit: string;
  reason?: string;
  blockingReasons?: readonly string[];
}

export interface ScenarioChangePublication {
  status: 'published' | 'pull_request' | 'already_published';
  commitSha: string | null;
  scenarioBranchHead: string | null;
  scenarioPrUrl: string | null;
}

export function createRepositoryService(
  database: Database.Database,
  configuration: ConfigurationStore,
  secretStore: SecretStore,
  paths: Pick<AppConfig, 'repoDir'> & { allowLocalRepository?: boolean },
): RepositoryService {
  return new DefaultRepositoryService(database, configuration, secretStore, paths);
}

class DefaultRepositoryService implements RepositoryService {
  private cachedRepository: GitRepository | undefined;
  private cachedRemoteUrl: string | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly configuration: ConfigurationStore,
    private readonly secretStore: SecretStore,
    private readonly paths: Pick<AppConfig, 'repoDir'> & { allowLocalRepository?: boolean },
  ) {}

  async getStatus(): Promise<RepositoryStatusResponse> {
    const config = this.configuration.getRepository();
    const state = this.readIndexState();
    const errors = this.readIndexErrors();
    if (config.repository.trim() === '') {
      return {
        configured: false,
        availability: 'not_configured',
        errorMessage: null,
        repository: '',
        scenarioBranch: config.scenarioBranch,
        localReady: false,
        remoteHead: null,
        indexedCommit: state?.commitSha ?? null,
        lastSyncedAt: state?.syncedAt ?? null,
        indexErrors: errors,
      };
    }

    let remoteHead: string | null = null;
    let localReady = existsSync(this.paths.repoDir);
    let availability: RepositoryStatusResponse['availability'] = 'available';
    let errorMessage: string | null = null;
    try {
      const repository = await this.getRepository();
      await repository.fetch();
      remoteHead = await repository.remoteBranchHead(config.scenarioBranch);
      localReady = true;
    } catch {
      // Status remains useful when GitHub is temporarily unavailable.
      availability = 'unavailable';
      errorMessage = '目标仓库暂时不可用；已保留上一次索引事实';
    }
    return {
      configured: true,
      availability,
      errorMessage,
      repository: config.repository,
      scenarioBranch: config.scenarioBranch,
      localReady,
      remoteHead,
      indexedCommit: state?.commitSha ?? null,
      lastSyncedAt: state?.syncedAt ?? null,
      indexErrors: errors,
    };
  }

  async prepareMergeRequest(
    sourceRef: string,
    queueId: number,
    initialization: boolean,
  ): Promise<PreparedMergeResult> {
    const config = this.requireRepositoryConfig();
    return (await this.getRepository()).prepareMergeRequest(
      config.scenarioBranch,
      sourceRef.trim(),
      queueId,
      initialization,
    );
  }

  async publishPreparedMerge(
    queueId: number,
    preparedCommit: string,
    mode: PreparedMergeResult['mode'] | null,
  ): Promise<string> {
    const config = this.requireRepositoryConfig();
    return (await this.getRepository()).publishPreparedMerge(
      config.scenarioBranch,
      queueId,
      preparedCommit,
      mode,
    );
  }

  async isPublishedTarget(commit: string): Promise<boolean> {
    const config = this.requireRepositoryConfig();
    return (await this.getRepository()).isPublishedOnBranch(config.scenarioBranch, commit);
  }

  async readMergeRequestRef(queueId: number): Promise<string | null> {
    this.requireRepositoryConfig();
    return (await this.getRepository()).readInternalRef(queueId);
  }

  async listMergeRequestRefs(): Promise<number[]> {
    this.requireRepositoryConfig();
    return (await this.getRepository()).listInternalMergeRequestIds();
  }

  async cleanupMergeRequestRef(queueId: number): Promise<void> {
    this.requireRepositoryConfig();
    await (await this.getRepository()).deleteInternalRef(queueId);
  }

  async checkoutTarget(target: string): Promise<string> {
    this.requireRepositoryConfig();
    return (await this.getRepository()).checkoutTarget(target);
  }

  async assertScenarioHistory(baseCommit: string, targetCommit: string): Promise<void> {
    this.requireRepositoryConfig();
    await (await this.getRepository()).assertAncestor(baseCommit, targetCommit);
  }

  async cleanWorkspace(): Promise<void> {
    if (this.cachedRepository) await this.cachedRepository.cleanWorkspace();
  }

  async getRepository(): Promise<GitRepository> {
    const config = this.requireRepositoryConfig();
    if (!this.cachedRepository || this.cachedRemoteUrl !== config.repository) {
      this.cachedRemoteUrl = config.repository;
      this.cachedRepository = new GitRepository({
        directory: this.paths.repoDir,
        remoteUrl: config.repository,
        tokenProvider: () => this.secretStore.get('gitToken'),
      });
    }
    return this.cachedRepository;
  }

  getScenarioBranch(): string {
    return this.configuration.getRepository().scenarioBranch;
  }

  getScenarioMode(): ScenarioMode {
    return this.configuration.getRepository().scenarioMode;
  }

  async validateScenarioPatch(baseCommit: string, patch: string): Promise<ScenarioPatchValidation> {
    this.requireRepositoryConfig();
    return (await this.getRepository()).validateScenarioPatch(baseCommit, patch);
  }

  getRepositoryUrl(): string {
    return this.configuration.getRepository().repository;
  }

  async checkConnectivity(checkId: GithubCheckId): Promise<ConnectivityResult> {
    if (!GITHUB_CHECK_IDS.includes(checkId)) {
      return {
        status: 'not_available',
        message: '对应 GitHub 检查项不存在',
        checkedAt: null,
        latencyMs: null,
      };
    }
    const config = this.configuration.getRepository();
    if (config.repository.trim() === '') {
      return emptyConnectivity('not_configured', '目标 GitHub 仓库尚未配置');
    }
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    const result = await client.check(checkId, config.scenarioBranch);
    return {
      status: result.status,
      message: result.message,
      checkedAt: new Date().toISOString(),
      latencyMs: result.latencyMs,
    };
  }

  async listIssues(): Promise<RepositoryIssue[]> {
    const config = this.requireRepositoryConfig();
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    return client.listIssues();
  }

  async findIssuesByMarkers(markers: readonly string[]): Promise<RepositoryIssue[]> {
    const config = this.requireRepositoryConfig();
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    return client.findIssuesByMarkers(markers);
  }

  async createIssue(title: string, body: string): Promise<RepositoryIssue> {
    const config = this.requireRepositoryConfig();
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    return client.createIssue(title, body);
  }

  async getIssueByUrl(issueUrl: string): Promise<RepositoryIssue> {
    const config = this.requireRepositoryConfig();
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    return client.getIssueByUrl(issueUrl);
  }

  async publishRunReports(
    runId: string,
    files: Record<ReportFileName, string>,
  ): Promise<ReportPublishResult> {
    const config = this.requireRepositoryConfig();
    return (await this.getRepository()).publishRunReports(config.scenarioBranch, runId, files);
  }

  async publishScenarioChanges(
    runId: string,
    patch: string,
    mode: 'direct' | 'pull-request',
    details: ScenarioPublicationDetails = { targetCommit: '' },
  ): Promise<ScenarioChangePublication> {
    const config = this.requireRepositoryConfig();
    const repository = await this.getRepository();
    const publication: ScenarioPatchPublishResult = await repository.publishScenarioPatch(
      config.scenarioBranch,
      runId,
      patch,
      mode,
    );
    if (mode === 'direct') {
      return {
        status: publication.status,
        commitSha: publication.commitSha,
        scenarioBranchHead: publication.scenarioBranchHead,
        scenarioPrUrl: null,
      };
    }

    if (!publication.branchName) {
      throw new RepositoryError('SCENARIO_PR_CREATE_FAILED', '场景 PR 分支创建失败', 502);
    }
    const client = new GitHubClient({
      repositoryUrl: config.repository,
      tokenProvider: () => this.secretStore.get('gitToken'),
    });
    try {
      const existing = await client.findPullRequest(publication.branchName, config.scenarioBranch);
      if (existing) {
        return {
          status: 'pull_request',
          commitSha: publication.commitSha,
          scenarioBranchHead: publication.scenarioBranchHead,
          scenarioPrUrl: existing.url,
        };
      }
      const pullRequest = await client.createPullRequest(
        `test: review scenario changes for run ${runId}`,
        scenarioPullRequestBody(runId, details),
        publication.branchName,
        config.scenarioBranch,
      );
      return {
        status: 'pull_request',
        commitSha: publication.commitSha,
        scenarioBranchHead: publication.scenarioBranchHead,
        scenarioPrUrl: pullRequest.url,
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError('SCENARIO_PR_CREATE_FAILED', '场景 PR 创建失败', 502);
    }
  }

  async listTree(commit: string): Promise<GitTreeEntry[]> {
    this.requireRepositoryConfig();
    return (await this.getRepository()).listTree(commit);
  }

  private requireRepositoryConfig() {
    const config = this.configuration.getRepository();
    if (!config.repository.trim()) {
      throw new RepositoryError('REPOSITORY_NOT_CONFIGURED', '请先配置 GitHub 目标仓库', 400);
    }
    if (!config.scenarioBranch.trim()) {
      throw new RepositoryError('REPOSITORY_INVALID', '场景测试分支不能为空', 400);
    }
    validateRepositoryUrl(config.repository, this.paths.allowLocalRepository === true);
    return config;
  }

  private readIndexState(): { commitSha: string | null; syncedAt: string | null } | undefined {
    const row = this.database
      .prepare('SELECT commit_sha, synced_at FROM repository_index_state WHERE id = 1')
      .get() as { commit_sha: string | null; synced_at: string | null } | undefined;
    return row ? { commitSha: row.commit_sha, syncedAt: row.synced_at } : undefined;
  }

  private readIndexErrors(): Array<{ path: string; message: string }> {
    return this.database
      .prepare('SELECT path, message FROM repository_index_errors ORDER BY path')
      .all()
      .map((row) => row as { path: string; message: string });
  }
}

function scenarioPullRequestBody(runId: string, details: ScenarioPublicationDetails): string {
  const reason = safeDetailsText(details.reason ?? '本次 Run 发现需要维护长期场景资产。');
  const gaps = details.blockingReasons?.map(safeDetailsText).filter(Boolean) ?? [];
  return [
    '由 LuoWang 生成的场景测试资产变更。',
    '',
    `- luowang-run:${runId}`,
    `- target_commit: ${safeDetailsText(details.targetCommit) || 'unknown'}`,
    `- 变更理由：${reason}`,
    `- 覆盖缺口：${gaps.length > 0 ? gaps.join('；') : '无'}`,
    '',
    '该 PR 只允许修改 docs/scenario-testing/scenarios/**，不替代产品 Bug Issue。',
  ].join('\n');
}

function safeDetailsText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 2_000);
}

export function validateRepositoryUrl(value: string, allowLocalRepository = false): void {
  if (value.trim() === '') return;
  if (isGitHubRepository(value)) return;
  if (allowLocalRepository && (isAbsolute(value) || value.startsWith('file://'))) return;
  throw new RepositoryError(
    'REPOSITORY_INVALID',
    '目前只支持不带凭据的 HTTPS GitHub 仓库 URL',
    400,
  );
}

function emptyConnectivity(
  status: ConnectivityResult['status'],
  message: string,
): ConnectivityResult {
  return { status, message, checkedAt: null, latencyMs: null };
}
