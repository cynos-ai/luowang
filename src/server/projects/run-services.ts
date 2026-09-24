import type Database from 'better-sqlite3';

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
import { createProjectImageStateStore } from './image-state.js';
import { createProjectRunImageStore } from './run-image.js';
import { readInstanceId } from './instance-id.js';
import type { ProjectTaskRuntime } from './task-runtime.js';

/** Assemble every Run dependency from one claimed task; never consult a selected project. */
export function createProjectRunServices(options: {
  database: Database.Database;
  task: ProjectTaskRuntime;
  secrets: ScopedSecretStore;
  repoRoot: string;
  reportRoot: string;
  storageRoot: string;
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
    reportDir: workspaceStore.root,
    repository,
    indexer,
    runStore,
  });
  const runImages = createProjectRunImageStore(database, projectId);
  const testData = createTestDataManager({
    cleanupAdapter: task.testDataCleanupUrl
      ? createHttpTestDataCleanupAdapter(task.testDataCleanupUrl, secretStore)
      : undefined,
  });
  const runs = createRunOrchestrator({
    configuration: task.configuration,
    repository,
    indexer,
    reportDir: workspaceStore.root,
    secretStore,
    oss,
    testData,
    runStore,
    recoveryStore,
    commandSessionFactory: createProjectRunCommandSessionFactory({
      projectId,
      instanceId: readInstanceId(database),
      dockerfilePath: task.executionDockerfile,
      storageRoot,
      imageState: createProjectImageStateStore(database),
      recordImage: ({ runId, targetCommit, imageId }) =>
        runImages.record({
          runId,
          targetCommit,
          dockerfilePath: task.executionDockerfile,
          imageId,
        }),
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
