import type Database from 'better-sqlite3';

import { GitHubClient } from '../repository/github.js';
import type { GitRepository } from '../repository/git-repository.js';
import { createProjectRepositoryService } from '../repository/service.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import { ensureProjectImage, ProjectImagePreparationError } from './image-preparation.js';
import { createProjectImageStateStore } from './image-state.js';
import { resolveProjectImageCommit } from './readiness-adapters.js';
import type { ProjectRecord, ProjectStore } from './store.js';

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
  const state = createProjectImageStateStore(input.database);

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
      } catch {
        throw new ProjectImageAdminError('TARGET_UNAVAILABLE', 'GitHub 仓库身份核验失败');
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
      } catch {
        throw new ProjectImageAdminError('TARGET_UNAVAILABLE', '无法读取项目目标分支');
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
        const image = await ensureImage({
          repository,
          projectId,
          targetCommit,
          dockerfilePath: config.executionDockerfile,
          storageRoot: input.storageRoot,
          state,
        });
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
