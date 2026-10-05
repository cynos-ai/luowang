import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import { createProjectRunRecoveryStore } from '../automation/recovery.js';
import { createProjectRepositoryIndexer } from '../repository/indexer.js';
import { createProjectTaskRepositoryService } from '../repository/service.js';
import { createRunOrchestrator } from '../runs/orchestrator.js';
import { createRunArchiver } from '../runs/archiver.js';
import { createProjectRunStore } from '../runs/store.js';
import { createHttpTestDataCleanupAdapter } from '../runs/http-test-data-cleanup.js';
import { createTestDataManager } from '../runs/test-data.js';
import { createProjectRunWorkspaceStore } from '../runs/workspace.js';
import { createProjectRuntimeSecretStore } from './runtime-access.js';
import { createProjectOssAdapter } from '../storage/oss.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import { createProjectRunCommandSessionFactory } from './command-session.js';
import { createLocationImageStateStore } from './execution-image-cache.js';
import { createProjectRunImageStore } from './run-image.js';
import { readInstanceId } from './instance-id.js';
import type { ProjectTaskRuntime } from './task-runtime.js';
import { checkEnvironmentAccess } from '../runs/capabilities.js';
import { createProjectRunRuntimeEnvironmentFactory } from './run-runtime-factory.js';
import { createRemoteProjectRunCommandSessionFactory } from './remote-command-session.js';
import { createAttachedProjectCommandSession, type DockerRuntime } from './execution-container.js';

/** Assemble every Run dependency from one claimed task; never consult a selected project. */
export function createProjectRunServices(options: {
  database: Database.Database;
  task: ProjectTaskRuntime;
  secrets: ScopedSecretStore;
  repoRoot: string;
  reportRoot: string;
  storageRoot: string;
  logger?: Logger;
}) {
  const { database, task, secrets, repoRoot, reportRoot, storageRoot } = options;
  const projectId = task.projectId;
  const secretStore = createProjectRuntimeSecretStore(projectId, secrets);
  const repository = createProjectTaskRepositoryService(
    database,
    projectId,
    task.configuration,
    secretStore,
    repoRoot,
  );
  const indexer = createProjectRepositoryIndexer(database, repository, projectId);
  const runStore = createProjectRunStore(database, projectId);
  const recoveryStore = createProjectRunRecoveryStore(database, projectId);
  const workspaceStore = createProjectRunWorkspaceStore(database, reportRoot, projectId);
  const oss = createProjectOssAdapter(database, projectId, task.configuration, secrets);
  const archiver = createRunArchiver({
    database,
    workspaceStore,
    reportDir: workspaceStore.root,
    repository,
    indexer,
    runStore,
    logger: options.logger,
  });
  const runImages = createProjectRunImageStore(database, projectId);
  const testData = createTestDataManager({
    cleanupAdapter: task.testDataCleanupUrl
      ? createHttpTestDataCleanupAdapter(task.testDataCleanupUrl, secretStore)
      : undefined,
  });
  const managedCommandTargets = new Map<
    string,
    { docker: DockerRuntime; containerId: string; sourceRoot: string; workingDirectory: string }
  >();
  const fallbackCommandSessionFactory = task.executionLocationId.startsWith('server:')
    ? createRemoteProjectRunCommandSessionFactory({ database, task, secrets, storageRoot })
    : createProjectRunCommandSessionFactory({
        projectId,
        instanceId: readInstanceId(database),
        dockerfilePath: task.executionDockerfile,
        storageRoot,
        imageState: createLocationImageStateStore(database, {
          executionLocationId: task.executionLocationId,
          executionLocationRevision: task.executionLocationRevision,
          platform: `${process.platform}/${process.arch}`,
        }),
        logger: options.logger,
        recordImage: ({ runId, targetCommit, imageId }) =>
          runImages.record({
            runId,
            targetCommit,
            dockerfilePath: task.executionDockerfile,
            imageId,
          }),
      });
  const runs = createRunOrchestrator({
    browserAllowedOrigins: task.browserAllowedOrigins,
    capabilityConfiguration: { projectId, revision: task.configRevision },
    checkEnvironment: (baseUrl, signal) => checkEnvironmentAccess(baseUrl, fetch, signal),
    configuration: task.configuration,
    repository,
    indexer,
    reportDir: workspaceStore.root,
    secretStore,
    oss,
    testData,
    testDataCleanupUrl: task.testDataCleanupUrl,
    runStore,
    recoveryStore,
    logger: options.logger,
    commandSessionFactory: async (context) => {
      const target = managedCommandTargets.get(context.runId);
      return target
        ? createAttachedProjectCommandSession(
            {
              projectId,
              runId: context.runId,
              targetCommit: context.targetCommit,
              repositoryDirectory: context.repository.directory,
              containerId: target.containerId,
              sourceRoot: target.sourceRoot,
              workingDirectory: target.workingDirectory,
            },
            target.docker,
          )
        : fallbackCommandSessionFactory(context);
    },
    runtimeEnvironmentFactory: createProjectRunRuntimeEnvironmentFactory({
      database,
      task,
      secrets,
      storageRoot,
      setManagedCommandTarget: (runId, target) => {
        if (target) managedCommandTargets.set(runId, target);
        else managedCommandTargets.delete(runId);
      },
    }),
  });
  return {
    runs,
    repository,
    indexer,
    runStore,
    recoveryStore,
    workspaceStore,
    oss,
    testData,
    archiver,
    runImages,
  };
}
