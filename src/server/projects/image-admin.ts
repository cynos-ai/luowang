import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

import type Database from 'better-sqlite3';

import {
  GitHubApiError,
  GitHubClient,
  describeGitHubRepositoryFailure,
} from '../repository/github.js';
import type { GitRepository } from '../repository/git-repository.js';
import { createProjectRepositoryService } from '../repository/service.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import {
  createProjectImagePreparationDependencies,
  ensureProjectImage,
  ProjectImagePreparationError,
} from './image-preparation.js';
import { resolveProjectImageCommit } from './readiness-adapters.js';
import { readInstanceId } from './instance-id.js';
import type { ProjectRecord, ProjectStore } from './store.js';
import { resolveProjectExecutionLocation } from './execution-location.js';
import { createLocalExecutionAdapter, createSshExecutionAdapter } from './execution-adapter.js';
import { createDockerRuntimeFromAdapter } from './execution-container.js';
import { createLocationImageStateStore } from './execution-image-cache.js';
import { createExecutionResourceLedger } from './resource-ledger.js';
import { locationHasCapacity } from '../automation/project-queue-coordinator.js';
import { registerActiveExecutionResource } from './active-execution-resources.js';
import { projectImageTag } from './image-builder.js';

export class ProjectImageAdminError extends Error {
  constructor(
    readonly code:
      | 'GIT_TOKEN_MISSING'
      | 'REPOSITORY_IDENTITY_MISMATCH'
      | 'TARGET_UNAVAILABLE'
      | 'CONFIGURATION_CHANGED'
      | 'PREPARATION_CONFLICT'
      | 'DOCKER_UNAVAILABLE'
      | 'BUILD_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectImageAdminError';
  }
}

export interface ProjectImageAdminService {
  prepare(projectId: string): Promise<{
    projectId: string;
    targetCommit: string;
    dockerfilePath: string;
    imageId: string;
    reused: boolean;
  }>;
}

/** The authenticated route delegates all Git/Docker work to this controlled project service. */
export function createProjectImageAdminService(input: {
  database: Database.Database;
  projects: ProjectStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  repoRoot: string;
  storageRoot: string;
  github?: (
    project: ProjectRecord,
    token: string,
  ) => Pick<GitHubClient, 'verifyIdentity' | 'readRepository'>;
  branchHead?: (projectId: string, branch: string) => Promise<string | null>;
  fetchRepository?: (repository: GitRepository) => Promise<void>;
  ensureImage?: typeof ensureProjectImage;
}): ProjectImageAdminService {
  const github =
    input.github ??
    ((project: ProjectRecord, token: string) =>
      new GitHubClient({
        repositoryUrl: input.configuration.repositoryUrl(project.projectId),
        tokenProvider: () => token,
      }));
  const repositoryService = (projectId: string) =>
    createProjectRepositoryService(
      input.database,
      projectId,
      input.configuration,
      input.secrets,
      input.repoRoot,
    );
  const branchHead =
    input.branchHead ??
    (async (projectId: string, branch: string) =>
      (await repositoryService(projectId).getRepository()).remoteBranchHead(branch));
  const ensureImage = input.ensureImage ?? ensureProjectImage;
  return {
    async prepare(projectId) {
      const project = input.projects.get(projectId);
      if (!project) throw new Error('项目不存在');
      const config = input.configuration.get(projectId);
      const token = input.secrets.project(projectId).get('gitToken');
      if (!token) {
        throw new ProjectImageAdminError('GIT_TOKEN_MISSING', '请先配置项目 GitHub Token');
      }
      const client = github(project, token);
      let identity;
      try {
        identity = await client.verifyIdentity();
      } catch (error) {
        throw new ProjectImageAdminError(
          'TARGET_UNAVAILABLE',
          describeGitHubRepositoryFailure(error),
        );
      }
      if (
        identity.githubRepositoryId !== project.githubRepositoryId ||
        identity.owner.toLowerCase() !== project.repositoryOwner.toLowerCase() ||
        identity.name.toLowerCase() !== project.repositoryName.toLowerCase()
      ) {
        throw new ProjectImageAdminError(
          'REPOSITORY_IDENTITY_MISMATCH',
          'GitHub 仓库身份与项目绑定不一致',
        );
      }
      let targetCommit: string | null;
      try {
        targetCommit = await resolveProjectImageCommit(projectId, config, client, branchHead);
      } catch (error) {
        throw new ProjectImageAdminError(
          'TARGET_UNAVAILABLE',
          error instanceof GitHubApiError
            ? `无法读取项目目标分支：${describeGitHubRepositoryFailure(error)}`
            : '无法读取项目目标分支，请检查仓库连接',
        );
      }
      if (!targetCommit) {
        throw new ProjectImageAdminError('TARGET_UNAVAILABLE', '无法确定项目固定提交');
      }
      try {
        const repository = await repositoryService(projectId).getRepository();
        try {
          await (input.fetchRepository ?? ((source) => source.fetch()))(repository);
        } catch {
          throw new ProjectImageAdminError('TARGET_UNAVAILABLE', '项目源码获取失败');
        }
        const location = resolveProjectExecutionLocation(input.database, projectId);
        const globalLimit = Number(
          (
            input.database
              .prepare(
                "SELECT value FROM system_metadata WHERE key = 'runtime_max_concurrent_projects'",
              )
              .get() as { value: string } | undefined
          )?.value ?? 2,
        );
        const attemptId = randomUUID();
        const instanceId = readInstanceId(input.database);
        const ledger = createExecutionResourceLedger(input.database, instanceId);
        const resource = input.database.transaction(() => {
          const active = input.database
            .prepare(
              "SELECT 1 FROM test_request_queue WHERE project_id = ? AND status IN ('queued','running','waiting_archive') LIMIT 1",
            )
            .get(projectId);
          if (
            active ||
            !locationHasCapacity(input.database, location.id, location.revision, globalLimit)
          ) {
            throw new ProjectImageAdminError(
              'PREPARATION_CONFLICT',
              '项目或执行服务器当前没有可用准备名额',
            );
          }
          return ledger.plan({
            projectId,
            attemptId,
            executionLocationId: location.id,
            executionLocationRevision: location.revision,
            resourceType: 'image-preparation',
            ownerLabels: {
              'luowang.instance-id': instanceId,
              'luowang.project-id': projectId,
              'luowang.attempt-id': attemptId,
            },
          });
        })();
        const unregisterActive = registerActiveExecutionResource(resource.resourceId);
        const adapter = await (async () => {
          try {
            return location.kind === 'local'
              ? createLocalExecutionAdapter(location.id)
              : await createServerAdapter(
                  input.database,
                  input.secrets,
                  location.id,
                  location.revision,
                );
          } catch (error) {
            ledger.transition(
              resource.resourceId,
              'planned',
              'unknown',
              null,
              'CONNECTION_UNCONFIRMED',
            );
            throw error;
          }
        })().catch((error) => {
          unregisterActive();
          throw error;
        });
        try {
          const docker = createDockerRuntimeFromAdapter(adapter);
          const dependencies = createProjectImagePreparationDependencies(docker);
          if (location.kind === 'ssh') {
            dependencies.build = async (build) => {
              const remote = `/tmp/luowang/${instanceId}/${projectId}/prepare-${attemptId}`;
              await adapter.uploadTree(build.source.directory, remote, {
                timeoutMs: 10 * 60_000,
              });
              try {
                const iid = `${remote}/.luowang-iid`;
                const result = await adapter.execute(
                  'docker',
                  [
                    'build',
                    '--file',
                    `${remote}/${build.source.dockerfilePath}`,
                    '--iidfile',
                    iid,
                    '--label',
                    `luowang.project-id=${build.projectId}`,
                    '--label',
                    `luowang.instance-id=${build.instanceId}`,
                    '--label',
                    `luowang.target-commit=${build.source.targetCommit}`,
                    '--label',
                    `luowang.build-definition=${build.source.buildDefinition ?? build.source.dockerfilePath}`,
                    remote,
                  ],
                  { timeoutMs: 30 * 60_000 },
                );
                if (result.code !== 0) throw new ProjectImagePreparationError('BUILD_FAILED');
                const localIid = `${input.storageRoot}/remote-prepare-${attemptId}.iid`;
                await adapter.download(iid, localIid, { timeoutMs: 60_000 });
                try {
                  const imageId = (await readFile(localIid, 'utf8')).trim();
                  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
                    throw new ProjectImagePreparationError('IMAGE_MISMATCH');
                  }
                  return {
                    projectId: build.projectId,
                    targetCommit: build.source.targetCommit,
                    imageId,
                    tag: projectImageTag(
                      build.projectId,
                      build.source.targetCommit,
                      build.source.buildDefinition ?? build.source.dockerfilePath,
                    ),
                  };
                } finally {
                  await rm(localIid, { force: true });
                }
              } finally {
                await adapter.removeTree(remote).catch(() => undefined);
              }
            };
          }
          const platform =
            location.kind === 'local'
              ? `${process.platform}/${process.arch}`
              : readServerPlatform(input.database, location.serverId!);
          const image = await ensureImage(
            {
              repository,
              projectId,
              instanceId,
              targetCommit,
              dockerfilePath: config.executionDockerfile,
              storageRoot: input.storageRoot,
              state: createLocationImageStateStore(input.database, {
                executionLocationId: location.id,
                executionLocationRevision: location.revision,
                platform,
              }),
            },
            dependencies,
          );
          ledger.transition(resource.resourceId, 'planned', 'created', image.imageId);
          ledger.transition(resource.resourceId, 'created', 'released');
          if (input.projects.get(projectId)?.configRevision !== project.configRevision) {
            throw new ProjectImageAdminError(
              'CONFIGURATION_CHANGED',
              '镜像准备期间项目配置已变化，请重新检查',
            );
          }
          return {
            projectId,
            targetCommit,
            dockerfilePath: image.buildDefinition,
            imageId: image.imageId,
            reused: image.reused,
          };
        } catch (error) {
          const latest = ledger.get(resource.resourceId);
          if (latest.state === 'planned') {
            ledger.transition(
              resource.resourceId,
              'planned',
              'unknown',
              null,
              'PREPARATION_UNCONFIRMED',
            );
          }
          throw error;
        } finally {
          unregisterActive();
          await adapter.close().catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof ProjectImageAdminError) throw error;
        if (error instanceof ProjectImagePreparationError) {
          throw new ProjectImageAdminError(
            error.code === 'DOCKER_UNAVAILABLE' ? 'DOCKER_UNAVAILABLE' : 'BUILD_FAILED',
            error.code === 'DOCKER_UNAVAILABLE'
              ? 'Docker Engine 不可用，请检查部署环境'
              : '项目镜像准备失败，请检查 Dockerfile 和构建日志',
          );
        }
        if (error instanceof Error && error.message === '项目镜像正在准备') {
          throw new ProjectImageAdminError('PREPARATION_CONFLICT', '项目镜像正在准备');
        }
        throw error;
      }
    },
  };
}

async function createServerAdapter(
  database: Database.Database,
  secrets: ScopedSecretStore,
  locationId: string,
  revision: number,
) {
  const serverId = locationId.slice('server:'.length);
  const row = database
    .prepare('SELECT * FROM execution_servers WHERE server_id = ?')
    .get(serverId) as
    | {
        revision: number;
        host: string;
        port: number;
        username: string;
        auth_type: 'password' | 'private-key';
        host_fingerprint: string | null;
        health_status: string;
      }
    | undefined;
  if (!row || row.revision !== revision || row.health_status !== 'ready' || !row.host_fingerprint) {
    throw new ProjectImageAdminError('DOCKER_UNAVAILABLE', '执行服务器尚未通过检查');
  }
  const secret = secrets.resource('execution-server', serverId);
  return createSshExecutionAdapter({
    locationId,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.auth_type === 'password' ? secret.get('password') : undefined,
    privateKey: row.auth_type === 'private-key' ? secret.get('privateKey') : undefined,
    passphrase: secret.get('privateKeyPassphrase'),
    pinnedFingerprint: row.host_fingerprint,
  });
}

function readServerPlatform(database: Database.Database, serverId: string): string {
  const row = database
    .prepare('SELECT capabilities_json FROM execution_servers WHERE server_id = ?')
    .get(serverId) as { capabilities_json: string | null } | undefined;
  try {
    const value = JSON.parse(row?.capabilities_json ?? '{}') as { platform?: unknown };
    return typeof value.platform === 'string' && value.platform ? value.platform : 'linux/unknown';
  } catch {
    return 'linux/unknown';
  }
}
