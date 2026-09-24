import type { GitRepository } from '../repository/git-repository.js';

import { buildProjectImage, type ProjectImageBuild } from './image-builder.js';
import { createDockerRuntime, type DockerRuntime } from './execution-container.js';
import {
  BUILTIN_IMAGE_DEFINITION,
  prepareBuiltInProjectImageSource,
  prepareProjectImageSource,
  type ProjectImageSource,
} from './image-source.js';
import type { ProjectImageKey, ProjectImageStateStore } from './image-state.js';

export interface PreparedProjectImage {
  imageId: string;
  buildDefinition: string;
  reused: boolean;
}

export class ProjectImagePreparationError extends Error {
  constructor(readonly code: 'DOCKER_UNAVAILABLE' | 'IMAGE_MISMATCH' | 'BUILD_FAILED') {
    super(code);
    this.name = 'ProjectImagePreparationError';
  }
}

export interface ProjectImagePreparationDependencies {
  ensureDocker(): Promise<void>;
  prepareSource(input: {
    repository: GitRepository;
    projectId: string;
    targetCommit: string;
    dockerfilePath: string;
    storageRoot: string;
  }): Promise<ProjectImageSource>;
  build(input: {
    projectId: string;
    instanceId: string;
    source: ProjectImageSource;
  }): Promise<ProjectImageBuild>;
  inspect(input: ProjectImageKey & { imageId: string }): Promise<boolean>;
}

export function createProjectImagePreparationDependencies(
  docker: DockerRuntime = createDockerRuntime(),
): ProjectImagePreparationDependencies {
  return {
    async ensureDocker() {
      try {
        const result = await docker.run(['info', '--format', '{{.ServerVersion}}'], {
          timeoutMs: 10_000,
        });
        if (result.exitCode !== 0) throw new Error('Docker Engine unavailable');
      } catch {
        throw new ProjectImagePreparationError('DOCKER_UNAVAILABLE');
      }
    },
    prepareSource(input) {
      if (input.dockerfilePath === '') return prepareBuiltInProjectImageSource(input);
      return prepareProjectImageSource(input);
    },
    build: (input) => buildProjectImage(input),
    inspect: (input) => inspectProjectImage(input, docker),
  };
}

/** Reuse only a present image whose immutable ID has matching ownership labels. */
export async function ensureProjectImage(
  input: {
    repository: GitRepository;
    projectId: string;
    instanceId: string;
    targetCommit: string;
    dockerfilePath: string;
    storageRoot: string;
    state: ProjectImageStateStore;
  },
  dependencies: ProjectImagePreparationDependencies = createProjectImagePreparationDependencies(),
): Promise<PreparedProjectImage> {
  const buildDefinition = input.dockerfilePath || BUILTIN_IMAGE_DEFINITION;
  const key = {
    projectId: input.projectId,
    targetCommit: input.targetCommit,
    dockerfilePath: buildDefinition,
  };
  const existing = input.state.get(key);
  if (existing?.status === 'ready' && existing.imageId) {
    if (await dependencies.inspect({ ...key, imageId: existing.imageId })) {
      return { imageId: existing.imageId, buildDefinition, reused: true };
    }
  }
  await dependencies.ensureDocker();
  input.state.begin(key);
  let source: ProjectImageSource | undefined;
  try {
    source = await dependencies.prepareSource({
      repository: input.repository,
      projectId: input.projectId,
      targetCommit: input.targetCommit,
      dockerfilePath: input.dockerfilePath,
      storageRoot: input.storageRoot,
    });
    if (
      source.targetCommit !== input.targetCommit ||
      (source.buildDefinition ?? source.dockerfilePath) !== buildDefinition
    ) {
      throw new ProjectImagePreparationError('IMAGE_MISMATCH');
    }
    const built = await dependencies.build({
      projectId: input.projectId,
      instanceId: input.instanceId,
      source,
    });
    if (
      built.projectId !== input.projectId ||
      built.targetCommit !== input.targetCommit ||
      !(await dependencies.inspect({ ...key, imageId: built.imageId }))
    ) {
      throw new ProjectImagePreparationError('IMAGE_MISMATCH');
    }
    input.state.ready(key, built.imageId);
    return { imageId: built.imageId, buildDefinition, reused: false };
  } catch (error) {
    const code = error instanceof ProjectImagePreparationError ? error.code : 'BUILD_FAILED';
    input.state.fail(key, code);
    throw new ProjectImagePreparationError(code);
  } finally {
    await source?.cleanup();
  }
}

export async function inspectProjectImage(
  input: ProjectImageKey & { imageId: string },
  docker: DockerRuntime = createDockerRuntime(),
): Promise<boolean> {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageId)) return false;
  const result = await docker.run(
    ['image', 'inspect', '--format', '{{json .Config.Labels}}', input.imageId],
    { timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) {
    const health = await docker.run(['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 10_000,
    });
    if (health.exitCode !== 0) throw new ProjectImagePreparationError('DOCKER_UNAVAILABLE');
    return false;
  }
  try {
    const labels = JSON.parse(result.stdout.trim()) as Record<string, unknown> | null;
    return (
      labels?.['luowang.project-id'] === input.projectId &&
      labels?.['luowang.target-commit'] === input.targetCommit &&
      labels?.['luowang.build-definition'] === input.dockerfilePath
    );
  } catch {
    return false;
  }
}
