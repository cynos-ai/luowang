import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyBaseLogger, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import {
  createProjectAutomationDispatcher,
  type ProjectAutomationDispatcher,
} from '../automation/project-dispatcher.js';
import { TestRequestQueueError } from '../automation/queue.js';
import type { DatabaseContext } from '../db/client.js';
import { AppError, toErrorResponse } from '../errors.js';
import { createLogger } from '../logger.js';
import {
  AuthError,
  createAuthService,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  validatePassword,
  type AuthService,
} from '../security/auth.js';
import { createAdminProfileStore } from '../security/admin-profile.js';
import { LoginRateLimiter } from '../security/rate-limit.js';
import {
  createScopedSecretStore,
  type ScopedSecretStore,
  type DeploymentSecretKey,
} from '../security/scoped-secret-store.js';
import { SecretStoreError } from '../security/secret-store.js';
import { registerProjectAdminRoutes, type ProjectAdminRouteOptions } from './admin-routes.js';
import { createProjectConfigurationStore } from './configuration.js';
import { ConfigurationError } from '../configuration.js';
import { createDeploymentConfigurationStore } from './deployment-configuration.js';
import { createGuardedScopedSecretStore } from './guarded-secrets.js';
import { createProjectImageAdminService, type ProjectImageAdminService } from './image-admin.js';
import { createLiveProjectReadinessAdapters } from './readiness-adapters.js';
import { createProjectReadinessService, type ProjectReadinessDependencies } from './readiness.js';
import { registerProjectRunRoutes } from './run-routes.js';
import { assertProjectSchema } from './schema-mode.js';
import { createProjectStore } from './store.js';

export interface ProjectAppOptions {
  config: AppConfig;
  database: DatabaseContext;
  logger?: Logger;
  auth?: AuthService;
  secrets?: ScopedSecretStore;
  readinessDependencies?: ProjectReadinessDependencies;
  images?: ProjectImageAdminService;
  dispatcher?: ProjectAutomationDispatcher;
  verifyRepository?: ProjectAdminRouteOptions['verifyRepository'];
}

/** New-schema project app. Background scheduling and remaining project views precede startup cutover. */
export async function createProjectApp(options: ProjectAppOptions) {
  const database = options.database.sqlite;
  assertProjectSchema(database);
  const auth =
    options.auth ?? (await createAuthService(database, options.config.initialAdminPassword));
  const scoped = options.secrets ?? createScopedSecretStore(database, options.config.masterKey);
  const guarded = createGuardedScopedSecretStore(database, scoped);
  const deployment = createDeploymentConfigurationStore(database, options.config);
  const projects = createProjectStore(database);
  const configuration = createProjectConfigurationStore(database);
  const profile = createAdminProfileStore(database);
  const readiness = createProjectReadinessService({
    database,
    projects,
    configuration,
    secrets: scoped,
    dependencies:
      options.readinessDependencies ??
      createLiveProjectReadinessAdapters({
        database,
        deployment,
        configuration,
        secrets: scoped,
        repoRoot: options.config.repoDir,
      }),
  });
  const images =
    options.images ??
    createProjectImageAdminService({
      database,
      projects,
      configuration,
      secrets: scoped,
      repoRoot: options.config.repoDir,
      storageRoot: options.config.dataDir,
    });
  const dispatcher =
    options.dispatcher ??
    createProjectAutomationDispatcher({
      database,
      deployment,
      projects,
      secrets: scoped,
      repoRoot: options.config.repoDir,
      reportRoot: options.config.reportDir,
      storageRoot: options.config.dataDir,
      logger: options.logger,
    });
  options.config.initialAdminPassword = undefined;
  options.config.masterKey = undefined;

  const app = Fastify({
    loggerInstance: (options.logger ?? createLogger(options.config)) as FastifyBaseLogger,
  });
  const limiter = new LoginRateLimiter();
  await app.register(fastifyCookie);
  app.setErrorHandler((error, request, reply) => {
    const failure = error as Error & { statusCode?: number };
    const status =
      error instanceof AppError
        ? error.statusCode
        : error instanceof SecretStoreError
          ? 503
          : error instanceof TestRequestQueueError
            ? error.code === 'QUEUE_NOT_FOUND'
              ? 404
              : error.code === 'QUEUE_STATE_INVALID'
                ? 409
                : 400
            : error instanceof TypeError ||
                error instanceof AuthError ||
                error instanceof ConfigurationError
              ? 400
              : typeof failure.statusCode === 'number'
                ? failure.statusCode
                : 500;
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof SecretStoreError
          ? 'SECRET_STORE_UNAVAILABLE'
          : error instanceof TestRequestQueueError
            ? error.code
            : error instanceof AuthError
              ? error.code
              : status === 400
                ? 'INVALID_REQUEST'
                : 'INTERNAL_ERROR';
    const message = status >= 500 ? '内部错误' : failure.message;
    return reply.status(status).send(toErrorResponse(code, message, request.id));
  });

  app.addHook('preHandler', async (request) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.url.startsWith('/api/') &&
      !allowedOrigin(request, options.config.allowedOrigin)
    ) {
      throw new AppError('ORIGIN_FORBIDDEN', '请求来源未被允许', 403);
    }
  });
  app.get('/health', async () => ({
    status: options.database.isHealthy() ? 'ok' : 'degraded',
    service: 'luowang',
    version: options.config.version,
    database: options.database.isHealthy() ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  }));
  app.get('/api/auth/status', async (request) => ({
    configured: auth.isConfigured(),
    authenticated: auth.authenticate(request.cookies[SESSION_COOKIE_NAME]),
  }));
  app.post('/api/auth/login', async (request, reply) => {
    const body = readBody(request);
    if (typeof body.password !== 'string')
      throw new AppError('PASSWORD_REQUIRED', '请输入管理员密码', 400);
    const key = request.ip || 'unknown';
    const decision = limiter.check(key);
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      throw new AppError('LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试', 429);
    }
    const token = await auth.login(body.password);
    if (!token) {
      limiter.recordFailure(key);
      throw new AppError('INVALID_CREDENTIALS', '管理员密码不正确', 401);
    }
    limiter.reset(key);
    reply.setCookie(SESSION_COOKIE_NAME, token, cookieOptions(request));
    return { authenticated: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE_NAME]);
    reply.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions(request), maxAge: 0 });
    return { authenticated: false };
  });
  app.post('/api/auth/password', async (request, reply) => {
    const token = requireAuth(request, auth);
    const body = readBody(request);
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      throw new AppError('PASSWORD_REQUIRED', '当前密码和新密码均为必填项', 400);
    }
    validatePassword(body.newPassword);
    if (!(await auth.changePassword(token, body.currentPassword, body.newPassword))) {
      throw new AppError('INVALID_CURRENT_PASSWORD', '当前管理员密码不正确', 401);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { ...cookieOptions(request), maxAge: 0 });
    return { authenticated: false, passwordChanged: true };
  });
  app.get('/api/account', async (request) => {
    requireAuth(request, auth);
    return { profile: profile.get() };
  });
  app.put('/api/account', async (request) => {
    requireAuth(request, auth);
    const body = readBody(request);
    if (Object.keys(body).length !== 1)
      throw new AppError('ACCOUNT_INPUT_INVALID', '账号资料字段无效', 400);
    return { profile: profile.updateDisplayName(body.displayName) };
  });
  app.get('/api/deployment', async (request) => {
    requireAuth(request, auth);
    return { configuration: deployment.getHarness(), secrets: guarded.deployment().metadata() };
  });
  app.put('/api/deployment', async (request) => {
    requireAuth(request, auth);
    return { configuration: deployment.updateHarness(readBody(request)) };
  });
  app.put<{ Params: { key: string } }>('/api/deployment/secrets/:key', async (request) => {
    requireAuth(request, auth);
    const key = deploymentSecretKey(request.params.key);
    const body = readBody(request);
    if (Object.keys(body).length !== 1 || typeof body.value !== 'string' || !body.value) {
      throw new AppError('SECRET_INPUT_INVALID', '凭据值无效', 400);
    }
    guarded.deployment().set(key, body.value);
    return { key, metadata: guarded.deployment().metadata()[key] };
  });
  app.delete<{ Params: { key: string } }>('/api/deployment/secrets/:key', async (request) => {
    requireAuth(request, auth);
    const key = deploymentSecretKey(request.params.key);
    guarded.deployment().delete(key);
    return { key, metadata: guarded.deployment().metadata()[key] };
  });

  await registerProjectAdminRoutes(app, {
    database,
    auth,
    deployment,
    projects,
    configuration,
    secrets: scoped,
    readiness,
    images,
    allowedOrigin: options.config.allowedOrigin,
    verifyRepository: options.verifyRepository,
  });
  await registerProjectRunRoutes(app, {
    database,
    auth,
    projects,
    dispatcher,
    logger: options.logger,
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(toErrorResponse('NOT_FOUND', 'Resource not found', request.id)),
  );
  app.addHook('onClose', async () => options.database.close());
  return app;
}

function readBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('INVALID_REQUEST', '请求体必须是 JSON 对象', 400);
  }
  return request.body as Record<string, unknown>;
}

function requireAuth(request: FastifyRequest, auth: AuthService): string {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!auth.authenticate(token)) throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
  return token as string;
}

function cookieOptions(request: FastifyRequest): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  const forwarded = request.headers['x-forwarded-proto'];
  return {
    httpOnly: true,
    secure:
      request.protocol === 'https' ||
      (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim() === 'https'),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

function allowedOrigin(request: FastifyRequest, configured: string | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configured) return origin === configured;
  const protocol = cookieOptions(request).secure ? 'https' : 'http';
  return (
    typeof request.headers.host === 'string' && origin === `${protocol}://${request.headers.host}`
  );
}

function deploymentSecretKey(key: string): DeploymentSecretKey {
  if (key !== 'providerApiKey' && key !== 'ossAccessKeyId' && key !== 'ossAccessKeySecret') {
    throw new AppError('SECRET_KEY_INVALID', '部署凭据类型无效', 400);
  }
  return key;
}
