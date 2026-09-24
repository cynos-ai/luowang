import type { RunCommandSessionFactory } from '../runs/orchestrator.js';

import { startProjectCommandSession, type ProjectCommandSession } from './execution-container.js';
import { ensureProjectImage, type PreparedProjectImage } from './image-preparation.js';
import type { ProjectImageStateStore } from './image-state.js';
import { prepareProjectRunSource, type ProjectRunSource } from './run-source.js';

export interface ProjectCommandSessionDependencies {
  ensureImage: typeof ensureProjectImage;
  prepareSource: typeof prepareProjectRunSource;
  startSession: typeof startProjectCommandSession;
}

/** Bind one task's project/configuration snapshot before any Runner command is exposed. */
export function createProjectRunCommandSessionFactory(
  options: {
    projectId: string;
    dockerfilePath: string;
    storageRoot: string;
    imageState: ProjectImageStateStore;
  },
  dependencies: ProjectCommandSessionDependencies = {
    ensureImage: ensureProjectImage,
    prepareSource: prepareProjectRunSource,
    startSession: startProjectCommandSession,
  },
): RunCommandSessionFactory {
  return async (input) => {
    const image: PreparedProjectImage = await dependencies.ensureImage({
      repository: input.repository,
      projectId: options.projectId,
      targetCommit: input.targetCommit,
      dockerfilePath: options.dockerfilePath,
      storageRoot: options.storageRoot,
      state: options.imageState,
    });
    const source: ProjectRunSource = await dependencies.prepareSource({
      repository: input.repository,
      projectId: options.projectId,
      runId: input.runId,
      targetCommit: input.targetCommit,
      scenarioPatch: input.scenarioPatch,
      storageRoot: options.storageRoot,
    });
    let session: ProjectCommandSession;
    try {
      session = await dependencies.startSession({
        projectId: options.projectId,
        runId: input.runId,
        targetCommit: input.targetCommit,
        imageId: image.imageId,
        repositoryDirectory: input.repository.directory,
        sourceRoot: options.storageRoot,
        runSource: source,
      });
    } catch (error) {
      await source.cleanup();
      throw error;
    }
    return {
      run: (command, runOptions) => session.run(command, runOptions),
      async close() {
        await session.close();
        await source.cleanup();
      },
    };
  };
}
