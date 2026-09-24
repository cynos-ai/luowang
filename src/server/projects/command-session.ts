import type { RunCommandSessionFactory } from '../runs/orchestrator.js';
import type { Logger } from 'pino';

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
    instanceId: string;
    dockerfilePath: string;
    storageRoot: string;
    imageState: ProjectImageStateStore;
    logger?: Logger;
    recordImage?: (input: { runId: string; targetCommit: string; imageId: string }) => void;
  },
  dependencies: ProjectCommandSessionDependencies = {
    ensureImage: ensureProjectImage,
    prepareSource: prepareProjectRunSource,
    startSession: startProjectCommandSession,
  },
): RunCommandSessionFactory {
  return async (input) => {
    const runStage = async <T>(
      stage: 'image' | 'source' | 'container' | 'binding',
      action: () => Promise<T>,
    ) => {
      try {
        return await action();
      } catch (error) {
        options.logger?.error(
          {
            projectId: options.projectId,
            runId: input.runId,
            stage,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorCode:
              error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string' &&
              /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
                ? error.code
                : undefined,
          },
          'project command session preparation failed',
        );
        throw error;
      }
    };
    const image: PreparedProjectImage = await runStage('image', () =>
      dependencies.ensureImage({
        repository: input.repository,
        projectId: options.projectId,
        instanceId: options.instanceId,
        targetCommit: input.targetCommit,
        dockerfilePath: options.dockerfilePath,
        storageRoot: options.storageRoot,
        state: options.imageState,
      }),
    );
    const source: ProjectRunSource = await runStage('source', () =>
      dependencies.prepareSource({
        repository: input.repository,
        projectId: options.projectId,
        runId: input.runId,
        targetCommit: input.targetCommit,
        scenarioPatch: input.scenarioPatch,
        storageRoot: options.storageRoot,
      }),
    );
    let session: ProjectCommandSession | undefined;
    try {
      session = await runStage('container', () =>
        dependencies.startSession({
          projectId: options.projectId,
          instanceId: options.instanceId,
          runId: input.runId,
          targetCommit: input.targetCommit,
          imageId: image.imageId,
          repositoryDirectory: input.repository.directory,
          sourceRoot: options.storageRoot,
          runSource: source,
        }),
      );
      await runStage('binding', async () => {
        options.recordImage?.({
          runId: input.runId,
          targetCommit: input.targetCommit,
          imageId: image.imageId,
        });
      });
    } catch (error) {
      await session?.close().catch(() => undefined);
      await source.cleanup();
      throw error;
    }
    if (!session) throw new Error('项目命令 Session 未启动');
    return {
      run: (command, runOptions) => session.run(command, runOptions),
      async close() {
        await session.close();
        await source.cleanup();
      },
    };
  };
}
