import { join } from 'node:path';

import type { ConfigurationStore } from '../configuration.js';
import { mergeRepositoryConfiguration, normalizeRepository } from '../configuration.js';
import type { TestRequestRecord } from '../automation/queue.js';
import type { HarnessConfig } from '../../shared/types.js';
import { normalizeExecutionDockerfile, normalizeTestDataCleanupUrl } from './configuration.js';
import type { ProjectStore } from './store.js';

const SNAPSHOT_FIELDS = new Set([
  'language',
  'executionDockerfile',
  'scenarioBranch',
  'scenarioMode',
  'scenarioLabels',
  'pollIntervalSeconds',
  'cron',
  'triggerOnCommit',
  'environmentDescription',
  'baseUrl',
  'externalDatabase',
  'testDataCleanupUrl',
]);

export interface ProjectTaskRuntime {
  projectId: string;
  configRevision: number;
  executionDockerfile: string;
  testDataCleanupUrl: string;
  configuration: ConfigurationStore;
}

/** Freeze the non-Secret runtime input from an already claimed queue request. */
export function createProjectTaskRuntime(
  task: Pick<
    TestRequestRecord,
    'projectId' | 'configRevision' | 'githubRepositoryId' | 'configSnapshotJson' | 'status'
  >,
  projects: ProjectStore,
  deployment: ConfigurationStore,
  paths: { repoRoot: string; reportRoot: string },
  purpose: 'run' | 'archive-retry' = 'run',
): ProjectTaskRuntime {
  if (
    task.status !== 'running' &&
    task.status !== 'waiting_archive' &&
    !(purpose === 'archive-retry' && task.status === 'completed')
  ) {
    throw new Error('任务尚未认领');
  }
  const project = task.projectId ? projects.get(task.projectId) : null;
  if (
    !project ||
    task.githubRepositoryId !== project.githubRepositoryId ||
    !Number.isSafeInteger(task.configRevision) ||
    (task.configRevision ?? 0) < 1
  ) {
    throw new Error('任务项目身份无效');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(task.configSnapshotJson ?? 'null') as unknown;
  } catch {
    throw new Error('任务配置快照无法解析');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('任务配置快照无效');
  }
  const snapshot = parsed as Record<string, unknown>;
  if (Object.keys(snapshot).some((key) => !SNAPSHOT_FIELDS.has(key))) {
    throw new Error('任务配置快照包含未知字段');
  }
  if (typeof snapshot.language !== 'string' || snapshot.language.length > 4096) {
    throw new Error('任务语言配置无效');
  }
  const executionDockerfile = normalizeExecutionDockerfile(snapshot.executionDockerfile);
  const testDataCleanupUrl = normalizeTestDataCleanupUrl(snapshot.testDataCleanupUrl);
  const repositoryUrl = `https://github.com/${project.repositoryOwner}/${project.repositoryName}`;
  const {
    language: _language,
    executionDockerfile: _dockerfile,
    testDataCleanupUrl: _cleanupUrl,
    ...repositoryFields
  } = snapshot;
  void _language;
  void _dockerfile;
  void _cleanupUrl;
  const repository = mergeRepositoryConfiguration(
    normalizeRepository({ repository: repositoryUrl }),
    repositoryFields,
  );
  const shared: HarnessConfig = deployment.getHarness();
  const harness: HarnessConfig = {
    ...shared,
    language: snapshot.language,
    local: {
      ...shared.local,
      repoDir: join(paths.repoRoot, 'projects', project.projectId, 'repo'),
      reportDir: join(paths.reportRoot, 'projects', project.projectId),
    },
  };
  const readonly = () => {
    throw new Error('任务运行时配置只读');
  };
  return {
    projectId: project.projectId,
    configRevision: task.configRevision!,
    executionDockerfile,
    testDataCleanupUrl,
    configuration: {
      getHarness: () => structuredClone(harness),
      getRepository: () => structuredClone(repository),
      updateHarness: readonly,
      updateRepository: readonly,
    },
  };
}
