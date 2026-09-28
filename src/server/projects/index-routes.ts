import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import type { OperationsScenario, ScenarioRunHistory } from '../../shared/types.js';
import type { RepositoryIndexer } from '../repository/indexer.js';
import { createProjectRepositoryIndexer } from '../repository/indexer.js';
import { createProjectRepositoryService } from '../repository/service.js';
import { AppError } from '../errors.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import { createProjectRunStore } from '../runs/store.js';
import type { ProjectStore } from './store.js';

/** Project-bound Git read model. Remote sync never changes another project's cache. */
export async function registerProjectIndexRoutes(
  app: FastifyInstance,
  options: {
    database: Database.Database;
    auth: AuthService;
    projects: ProjectStore;
    configuration: ProjectConfigurationStore;
    secrets: ScopedSecretStore;
    repoRoot: string;
    createIndexer?: (projectId: string) => RepositoryIndexer;
  },
): Promise<void> {
  const indexers = new Map<string, RepositoryIndexer>();
  const syncing = new Map<string, Promise<Awaited<ReturnType<RepositoryIndexer['sync']>>>>();
  const indexerFor = (projectId: string) => {
    if (!options.projects.get(projectId)) {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在', 404);
    }
    let indexer = indexers.get(projectId);
    if (!indexer) {
      indexer = options.createIndexer
        ? options.createIndexer(projectId)
        : createProjectRepositoryIndexer(
            options.database,
            createProjectRepositoryService(
              options.database,
              projectId,
              options.configuration,
              options.secrets,
              options.repoRoot,
            ),
            projectId,
          );
      indexers.set(projectId, indexer);
    }
    return indexer;
  };
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request) => {
      if (!options.auth.authenticate(request.cookies[SESSION_COOKIE_NAME])) {
        throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
      }
    });
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/index',
      async (request) => ({ index: indexerFor(request.params.projectId).indexState() }),
    );
    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/repository/sync',
      async (request) => {
        const projectId = request.params.projectId;
        const indexer = indexerFor(projectId);
        let pending = syncing.get(projectId);
        if (!pending) {
          pending = indexer.sync().finally(() => syncing.delete(projectId));
          syncing.set(projectId, pending);
        }
        return { sync: await pending };
      },
    );
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/scenarios',
      async (request) => ({
        scenarios: presentScenarios(
          indexerFor(request.params.projectId),
          options.database,
          request.params.projectId,
        ),
      }),
    );
    routes.get<{ Params: { projectId: string; scenarioId: string } }>(
      '/api/projects/:projectId/scenarios/:scenarioId',
      async (request) => {
        const scenario = presentScenarios(
          indexerFor(request.params.projectId),
          options.database,
          request.params.projectId,
        ).find((item) => item.id === request.params.scenarioId);
        if (!scenario) throw new AppError('SCENARIO_NOT_FOUND', '场景不存在', 404);
        return { scenario };
      },
    );
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/reports',
      async (request) => ({ reports: indexerFor(request.params.projectId).listReports() }),
    );
    routes.get<{ Params: { projectId: string; runId: string } }>(
      '/api/projects/:projectId/reports/:runId',
      async (request) => {
        const report = indexerFor(request.params.projectId).getReport(request.params.runId);
        if (!report) throw new AppError('REPORT_NOT_FOUND', '报告不存在', 404);
        return { report };
      },
    );
  });
}

function presentScenarios(
  indexer: RepositoryIndexer,
  database: Database.Database,
  projectId: string,
): OperationsScenario[] {
  const runs = createProjectRunStore(database, projectId).list();
  const reports = indexer.listReports();
  const history = new Map<string, ScenarioRunHistory[]>();
  for (const run of runs) {
    for (const result of run.scenarioResults) {
      const items = history.get(result.id) ?? [];
      items.push({
        runId: run.runId,
        result: result.result,
        finishedAt: run.finishedAt,
        targetCommit: run.targetCommit,
      });
      history.set(result.id, items);
    }
  }
  for (const report of reports) {
    for (const result of report.scenarioResults) {
      const items = history.get(result.id) ?? [];
      if (!items.some((item) => item.runId === report.runId)) {
        items.push({
          runId: report.runId,
          result: result.result,
          finishedAt: report.finishedAt,
          targetCommit: report.targetCommit,
        });
      }
      history.set(result.id, items);
    }
  }
  return indexer.listScenarios().map((scenario) => ({
    ...scenario,
    history: (history.get(scenario.id) ?? []).sort((left, right) =>
      right.finishedAt.localeCompare(left.finishedAt),
    ),
    pendingPullRequests: runs
      .filter(
        (run) =>
          run.scenarioStatus === 'pull_request' &&
          Boolean(run.scenarioPrUrl) &&
          run.scenarioResults.some((result) => result.id === scenario.id),
      )
      .map((run) => ({
        runId: run.runId,
        url: run.scenarioPrUrl as string,
        targetCommit: run.targetCommit,
      })),
  }));
}
