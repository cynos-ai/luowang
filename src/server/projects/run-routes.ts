import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { ProjectAutomationDispatcher } from '../automation/project-dispatcher.js';
import { createProjectTestRequestQueue } from '../automation/queue.js';
import { AppError } from '../errors.js';
import { createProjectRunStore } from '../runs/store.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import type { ProjectStore } from './store.js';

export async function registerProjectRunRoutes(
  app: FastifyInstance,
  options: {
    database: Database.Database;
    auth: AuthService;
    projects: ProjectStore;
    dispatcher: ProjectAutomationDispatcher;
    logger?: Logger;
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
      async (request) => ({ runs: runStoreFor(request.params.projectId).list() }),
    );
    routes.get<{ Params: { projectId: string; runId: string } }>(
      '/api/projects/:projectId/runs/:runId',
      async (request) => {
        const run = runStoreFor(request.params.projectId).get(request.params.runId);
        if (!run) throw new AppError('RUN_NOT_FOUND', 'Run 不存在', 404);
        return { run };
      },
    );
  });
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
