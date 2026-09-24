import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ConfigurationError, type ConfigurationStore } from '../configuration.js';
import { AppError, toErrorResponse } from '../errors.js';
import {
  GitHubClient,
  parseGitHubRepository,
  type VerifiedGitHubRepositoryIdentity,
} from '../repository/github.js';
import { RepositoryError } from '../repository/errors.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import { SecretStoreError } from '../security/secret-store.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import { createGuardedScopedSecretStore } from './guarded-secrets.js';
import type { ProjectReadinessService } from './readiness.js';
import { ProjectStoreError, type ProjectStore } from './store.js';

type ProjectSecretKey = 'gitToken' | 'testUsername' | 'testPassword' | 'testDataCleanupToken';
const PROJECT_SECRET_KEYS = new Set<ProjectSecretKey>([
  'gitToken',
  'testUsername',
  'testPassword',
  'testDataCleanupToken',
]);

export interface ProjectAdminRouteOptions {
  database: Database.Database;
  auth: AuthService;
  deployment: ConfigurationStore;
  projects: ProjectStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  readiness: ProjectReadinessService;
  allowedOrigin?: string;
  verifyRepository?: (
    repositoryUrl: string,
    token: string | undefined,
  ) => Promise<VerifiedGitHubRepositoryIdentity>;
}

/** Register only on the v0.6.1 app after cookie parsing; old single-project routes stay closed. */
export async function registerProjectAdminRoutes(
  app: FastifyInstance,
  options: ProjectAdminRouteOptions,
): Promise<void> {
  const secrets = createGuardedScopedSecretStore(options.database, options.secrets);
  const verifyRepository =
    options.verifyRepository ??
    ((repositoryUrl: string, token: string | undefined) =>
      new GitHubClient({ repositoryUrl, tokenProvider: () => token }).verifyIdentity());
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request) => {
      if (!options.auth.authenticate(request.cookies[SESSION_COOKIE_NAME])) {
        throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
      }
      if (isWrite(request.method) && !isAllowedOrigin(request, options.allowedOrigin)) {
        throw new AppError('ORIGIN_FORBIDDEN', '请求来源未被允许', 403);
      }
    });

    routes.get('/api/projects', async () => ({ projects: options.projects.list() }));

    routes.post('/api/projects', async (request, reply) => {
      const body = readRecord(request.body);
      if (
        typeof body.displayName !== 'string' ||
        typeof body.repositoryUrl !== 'string' ||
        (body.gitToken !== undefined &&
          (typeof body.gitToken !== 'string' || body.gitToken.length === 0)) ||
        Object.keys(body).some((key) => !['displayName', 'repositoryUrl', 'gitToken'].includes(key))
      ) {
        throw new AppError('PROJECT_INPUT_INVALID', '项目名称、仓库地址或凭据无效', 400);
      }
      parseGitHubRepository(body.repositoryUrl);
      const token = body.gitToken as string | undefined;
      const repository = await verifyRepository(body.repositoryUrl, token);
      const project = options.database.transaction(() => {
        const created = options.projects.createVerified({
          displayName: body.displayName as string,
          repository,
        });
        options.configuration.update(created.projectId, {
          language: options.deployment.getHarness().language,
        });
        if (token) secrets.project(created.projectId).set('gitToken', token);
        return options.projects.get(created.projectId)!;
      })();
      return reply.status(201).send({ project });
    });

    routes.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request) => {
      const project = requireProject(options.projects, request.params.projectId);
      return {
        project,
        configuration: options.configuration.get(project.projectId),
        secrets: secrets.project(project.projectId).metadata(),
      };
    });

    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/readiness',
      async (request) =>
        options.readiness.check(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
    );

    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/pause',
      async (request) => ({
        project: options.readiness.pause(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
      }),
    );

    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/resume',
      async (request, reply) => {
        const result = await options.readiness.resume(
          requireProject(options.projects, request.params.projectId).projectId,
        );
        return reply.status(result.readiness.ready ? 200 : 409).send(result);
      },
    );

    routes.put<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/configuration',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const configuration = options.configuration.update(project.projectId, request.body);
        return { project: options.projects.get(project.projectId), configuration };
      },
    );

    routes.put<{ Params: { projectId: string; key: string } }>(
      '/api/projects/:projectId/secrets/:key',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const key = readProjectSecretKey(request.params.key);
        const body = readRecord(request.body);
        if (Object.keys(body).length !== 1 || typeof body.value !== 'string' || !body.value) {
          throw new AppError('SECRET_INPUT_INVALID', '凭据值无效', 400);
        }
        const store = secrets.project(project.projectId);
        store.set(key, body.value);
        return { key, metadata: store.metadata()[key] };
      },
    );

    routes.delete<{ Params: { projectId: string; key: string } }>(
      '/api/projects/:projectId/secrets/:key',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const key = readProjectSecretKey(request.params.key);
        const store = secrets.project(project.projectId);
        store.delete(key);
        return { key, metadata: store.metadata()[key] };
      },
    );

    routes.setErrorHandler((error, request, reply) => {
      const conflict =
        (error instanceof ProjectStoreError && error.code === 'PROJECT_ALREADY_EXISTS') ||
        (error instanceof ConfigurationError && error.message.includes('待处理请求')) ||
        (error instanceof Error && error.message.includes('待处理请求'));
      const status =
        error instanceof AppError || error instanceof RepositoryError
          ? error.statusCode
          : error instanceof SecretStoreError
            ? 503
            : conflict
              ? 409
              : error instanceof ConfigurationError || error instanceof ProjectStoreError
                ? 400
                : 500;
      const code =
        error instanceof AppError ||
        error instanceof RepositoryError ||
        error instanceof SecretStoreError ||
        error instanceof ProjectStoreError
          ? error.code
          : conflict
            ? 'CONFIGURATION_CONFLICT'
            : status === 500
              ? 'INTERNAL_ERROR'
              : 'CONFIGURATION_INVALID';
      const message =
        status === 500 ? '内部错误' : error instanceof Error ? error.message : '请求失败';
      return reply.status(status).send(toErrorResponse(code, message, request.id));
    });
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('BODY_INVALID', '请求体必须是 JSON 对象', 400);
  }
  return value as Record<string, unknown>;
}

function requireProject(projects: ProjectStore, projectId: string) {
  const project = projects.get(projectId);
  if (!project) throw new AppError('PROJECT_NOT_FOUND', '项目不存在', 404);
  return project;
}

function readProjectSecretKey(key: string): ProjectSecretKey {
  if (!PROJECT_SECRET_KEYS.has(key as ProjectSecretKey)) {
    throw new AppError('SECRET_KEY_INVALID', '项目凭据类型无效', 400);
  }
  return key as ProjectSecretKey;
}

function isWrite(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

function isAllowedOrigin(request: FastifyRequest, configured: string | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configured) return origin === configured;
  const forwarded = request.headers['x-forwarded-proto'];
  const protocol =
    request.protocol === 'https' ||
    (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim() === 'https')
      ? 'https'
      : 'http';
  return (
    typeof request.headers.host === 'string' && origin === `${protocol}://${request.headers.host}`
  );
}
