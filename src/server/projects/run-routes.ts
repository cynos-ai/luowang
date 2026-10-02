import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { OssObject } from '../storage/oss.js';

import type { ProjectAutomationDispatcher } from '../automation/project-dispatcher.js';
import { createProjectTestRequestQueue } from '../automation/queue.js';
import type { TestRequestRecord } from '../automation/queue.js';
import { createProjectRunRecoveryStore } from '../automation/recovery.js';
import { AppError } from '../errors.js';
import { createProjectRunStore, type StoredRun } from '../runs/store.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import { encodeStableEvidenceId } from '../storage/oss.js';
import type { ProjectStore } from './store.js';
import type { OperationsRunDetail, RunDetail, RunSummary } from '../../shared/types.js';

function failedQueueRun(item: TestRequestRecord | undefined): RunDetail | null {
  if (item?.status !== 'failed' || !item.runId) return null;
  return {
    runId: item.runId,
    status: 'failed',
    phase: 'failed',
    result: null,
    trigger: item.trigger,
    request: item.request,
    baseCommit: null,
    targetCommit: item.resolvedTargetCommit,
    includedCommits: [],
    startedAt: item.claimedAt ?? item.createdAt,
    finishedAt: item.completedAt ?? item.updatedAt,
    errorMessage: item.errorMessage,
    artifactNames: [],
    initialization: item.initialization,
    updatedAt: item.updatedAt,
    artifacts: {},
  };
}

export async function registerProjectRunRoutes(
  app: FastifyInstance,
  options: {
    database: Database.Database;
    auth: AuthService;
    projects: ProjectStore;
    dispatcher: ProjectAutomationDispatcher;
    logger?: Logger;
    readEvidence: (projectId: string, key: string) => Promise<OssObject>;
  },
): Promise<void> {
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request) => {
      if (!options.auth.authenticate(request.cookies[SESSION_COOKIE_NAME])) {
        throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
      }
    });
    const requireProject = (projectId: string) => {
      const project = options.projects.get(projectId);
      if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在', 404);
      return project;
    };
    const queueFor = (projectId: string) =>
      createProjectTestRequestQueue(options.database, requireProject(projectId).projectId);
    const runStoreFor = (projectId: string) =>
      createProjectRunStore(options.database, requireProject(projectId).projectId);
    const recoveryFor = (projectId: string) =>
      createProjectRunRecoveryStore(options.database, requireProject(projectId).projectId);
    const readRun = async (
      projectId: string,
      runId: string,
    ): Promise<OperationsRunDetail | null> => {
      requireProject(projectId);
      const store = runStoreFor(projectId);
      const [runtime, stored] = await Promise.all([
        options.dispatcher.getActiveRun(projectId, runId),
        Promise.resolve(store.get(runId)),
      ]);
      if (runtime || stored) return presentRun(runtime, stored);
      const recovered = recoveryFor(projectId).get(runId);
      if (recovered) return presentRun(recovered, null);
      const failed = failedQueueRun(
        queueFor(projectId)
          .list()
          .find((item) => item.runId === runId),
      );
      return failed ? presentRun(failed, null) : null;
    };
    const startDrain = () => {
      void options.dispatcher.drain().catch((error: unknown) => {
        options.logger?.error(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'project dispatcher drain failed',
        );
      });
    };

    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/runs',
      async (request, reply) => {
        const project = requireProject(request.params.projectId);
        const body = readInput(request);
        if (
          typeof body.request !== 'string' ||
          !body.request.trim() ||
          (body.initialization !== undefined && typeof body.initialization !== 'boolean') ||
          Object.keys(body).some((key) => !['request', 'trigger', 'initialization'].includes(key))
        ) {
          throw new AppError('RUN_REQUEST_INVALID', '项目 Run 请求字段无效', 400);
        }
        const trigger = body.trigger ?? 'manual';
        if (trigger !== 'manual' && trigger !== 'api') {
          throw new AppError('RUN_TRIGGER_INVALID', '仅支持 manual 或 api 触发', 400);
        }
        const queue = options.dispatcher.enqueue(project.projectId, {
          request: body.request,
          trigger,
          requestKind: 'manual-current-head',
          ...(body.initialization === true ? { initialization: true } : {}),
        });
        startDrain();
        return reply.status(202).send({ queue });
      },
    );
    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/merge',
      async (request, reply) => {
        const project = requireProject(request.params.projectId);
        const body = readInput(request);
        if (
          typeof body.sourceRef !== 'string' ||
          !body.sourceRef.trim() ||
          body.confirmed !== true ||
          (body.request !== undefined && typeof body.request !== 'string') ||
          (body.initialization !== undefined && typeof body.initialization !== 'boolean') ||
          Object.keys(body).some(
            (key) => !['sourceRef', 'confirmed', 'request', 'initialization'].includes(key),
          )
        ) {
          throw new AppError('MERGE_REQUEST_INVALID', '项目合并请求必须确认并提供来源分支', 400);
        }
        const queue = options.dispatcher.enqueue(project.projectId, {
          request:
            typeof body.request === 'string' && body.request.trim()
              ? body.request
              : '合并已确认来源并测试固定场景分支 target',
          trigger: 'manual',
          requestKind: 'manual-merge-source',
          sourceRef: body.sourceRef.trim(),
          confirmed: true,
          ...(body.initialization === true ? { initialization: true } : {}),
        });
        startDrain();
        return reply.status(202).send({ queue });
      },
    );
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/queue',
      async (request) => ({ queue: queueFor(request.params.projectId).list() }),
    );
    routes.get<{ Params: { projectId: string; queueId: string } }>(
      '/api/projects/:projectId/queue/:queueId',
      async (request) => {
        const queueId = parseQueueId(request.params.queueId);
        const queue = queueFor(request.params.projectId).get(queueId);
        if (!queue) throw new AppError('QUEUE_NOT_FOUND', '队列请求不存在', 404);
        return { queue };
      },
    );
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/runs',
      async (request) => {
        const projectId = request.params.projectId;
        const stored = runStoreFor(projectId).list();
        const interrupted = recoveryFor(projectId).list();
        const current = await options.dispatcher.currentRuns(projectId);
        const active = current.find((item) => item.projectId === projectId)?.run ?? null;
        const known = new Set([
          ...(active ? [active.runId] : []),
          ...stored.map((run) => run.runId),
          ...interrupted.map((run) => run.runId),
        ]);
        const failed: RunSummary[] = queueFor(projectId)
          .list()
          .map(failedQueueRun)
          .filter((run): run is RunDetail => run !== null && !known.has(run.runId));
        return {
          runs: [
            ...(active
              ? [presentRun(active, stored.find((run) => run.runId === active.runId) ?? null)]
              : []),
            ...stored
              .filter((run) => run.runId !== active?.runId)
              .map((run) => presentRun(null, run)),
            ...interrupted
              .filter(
                (run) =>
                  run.runId !== active?.runId && !stored.some((item) => item.runId === run.runId),
              )
              .map((run) => presentRun(run, null)),
            ...failed.map((run) => presentRun(run, null)),
          ].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
        };
      },
    );
    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/runs/current',
      async (request) => {
        requireProject(request.params.projectId);
        const current = await options.dispatcher.currentRuns(request.params.projectId);
        return {
          run: current.find((item) => item.projectId === request.params.projectId)?.run ?? null,
        };
      },
    );
    routes.get<{ Params: { projectId: string; runId: string } }>(
      '/api/projects/:projectId/runs/:runId',
      async (request) => {
        const run = await readRun(request.params.projectId, request.params.runId);
        if (!run) throw new AppError('RUN_NOT_FOUND', 'Run 不存在', 404);
        return { run };
      },
    );
    routes.get<{ Params: { projectId: string; runId: string; objectId: string } }>(
      '/api/projects/:projectId/runs/:runId/evidence/:objectId',
      async (request, reply) => {
        const { projectId, runId, objectId } = request.params;
        const run = await readRun(projectId, runId);
        const evidence = 'evidence' in (run ?? {}) ? run?.evidence : undefined;
        const reference = evidence?.find(
          (item) => item.id === objectId && encodeStableEvidenceId(item.objectKey) === objectId,
        );
        if (!reference) throw new AppError('EVIDENCE_NOT_FOUND', '证据不存在', 404);
        const scopedKey = reference.objectKey.match(/(?:^|\/)projects\/([^/]+)\/runs\/([^/]+)\//);
        if (scopedKey && (scopedKey[1] !== projectId || scopedKey[2] !== runId)) {
          throw new AppError('EVIDENCE_NOT_FOUND', '证据不存在', 404);
        }
        const object = await options.readEvidence(projectId, reference.objectKey);
        reply.header('cache-control', 'private, no-store');
        reply.header('x-content-type-options', 'nosniff');
        reply.type(safeContentType(reference.contentType));
        return reply.send(object.body);
      },
    );
  });
}

function presentRun(
  runtime: RunDetail | RunSummary | null,
  stored: StoredRun | null,
): OperationsRunDetail {
  const base: RunSummary = runtime ?? {
    runId: stored!.runId,
    status: 'completed',
    phase: 'completed',
    result: stored!.result,
    trigger: stored!.trigger,
    request: stored!.request,
    baseCommit: stored!.baseCommit,
    targetCommit: stored!.targetCommit,
    includedCommits: stored!.includedCommits,
    startedAt: stored!.startedAt,
    finishedAt: stored!.finishedAt,
    errorMessage: null,
    artifactNames: Object.keys(stored!.artifacts),
    updatedAt: stored!.updatedAt,
  };
  const artifacts =
    runtime && 'artifacts' in runtime ? runtime.artifacts : (stored?.artifacts ?? {});
  return {
    ...base,
    request: base.request || stored?.request || '',
    baseCommit: base.baseCommit ?? stored?.baseCommit ?? null,
    targetCommit: base.targetCommit ?? stored?.targetCommit ?? null,
    includedCommits:
      base.includedCommits.length > 0 ? base.includedCommits : (stored?.includedCommits ?? []),
    artifactNames:
      base.artifactNames.length > 0 ? base.artifactNames : Object.keys(stored?.artifacts ?? {}),
    evidence: base.evidence ?? stored?.evidence,
    scenarioMode: base.scenarioMode ?? stored?.scenarioMode,
    initialization: base.initialization ?? stored?.initialization,
    scenarioPrUrl: base.scenarioPrUrl ?? stored?.scenarioPrUrl,
    currentScenario: base.currentScenario ?? null,
    scenarioProgress: base.scenarioProgress ?? stored?.scenarioProgress ?? undefined,
    activities:
      base.activities && base.activities.length > 0 ? base.activities : stored?.activities,
    blockingReasons: base.blockingReasons ?? stored?.blockingReasons,
    updatedAt: base.updatedAt ?? stored?.updatedAt,
    archive: stored
      ? {
          reportStatus: stored.reportStatus,
          reportCommitSha: stored.reportCommitSha,
          archiveStatus: stored.archiveStatus,
          archiveError: stored.archiveError,
          progressed: stored.progressed,
          progressedAt: stored.progressedAt,
          scenarioStatus: stored.scenarioStatus,
          scenarioCommitSha: stored.scenarioCommitSha,
          scenarioPrUrl: stored.scenarioPrUrl,
          scenarioError: stored.scenarioError,
        }
      : null,
    scenarioResults: stored?.scenarioResults ?? [],
    confirmedBugs: stored?.confirmedBugs ?? [],
    issues:
      stored?.issues.map((issue) => ({
        bugKey: issue.bugKey,
        title: issue.title,
        scenarioIds: issue.scenarioIds,
        issueAction: issue.issueAction,
        requestedIssueUrl: issue.requestedIssueUrl,
        status: issue.status,
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        errorMessage: issue.errorMessage,
        attempts: issue.attempts,
      })) ?? [],
    artifacts,
  };
}

function safeContentType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

function readInput(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('INVALID_REQUEST', '请求体必须是 JSON 对象', 400);
  }
  return request.body as Record<string, unknown>;
}

function parseQueueId(value: string): number {
  const id = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id)) {
    throw new AppError('QUEUE_ID_INVALID', '队列 ID 无效', 400);
  }
  return id;
}
