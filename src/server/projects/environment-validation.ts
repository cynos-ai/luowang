import type Database from 'better-sqlite3';
import { createEnvironmentTimeline } from './environment-timing.js';
import type { ConfigurationStore } from '../configuration.js';
import { ConfigurationError } from '../configuration.js';
import { AppError } from '../errors.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import { createProjectRepositoryService } from '../repository/service.js';
import { GitHubClient } from '../repository/github.js';
import type { GitRepository } from '../repository/git-repository.js';
import { createRunId } from '../runs/workspace.js';
import { ControlledCommandError } from '../runs/command-runner.js';
import type { ProjectConfigurationStore } from './configuration.js';
import type { ConnectionResourceService } from './connection-resources.js';
import type { ProjectStore } from './store.js';
import { resolveProjectImageCommit } from './readiness-adapters.js';
import { resolveProjectExecutionLocation } from './execution-location.js';
import { createExecutionResourceLedger } from './resource-ledger.js';
import { readInstanceId } from './instance-id.js';
import { locationHasCapacity } from '../automation/project-queue-coordinator.js';
import { registerActiveExecutionResource } from './active-execution-resources.js';
import { reconcileExecutionResourceLedger } from './execution-resource-recovery.js';
import { createProjectTaskRuntime } from './task-runtime.js';
import { createProjectRunRuntimeEnvironmentFactory } from './run-runtime-factory.js';
import {
  assertEnvironmentIdle,
  environmentFingerprint,
  environmentState,
  preparationCredentialRevision,
} from './environment-state.js';
import {
  ENVIRONMENT_STAGES,
  type EnvironmentStage,
  type EnvironmentValidationTask,
} from '../../shared/environment-preparation.js';

/** A preparation attempt uses the Run owner without creating a Run or advancing Git progress. */
export function createEnvironmentValidationService(input: {
  database: Database.Database;
  deployment: ConfigurationStore;
  projects: ProjectStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  resources: ConnectionResourceService;
  repoRoot: string;
  reportRoot: string;
  storageRoot: string;
  generationActive?: (projectId: string) => boolean;
  loadSource?: (
    projectId: string,
    signal: AbortSignal,
  ) => Promise<{ repository: GitRepository; commit: string }>;
  runtimeFactory?: typeof createProjectRunRuntimeEnvironmentFactory;
  reconcile?: typeof reconcileExecutionResourceLedger;
}) {
  const work = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  const tasks = new Map<string, EnvironmentValidationTask>();
  const ledger = () =>
    createExecutionResourceLedger(input.database, readInstanceId(input.database));
  const fingerprint = (projectId: string) =>
    environmentFingerprint(
      input.configuration.get(projectId),
      input.resources.listProjectFiles(projectId),
      resolveProjectExecutionLocation(input.database, projectId),
      preparationCredentialRevision(input.database, projectId),
    );
  const persist = (task: EnvironmentValidationTask) =>
    environmentState<EnvironmentValidationTask>(input.database, task.projectId, 'validation').set(
      task,
    );
  const current = (projectId: string) => {
    const task =
      tasks.get(projectId) ??
      environmentState<EnvironmentValidationTask>(input.database, projectId, 'validation').get();
    if (!task) return null;
    if (task.status === 'running' && !work.has(projectId)) {
      task.status = 'cancelled';
      const step = task.steps.find((value) => value.status === 'running');
      if (step) {
        step.status = 'failed';
        step.message = '服务重启，验证中断；实际结束时间与耗时未知';
        step.durationMs = null;
        step.finishedAt = null;
      }
      task.failure = {
        stage: step?.stage ?? 'source',
        message: '服务重启，验证中断；资源由恢复流程核对',
      };
      task.finishedAt = new Date().toISOString();
      persist(task);
    }
    const released = ledger().get(task.resourceId).state === 'released';
    return {
      ...structuredClone(task),
      cleanupConfirmed: released,
      stale: task.fingerprint !== fingerprint(projectId),
    };
  };

  async function validate(
    task: EnvironmentValidationTask,
    controller: AbortController,
    runtime: ReturnType<typeof createProjectTaskRuntime>,
  ) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45 * 60_000)]);
    const unregister = registerActiveExecutionResource(task.resourceId);
    let owner:
      Awaited<ReturnType<ReturnType<typeof createProjectRunRuntimeEnvironmentFactory>>> | undefined;
    let runtimeStarted = false;
    let stage: EnvironmentStage = 'source';
    const timeline = createEnvironmentTimeline(task.steps);
    const onStage = (next: EnvironmentStage) => {
      timeline.enter(next);
      stage = next;
      persist(task);
    };
    try {
      onStage('source');
      const source = await (input.loadSource
        ? input.loadSource(task.projectId, signal)
        : (async () => {
            const service = createProjectRepositoryService(
              input.database,
              task.projectId,
              input.configuration,
              input.secrets,
              input.repoRoot,
            );
            const repository = await service.getRepository();
            await repository.fetch(signal);
            signal.throwIfAborted();
            const client = new GitHubClient({
              repositoryUrl: input.configuration.repositoryUrl(task.projectId),
              tokenProvider: () => input.secrets.project(task.projectId).get('gitToken'),
            });
            const commit = await resolveProjectImageCommit(
              task.projectId,
              input.configuration.get(task.projectId),
              client,
              async (_id, branch) => repository.remoteBranchHead(branch),
            );
            if (!commit) throw new ConfigurationError('无法确定验证使用的源码提交');
            return { repository, commit };
          })());
      signal.throwIfAborted();
      task.targetCommit = source.commit;
      persist(task);
      if (task.fingerprint !== fingerprint(task.projectId))
        throw new ConfigurationError('验证输入已变化，请重新验证');
      runtimeStarted = true;
      owner = await (input.runtimeFactory ?? createProjectRunRuntimeEnvironmentFactory)({
        database: input.database,
        task: runtime,
        secrets: input.secrets,
        storageRoot: input.storageRoot,
        preparationResourceId: task.resourceId,
        onStage,
      })({ repository: source.repository, runId: task.id, targetCommit: source.commit, signal });
      signal.throwIfAborted();
    } catch (error) {
      const message = signal.aborted
        ? controller.signal.aborted
          ? '验证已停止'
          : '环境验证超时'
        : error instanceof ConfigurationError || error instanceof ControlledCommandError
          ? error.message
          : `${ENVIRONMENT_STAGES[stage]}失败，请检查该阶段配置和执行端连接`;
      task.failure = { stage, message };
      timeline.finish('failed', message);
    } finally {
      onStage('cleanup');
      try {
        if (owner) await owner.close();
        else if (!runtimeStarted) ledger().transition(task.resourceId, 'planned', 'released');
        else {
          const resource = ledger().get(task.resourceId);
          if (resource.state !== 'unknown' && resource.state !== 'released')
            ledger().transition(
              task.resourceId,
              ['planned', 'created', 'cleanup_pending'],
              'unknown',
            );
        }
      } catch {
        task.failure ??= { stage: 'cleanup', message: '验证资源清理尚未确认，恢复流程将继续核对' };
      } finally {
        unregister();
      }
      if (
        runtimeStarted &&
        ledger().get(task.resourceId).state !== 'released' &&
        !(signal.aborted && runtime.executionLocationId.startsWith('server:'))
      ) {
        await (input.reconcile ?? reconcileExecutionResourceLedger)(input.database, input.secrets, {
          resourceIds: [task.resourceId],
        }).catch(() => undefined);
      }
      task.cleanupConfirmed = ledger().get(task.resourceId).state === 'released';
      const cleanup = task.steps.at(-1)!;
      timeline.finish(task.cleanupConfirmed ? 'passed' : 'failed');
      if (!task.cleanupConfirmed) {
        cleanup.message = '清理尚未确认，服务器名额暂不释放';
        task.failure ??= { stage: 'cleanup', message: cleanup.message };
      }
      task.status = controller.signal.aborted ? 'cancelled' : task.failure ? 'failed' : 'passed';
      task.finishedAt = new Date().toISOString();
      persist(task);
    }
  }

  return {
    current,
    start(projectId: string) {
      if (work.has(projectId) || input.generationActive?.(projectId))
        throw new ConfigurationError('项目正在准备配置，请结束后再验证');
      const project = input.projects.get(projectId);
      if (!project) throw new ConfigurationError('项目不存在');
      const config = input.configuration.get(projectId);
      if (config.runtimeMode !== 'managed')
        throw new ConfigurationError('只有罗网启动项目模式需要验证启动环境');
      const location = resolveProjectExecutionLocation(input.database, projectId);
      const id = createRunId();
      const runtime = createProjectTaskRuntime(
        {
          queueId: 0,
          projectId,
          configRevision: project.configRevision,
          githubRepositoryId: project.githubRepositoryId,
          configSnapshotJson: JSON.stringify(config),
          status: 'running',
          executionLocationId: location.id,
          executionLocationRevision: location.revision,
          managedFilesSnapshotJson: JSON.stringify(
            input.resources
              .listProjectFiles(projectId)
              .map(({ id, revision, path, serviceName }) => ({ id, revision, path, serviceName })),
          ),
        },
        input.projects,
        input.deployment,
        { repoRoot: input.repoRoot, reportRoot: input.reportRoot },
      );
      const resource = input.database.transaction(() => {
        assertEnvironmentIdle(input.database, projectId);
        const limit = Number(
          (
            input.database
              .prepare(
                "SELECT value FROM system_metadata WHERE key='runtime_max_concurrent_projects'",
              )
              .get() as { value: string } | undefined
          )?.value ?? 2,
        );
        if (!locationHasCapacity(input.database, location.id, location.revision, limit))
          throw new ConfigurationError('执行服务器当前没有可用名额或尚未验证');
        return ledger().plan({
          projectId,
          attemptId: id,
          executionLocationId: location.id,
          executionLocationRevision: location.revision,
          resourceType: 'environment-validation',
          ownerLabels: {
            'luowang.instance-id': readInstanceId(input.database),
            'luowang.project-id': projectId,
            'luowang.attempt-id': id,
          },
        });
      })();
      const task: EnvironmentValidationTask = {
        id,
        projectId,
        status: 'running',
        targetCommit: null,
        fingerprint: fingerprint(projectId),
        resourceId: resource.resourceId,
        steps: [],
        failure: null,
        cleanupConfirmed: false,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      tasks.set(projectId, task);
      persist(task);
      const controller = new AbortController();
      const completion = Promise.resolve()
        .then(() => validate(task, controller, runtime))
        .finally(() => work.delete(projectId));
      work.set(projectId, { controller, completion });
      return structuredClone(task);
    },
    stop(projectId: string, id: string) {
      const task = current(projectId);
      if (!task || task.id !== id)
        throw new AppError('ENVIRONMENT_TASK_NOT_FOUND', '环境验证任务不存在', 404);
      work.get(projectId)?.controller.abort();
      return task;
    },
    failure(projectId: string) {
      const task = current(projectId);
      return task?.failure
        ? { targetCommit: task.targetCommit, ...task.failure, stale: task.stale }
        : null;
    },
    async close() {
      for (const { controller } of work.values()) controller.abort();
      await Promise.allSettled([...work.values()].map(({ completion }) => completion));
    },
  };
}
