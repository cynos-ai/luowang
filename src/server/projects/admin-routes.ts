import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ConfigurationError, type ConfigurationStore } from '../configuration.js';
import { AppError, toErrorResponse } from '../errors.js';
import {
  GitHubClient,
  describeGitHubRepositoryFailure,
  parseGitHubRepository,
  type VerifiedGitHubRepositoryIdentity,
} from '../repository/github.js';
import { RepositoryError } from '../repository/errors.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import { SecretStoreError } from '../security/secret-store.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import { createGuardedScopedSecretStore } from './guarded-secrets.js';
import { ProjectImageAdminError, type ProjectImageAdminService } from './image-admin.js';
import { invalidateProjectReadiness, type ProjectReadinessService } from './readiness.js';
import { ProjectStoreError, type ProjectStore } from './store.js';
import {
  createConnectionResourceService,
  type ConnectionResourceService,
} from './connection-resources.js';
import { createSshExecutionAdapter, readSshHostFingerprint } from './execution-adapter.js';
import { deleteProject } from './delete-project.js';
import type { createEnvironmentGenerationService } from './environment-generation.js';
import type { createEnvironmentValidationService } from './environment-validation.js';
import { readEnvironmentRecommendation } from './environment-recommendation.js';

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
  images: ProjectImageAdminService;
  environmentGeneration?: ReturnType<typeof createEnvironmentGenerationService>;
  environmentValidation?: ReturnType<typeof createEnvironmentValidationService>;
  connectionResources?: ConnectionResourceService;
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
  const connectionResources =
    options.connectionResources ??
    createConnectionResourceService({ database: options.database, secrets });
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
    if (options.environmentGeneration) {
      const generation = options.environmentGeneration;
      routes.get<{ Params: { projectId: string } }>(
        '/api/projects/:projectId/environment-generation',
        async (request) => ({
          task: generation.current(
            requireProject(options.projects, request.params.projectId).projectId,
          ),
        }),
      );
      routes.post<{ Params: { projectId: string } }>(
        '/api/projects/:projectId/environment-generation',
        async (request, reply) =>
          reply.status(202).send({
            task: generation.start(
              requireProject(options.projects, request.params.projectId).projectId,
              readRecord(request.body ?? {}),
            ),
          }),
      );
      routes.get<{ Params: { projectId: string; id: string } }>(
        '/api/projects/:projectId/environment-generation/:id',
        async (request) => ({
          task: generation.get(
            requireProject(options.projects, request.params.projectId).projectId,
            request.params.id,
          ),
        }),
      );
      routes.delete<{ Params: { projectId: string; id: string } }>(
        '/api/projects/:projectId/environment-generation/:id',
        async (request) => ({
          task: generation.stop(
            requireProject(options.projects, request.params.projectId).projectId,
            request.params.id,
          ),
        }),
      );
      routes.put<{ Params: { projectId: string; id: string } }>(
        '/api/projects/:projectId/environment-generation/:id/apply',
        async (request) => {
          const projectId = requireProject(options.projects, request.params.projectId).projectId;
          const configuration = generation.apply(projectId, request.params.id, request.body);
          invalidateProjectReadiness(options.database, projectId);
          return { configuration };
        },
      );
      routes.post<{ Params: { projectId: string; id: string } }>(
        '/api/projects/:projectId/environment-generation/:id/discard',
        async (request) => ({
          task: generation.discard(
            requireProject(options.projects, request.params.projectId).projectId,
            request.params.id,
          ),
        }),
      );
    }
    if (options.environmentValidation) {
      const validation = options.environmentValidation;
      routes.get<{ Params: { projectId: string } }>(
        '/api/projects/:projectId/environment-validation',
        async (request) => ({
          task: validation.current(
            requireProject(options.projects, request.params.projectId).projectId,
          ),
        }),
      );
      routes.post<{ Params: { projectId: string } }>(
        '/api/projects/:projectId/environment-validation',
        async (request, reply) =>
          reply.status(202).send({
            task: validation.start(
              requireProject(options.projects, request.params.projectId).projectId,
            ),
          }),
      );
      routes.delete<{ Params: { projectId: string; id: string } }>(
        '/api/projects/:projectId/environment-validation/:id',
        async (request) => ({
          task: validation.stop(
            requireProject(options.projects, request.params.projectId).projectId,
            request.params.id,
          ),
        }),
      );
    }

    routes.delete<{ Params: { projectId: string } }>(
      '/api/projects/:projectId',
      async (request) => {
        if (options.environmentGeneration?.isActive(request.params.projectId))
          throw new ConfigurationError('项目正在生成配置，请先停止生成');
        deleteProject(options.database, request.params.projectId);
        return { deleted: true };
      },
    );

    routes.get('/api/connection-resources', async () => connectionResources.list());

    routes.post('/api/connection-resources/github', async (request, reply) =>
      reply.status(201).send({
        credential: connectionResources.createGithubCredential(readGithubCredential(request.body)),
      }),
    );
    routes.put<{ Params: { id: string } }>(
      '/api/connection-resources/github/:id',
      async (request) => ({
        credential: connectionResources.updateGithubCredential(
          request.params.id,
          readRecord(request.body),
        ),
      }),
    );
    routes.delete<{ Params: { id: string } }>(
      '/api/connection-resources/github/:id',
      async (request) => {
        connectionResources.deleteGithubCredential(request.params.id);
        return { deleted: true };
      },
    );
    routes.post<{ Params: { id: string } }>(
      '/api/connection-resources/servers/:id/fingerprint',
      async (request) => {
        const server = connectionResources.executionServerConnection(request.params.id);
        const fingerprint = await readSshHostFingerprint({
          host: server.host,
          port: server.port,
          username: server.username,
        });
        return { fingerprint, confirmed: fingerprint === server.hostFingerprint };
      },
    );
    routes.put<{ Params: { id: string } }>(
      '/api/connection-resources/servers/:id/fingerprint',
      async (request) => ({
        server: connectionResources.confirmExecutionServerFingerprint(
          request.params.id,
          readRecord(request.body).fingerprint,
        ),
      }),
    );
    routes.post<{ Params: { id: string } }>(
      '/api/connection-resources/servers/:id/check',
      async (request) => {
        const server = connectionResources.executionServerConnection(request.params.id);
        if (!server.hostFingerprint) throw new ConfigurationError('请先核对并确认 SSH 主机指纹');
        const adapter = await createSshExecutionAdapter({
          locationId: `server:${server.id}`,
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.password,
          privateKey: server.privateKey,
          passphrase: server.privateKeyPassphrase,
          pinnedFingerprint: server.hostFingerprint,
        });
        try {
          const [docker, compose, platform, disk] = await Promise.all([
            adapter.execute('docker', ['version', '--format', '{{.Server.Version}}']),
            adapter.execute('docker', ['compose', 'version', '--short']),
            adapter.execute('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}']),
            adapter.execute('docker', ['system', 'df', '--format', '{{json .}}']),
          ]);
          if ([docker, compose, platform, disk].some((result) => result.code !== 0))
            throw new ConfigurationError('远程 Docker 或 Compose 检查失败');
          return {
            server: connectionResources.recordExecutionServerCheck(server.id, {
              fingerprint: server.hostFingerprint,
              capabilities: {
                dockerVersion: docker.stdout.trim(),
                composeVersion: compose.stdout.trim(),
                platform: platform.stdout.trim(),
                disk: disk.stdout.slice(0, 8192),
              },
            }),
          };
        } finally {
          await adapter.close();
        }
      },
    );
    routes.post('/api/connection-resources/servers', async (request, reply) =>
      reply.status(201).send({
        server: connectionResources.createExecutionServer(readRecord(request.body)),
      }),
    );
    routes.put<{ Params: { id: string } }>(
      '/api/connection-resources/servers/:id',
      async (request) => ({
        server: connectionResources.updateExecutionServer(
          request.params.id,
          readRecord(request.body),
        ),
      }),
    );
    routes.delete<{ Params: { id: string } }>(
      '/api/connection-resources/servers/:id',
      async (request) => {
        connectionResources.deleteExecutionServer(request.params.id);
        return { deleted: true };
      },
    );

    routes.post('/api/projects', async (request, reply) => {
      const body = readRecord(request.body);
      if (
        typeof body.displayName !== 'string' ||
        typeof body.repositoryUrl !== 'string' ||
        (body.gitToken !== undefined &&
          (typeof body.gitToken !== 'string' || body.gitToken.length === 0)) ||
        (body.githubCredentialId !== undefined && typeof body.githubCredentialId !== 'string') ||
        (body.executionServerId !== undefined && typeof body.executionServerId !== 'string') ||
        (body.newGithubCredential !== undefined &&
          !isNewGithubCredential(body.newGithubCredential)) ||
        Object.keys(body).some(
          (key) =>
            ![
              'displayName',
              'repositoryUrl',
              'gitToken',
              'githubCredentialId',
              'newGithubCredential',
              'executionServerId',
            ].includes(key),
        ) ||
        [body.gitToken, body.githubCredentialId, body.newGithubCredential].filter(
          (value) => value !== undefined,
        ).length > 1
      ) {
        throw new AppError('PROJECT_INPUT_INVALID', '项目名称、仓库地址或凭据无效', 400);
      }
      parseGitHubRepository(body.repositoryUrl);
      const newCredential = body.newGithubCredential as { name: string; token: string } | undefined;
      const token =
        (body.gitToken as string | undefined) ??
        newCredential?.token ??
        (body.githubCredentialId
          ? connectionResources.githubToken(body.githubCredentialId as string)
          : undefined);
      let repository: VerifiedGitHubRepositoryIdentity;
      try {
        repository = await verifyRepository(body.repositoryUrl, token);
      } catch (error) {
        throw new RepositoryError(
          'REPOSITORY_INVALID',
          describeGitHubRepositoryFailure(error),
          502,
        );
      }
      const project = options.database.transaction(() => {
        const credentialId = newCredential
          ? connectionResources.createGithubCredential(newCredential).id
          : (body.githubCredentialId as string | undefined);
        const created = options.projects.createVerified({
          displayName: body.displayName as string,
          repository,
        });
        options.configuration.update(created.projectId, {
          language: options.deployment.getHarness().language,
        });
        if (token) secrets.project(created.projectId).set('gitToken', token);
        if (credentialId || body.executionServerId) {
          connectionResources.bindProject(created.projectId, {
            githubCredentialId: credentialId ?? null,
            executionServerId: (body.executionServerId as string | undefined) ?? null,
          });
          if (credentialId) secrets.project(created.projectId).delete('gitToken');
        }
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
        resources: connectionResources.bindings(project.projectId),
        managedFiles: connectionResources.listProjectFiles(project.projectId),
        environmentRecommendation: readEnvironmentRecommendation(
          options.database,
          project.projectId,
          options.configuration.get(project.projectId).generatedDefinition,
        ),
      };
    });

    routes.put<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/resources',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const resources = connectionResources.bindProject(
          project.projectId,
          readResourceBindings(request.body),
        );
        invalidateProjectReadiness(options.database, project.projectId);
        return { resources };
      },
    );

    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/files',
      async (request) => ({
        files: connectionResources.listProjectFiles(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
      }),
    );
    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/files',
      async (request, reply) => {
        const project = requireProject(options.projects, request.params.projectId);
        const file = connectionResources.createProjectFile(
          project.projectId,
          readRecord(request.body) as {
            path: unknown;
            content?: unknown;
            encodedContent?: unknown;
            purpose?: unknown;
            serviceName?: unknown;
          },
        );
        return reply.status(201).send({ file });
      },
    );
    routes.put<{ Params: { projectId: string; fileId: string } }>(
      '/api/projects/:projectId/files/:fileId',
      async (request) => ({
        file: connectionResources.updateProjectFile(
          requireProject(options.projects, request.params.projectId).projectId,
          request.params.fileId,
          readRecord(request.body),
        ),
      }),
    );
    routes.delete<{ Params: { projectId: string; fileId: string } }>(
      '/api/projects/:projectId/files/:fileId',
      async (request) => {
        connectionResources.deleteProjectFile(
          requireProject(options.projects, request.params.projectId).projectId,
          request.params.fileId,
        );
        return { deleted: true };
      },
    );

    routes.put<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/profile',
      async (request) => {
        requireProject(options.projects, request.params.projectId);
        const body = readRecord(request.body);
        if (Object.keys(body).length !== 1 || typeof body.displayName !== 'string') {
          throw new AppError('PROJECT_INPUT_INVALID', '项目名称无效', 400);
        }
        return {
          project: options.projects.rename(request.params.projectId, body.displayName),
        };
      },
    );

    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/readiness',
      async (request) =>
        options.readiness.check(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
    );

    routes.get<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/readiness/status',
      async (request) => ({
        readiness: options.readiness.latest(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
      }),
    );

    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/readiness/check',
      async (request) => ({
        readiness: await options.readiness.check(
          requireProject(options.projects, request.params.projectId).projectId,
        ),
      }),
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

    routes.post<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/image/prepare',
      async (request) => {
        if (request.body !== undefined && Object.keys(readRecord(request.body)).length !== 0) {
          throw new AppError('IMAGE_INPUT_INVALID', '镜像准备不接受自选提交或路径', 400);
        }
        const project = requireProject(options.projects, request.params.projectId);
        const image = await options.images.prepare(project.projectId);
        invalidateProjectReadiness(options.database, project.projectId, ['image']);
        return { image };
      },
    );

    routes.put<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/configuration',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const configuration = options.configuration.update(project.projectId, request.body);
        invalidateProjectReadiness(options.database, project.projectId);
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
        invalidateProjectReadiness(options.database, project.projectId);
        return { key, metadata: store.metadata()[key] };
      },
    );

    routes.put<{ Params: { projectId: string } }>(
      '/api/projects/:projectId/test-account',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const body = readRecord(request.body);
        const keys = ['testUsername', 'testPassword'] as const;
        if (
          Object.keys(body).some((key) => !keys.includes(key as (typeof keys)[number])) ||
          keys.some((key) => key in body && typeof body[key] !== 'string') ||
          !keys.some((key) => typeof body[key] === 'string' && body[key])
        ) {
          throw new AppError('SECRET_INPUT_INVALID', '测试账号值无效', 400);
        }
        const store = secrets.project(project.projectId);
        options.database.transaction(() => {
          for (const key of keys) {
            const value = body[key];
            if (typeof value === 'string' && value) store.set(key, value);
          }
          invalidateProjectReadiness(options.database, project.projectId);
        })();
        const metadata = store.metadata();
        return {
          secrets: { testUsername: metadata.testUsername, testPassword: metadata.testPassword },
        };
      },
    );

    routes.delete<{ Params: { projectId: string; key: string } }>(
      '/api/projects/:projectId/secrets/:key',
      async (request) => {
        const project = requireProject(options.projects, request.params.projectId);
        const key = readProjectSecretKey(request.params.key);
        const store = secrets.project(project.projectId);
        store.delete(key);
        invalidateProjectReadiness(options.database, project.projectId);
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
          : error instanceof ProjectImageAdminError
            ? error.code === 'DOCKER_UNAVAILABLE' || error.code === 'TARGET_UNAVAILABLE'
              ? 503
              : error.code === 'BUILD_FAILED'
                ? 502
                : 409
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
        error instanceof ProjectImageAdminError ||
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

function readGithubCredential(value: unknown): { name: unknown; token: unknown } {
  const body = readRecord(value);
  if (Object.keys(body).some((key) => !['name', 'token'].includes(key))) {
    throw new AppError('CONNECTION_INPUT_INVALID', 'GitHub Token 配置包含未知字段', 400);
  }
  return { name: body.name, token: body.token };
}

function isNewGithubCredential(value: unknown): value is { name: string; token: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.name === 'string' &&
    typeof body.token === 'string' &&
    body.name.length > 0 &&
    body.token.length > 0
  );
}

function readResourceBindings(value: unknown): {
  githubCredentialId?: string | null;
  executionServerId?: string | null;
} {
  const body = readRecord(value);
  if (
    Object.keys(body).length === 0 ||
    Object.keys(body).some((key) => !['githubCredentialId', 'executionServerId'].includes(key)) ||
    [body.githubCredentialId, body.executionServerId].some(
      (resourceId) =>
        resourceId !== undefined && resourceId !== null && typeof resourceId !== 'string',
    )
  ) {
    throw new AppError('CONNECTION_INPUT_INVALID', '项目连接资源配置无效', 400);
  }
  return body;
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
