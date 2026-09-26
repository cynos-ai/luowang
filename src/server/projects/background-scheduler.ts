import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

import type { ConfigurationStore } from '../configuration.js';
import type { ProjectAutomationDispatcher } from '../automation/project-dispatcher.js';
import { createGitPoller, type GitPoller } from '../automation/poller.js';
import { matchesCron } from '../automation/scheduler.js';
import { createProjectAutomationStateStore } from '../automation/state.js';
import { createProjectRepositoryIndexer, type RepositoryIndexer } from '../repository/indexer.js';
import { createProjectRepositoryService } from '../repository/service.js';
import { createProjectRunStore } from '../runs/store.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import { createProjectRuntimeConfiguration } from './runtime-access.js';
import type { ProjectStore } from './store.js';
import { awaitsCutoverActivation } from './cutover-activation.js';

const LAST_POLL = 'scheduler.last-poll-at';
const LAST_CRON = 'scheduler.last-cron-key';
const LAST_ERROR = 'scheduler.last-error';
const LAST_INDEX = 'scheduler.last-index-at';
const INDEX_ERROR = 'scheduler.index-error';
const INDEX_INTERVAL_MS = 5 * 60_000;

export interface ProjectBackgroundScheduler {
  recover(): Promise<void>;
  tick(at?: Date): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/** One timer scans projects; only the global dispatcher can claim a Run. */
export function createProjectBackgroundScheduler(input: {
  database: Database.Database;
  deployment: ConfigurationStore;
  projects: ProjectStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  dispatcher: ProjectAutomationDispatcher;
  repoRoot: string;
  reportRoot: string;
  logger?: Logger;
  now?: () => Date;
  createPoller?: (projectId: string) => GitPoller;
  createIndexer?: (projectId: string) => Pick<RepositoryIndexer, 'sync'>;
}): ProjectBackgroundScheduler {
  const now = input.now ?? (() => new Date());
  const pollerFor =
    input.createPoller ??
    ((projectId: string) => {
      const configuration = createProjectRuntimeConfiguration(
        projectId,
        input.deployment,
        input.configuration,
        { repoRoot: input.repoRoot, reportRoot: input.reportRoot },
      );
      return createGitPoller({
        configuration,
        repository: createProjectRepositoryService(
          input.database,
          projectId,
          input.configuration,
          input.secrets,
          input.repoRoot,
        ),
        state: createProjectAutomationStateStore(input.database, projectId),
        runStore: createProjectRunStore(input.database, projectId),
        submitter: {
          submitTestRequest: async (request) => ({
            queue: input.dispatcher.enqueue(projectId, request),
          }),
        },
      });
    });
  const pollers = new Map<string, GitPoller>();
  const indexers = new Map<string, Pick<RepositoryIndexer, 'sync'>>();
  let timer: NodeJS.Timeout | undefined;
  let activeTick: Promise<void> | null = null;

  async function processProject(projectId: string, at: Date): Promise<void> {
    const state = createProjectAutomationStateStore(input.database, projectId);
    try {
      const config = input.configuration.get(projectId);
      const lastPollRaw = state.get(LAST_POLL);
      const lastPoll = lastPollRaw ? Date.parse(lastPollRaw) : NaN;
      const poller = () => {
        let current = pollers.get(projectId);
        if (!current) {
          current = pollerFor(projectId);
          pollers.set(projectId, current);
        }
        return current;
      };
      if (!Number.isFinite(lastPoll)) {
        state.set(LAST_POLL, at.toISOString());
      } else if (
        config.pollIntervalSeconds > 0 &&
        at.getTime() >= lastPoll + config.pollIntervalSeconds * 1_000
      ) {
        state.set(LAST_POLL, at.toISOString());
        const result = await poller().poll('git');
        if (result.status === 'failed') throw new Error(result.message);
      }
      const minute = at.toISOString().slice(0, 16);
      if (config.cron.trim() && state.get(LAST_CRON) !== minute && matchesCron(config.cron, at)) {
        state.set(LAST_CRON, minute);
        const result = await poller().poll('schedule');
        if (result.status === 'failed') throw new Error(result.message);
      }
      state.delete(LAST_ERROR);
    } catch (error) {
      const message = error instanceof Error ? error.message : '项目后台检查失败';
      state.set(LAST_ERROR, message);
      input.logger?.warn(
        { projectId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'project background check failed',
      );
    }
  }

  async function indexProject(projectId: string, at: Date): Promise<void> {
    const state = createProjectAutomationStateStore(input.database, projectId);
    const previous = state.get(LAST_INDEX);
    const last = previous ? Date.parse(previous) : NaN;
    if (Number.isFinite(last) && at.getTime() - last < INDEX_INTERVAL_MS) return;
    state.set(LAST_INDEX, at.toISOString());
    try {
      let indexer = indexers.get(projectId);
      if (!indexer) {
        indexer = input.createIndexer
          ? input.createIndexer(projectId)
          : createProjectRepositoryIndexer(
              input.database,
              createProjectRepositoryService(
                input.database,
                projectId,
                input.configuration,
                input.secrets,
                input.repoRoot,
              ),
              projectId,
            );
        indexers.set(projectId, indexer);
      }
      const result = await indexer.sync();
      if (result.status !== 'synced') throw new Error(result.message);
      state.delete(INDEX_ERROR);
    } catch (error) {
      state.set(INDEX_ERROR, error instanceof Error ? error.message : '项目索引失败');
      input.logger?.warn(
        { projectId, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'project index sync failed',
      );
    }
  }

  const tick = (at: Date = now()): Promise<void> => {
    if (activeTick) return activeTick;
    activeTick = (async () => {
      await Promise.all(
        input.projects.list().map(async (project) => {
          if (awaitsCutoverActivation(input.database, project.projectId)) return;
          await indexProject(project.projectId, at);
          if (project.status === 'active') await processProject(project.projectId, at);
        }),
      );
      await input.dispatcher.retryArchives(at);
      await input.dispatcher.drain();
    })().finally(() => {
      activeTick = null;
    });
    return activeTick;
  };
  return {
    recover: () => input.dispatcher.recover(),
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch((error: unknown) =>
          input.logger?.error(
            { errorName: error instanceof Error ? error.name : 'UnknownError' },
            'project background tick failed',
          ),
        );
      }, 1_000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await activeTick;
    },
  };
}
