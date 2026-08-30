import type { ConfigurationStore } from '../configuration.js';
import type { RepositoryService } from '../repository/service.js';
import type { RunStore } from '../runs/store.js';
import type { AutomationStateStore } from './state.js';
import type { TestRequestInput, TestRequestRecord } from './queue.js';

export interface GitPollerSubmitter {
  submitTestRequest(input: TestRequestInput): Promise<{ queue: TestRequestRecord }>;
}

export type GitPollTrigger = 'git' | 'schedule';

export interface GitPollResult {
  status: 'queued' | 'no_change' | 'ignored' | 'disabled' | 'not_configured' | 'failed';
  trigger: GitPollTrigger;
  scenarioBranch: string;
  currentHead: string | null;
  baselineCommit: string | null;
  includedCommits: string[];
  queue: TestRequestRecord | null;
  message: string;
}

export interface GitPoller {
  poll(trigger?: GitPollTrigger): Promise<GitPollResult>;
  reset(): void;
}

export interface GitPollerOptions {
  configuration: ConfigurationStore;
  repository: RepositoryService;
  submitter: GitPollerSubmitter;
  state: AutomationStateStore;
  runStore?: RunStore;
}

const LAST_SEEN_KEY = 'git-poller.last-seen-commit';
const LAST_REPOSITORY_KEY = 'git-poller.repository';
const LAST_BRANCH_KEY = 'git-poller.branch';

export function createGitPoller(options: GitPollerOptions): GitPoller {
  return new DefaultGitPoller(options);
}

export const createRepositoryPoller = createGitPoller;

class DefaultGitPoller implements GitPoller {
  private polling = false;

  constructor(private readonly options: GitPollerOptions) {}

  async poll(trigger: GitPollTrigger = 'git'): Promise<GitPollResult> {
    if (this.polling) {
      return {
        status: 'no_change',
        trigger,
        scenarioBranch: this.options.repository.getScenarioBranch(),
        currentHead: null,
        baselineCommit: null,
        includedCommits: [],
        queue: null,
        message: 'Git Poll 已在执行中，本次跳过',
      };
    }
    this.polling = true;
    try {
      return await this.pollInternal(trigger);
    } finally {
      this.polling = false;
    }
  }

  reset(): void {
    this.options.state.delete(LAST_SEEN_KEY);
    this.options.state.delete(LAST_REPOSITORY_KEY);
    this.options.state.delete(LAST_BRANCH_KEY);
  }

  private async pollInternal(trigger: GitPollTrigger): Promise<GitPollResult> {
    const config = this.options.configuration.getRepository();
    const scenarioBranch = config.scenarioBranch.trim() || 'scenario-testing';
    if (trigger === 'git' && !config.triggerOnCommit) {
      return this.empty('disabled', trigger, scenarioBranch, 'Git commit 自动触发未启用');
    }
    if (!config.repository.trim()) {
      return this.empty('not_configured', trigger, scenarioBranch, '目标 GitHub 仓库尚未配置');
    }

    let currentHead: string | null = null;
    try {
      const repository = await this.options.repository.getRepository();
      await repository.fetch();
      currentHead = await repository.remoteBranchHead(scenarioBranch);
      if (!currentHead) {
        return this.empty('failed', trigger, scenarioBranch, '场景测试分支不存在');
      }

      const storedRepository = this.options.state.get(LAST_REPOSITORY_KEY);
      const storedBranch = this.options.state.get(LAST_BRANCH_KEY);
      const repositoryChanged = storedRepository !== null && storedRepository !== config.repository;
      const branchChanged = storedBranch !== null && storedBranch !== scenarioBranch;
      if (repositoryChanged || branchChanged) {
        this.options.state.set(LAST_REPOSITORY_KEY, config.repository);
        this.options.state.set(LAST_BRANCH_KEY, scenarioBranch);
        this.options.state.set(LAST_SEEN_KEY, currentHead);
        return {
          status: 'no_change',
          trigger,
          scenarioBranch,
          currentHead,
          baselineCommit: null,
          includedCommits: [],
          queue: null,
          message: '已记录当前场景测试分支 HEAD，等待后续变化',
        };
      }

      const lastSeen = this.options.state.get(LAST_SEEN_KEY);
      const progress = this.options.runStore?.getLastCompletedTarget() ?? null;
      const baselineCommit = lastSeen ?? progress;
      if (!baselineCommit) {
        this.options.state.set(LAST_REPOSITORY_KEY, config.repository);
        this.options.state.set(LAST_BRANCH_KEY, scenarioBranch);
        this.options.state.set(LAST_SEEN_KEY, currentHead);
        return {
          status: 'no_change',
          trigger,
          scenarioBranch,
          currentHead,
          baselineCommit: null,
          includedCommits: [],
          queue: null,
          message: '首次观察场景测试分支，当前提交作为基线等待后续变化',
        };
      }
      if (baselineCommit === currentHead) {
        this.options.state.set(LAST_REPOSITORY_KEY, config.repository);
        this.options.state.set(LAST_BRANCH_KEY, scenarioBranch);
        this.options.state.set(LAST_SEEN_KEY, currentHead);
        return {
          status: 'no_change',
          trigger,
          scenarioBranch,
          currentHead,
          baselineCommit,
          includedCommits: [],
          queue: null,
          message: '场景测试分支没有新提交',
        };
      }

      const commits = await repository.commitsBetween(baselineCommit, currentHead);
      const includedCommits = commits
        .filter(({ paths }) => hasTestableChanges(paths))
        .map(({ sha }) => sha);
      if (includedCommits.length === 0) {
        this.options.state.set(LAST_REPOSITORY_KEY, config.repository);
        this.options.state.set(LAST_BRANCH_KEY, scenarioBranch);
        this.options.state.set(LAST_SEEN_KEY, currentHead);
        return {
          status: 'ignored',
          trigger,
          scenarioBranch,
          currentHead,
          baselineCommit,
          includedCommits: [],
          queue: null,
          message: '新提交只修改场景或报告目录，未创建自动测试请求',
        };
      }

      const submission = await this.options.submitter.submitTestRequest({
        trigger,
        request: `${trigger === 'git' ? 'Git Poll' : 'Cron'} 检测到场景测试分支有待测试提交：${includedCommits.join(', ')}`,
        targetRef: currentHead,
      });
      this.options.state.set(LAST_REPOSITORY_KEY, config.repository);
      this.options.state.set(LAST_BRANCH_KEY, scenarioBranch);
      this.options.state.set(LAST_SEEN_KEY, currentHead);
      return {
        status: 'queued',
        trigger,
        scenarioBranch,
        currentHead,
        baselineCommit,
        includedCommits,
        queue: submission.queue,
        message: '已将最新可测试提交加入持久队列',
      };
    } catch (error) {
      return {
        status: 'failed',
        trigger,
        scenarioBranch,
        currentHead,
        baselineCommit: this.options.state.get(LAST_SEEN_KEY),
        includedCommits: [],
        queue: null,
        message: safeMessage(error),
      };
    }
  }

  private empty(
    status: GitPollResult['status'],
    trigger: GitPollTrigger,
    scenarioBranch: string,
    message: string,
  ): GitPollResult {
    return {
      status,
      trigger,
      scenarioBranch,
      currentHead: null,
      baselineCommit: null,
      includedCommits: [],
      queue: null,
      message,
    };
  }
}

export function isTestAssetPath(path: string): boolean {
  return (
    path.startsWith('docs/scenario-testing/scenarios/') ||
    path.startsWith('docs/scenario-testing/reports/')
  );
}

export function hasTestableChanges(paths: readonly string[]): boolean {
  return paths.length === 0 || paths.some((path) => !isTestAssetPath(path));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Git Poll 失败';
}
