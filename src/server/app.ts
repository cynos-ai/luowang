import { existsSync } from 'node:fs';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type {
  ConfigResponse,
  HealthResponse,
  RepositoryHistoryResponse,
  RepositoryStatusResponse,
} from '../shared/types.js';
import { createConfigurationStore, type ConfigurationStore } from './configuration.js';
import { createConnectivityRegistry, type ConnectivityRegistry } from './connectivity.js';
import type { AppConfig } from './config.js';
import type { DatabaseContext } from './db/client.js';
import { AppError, toErrorResponse } from './errors.js';
import { createLogger } from './logger.js';
import {
  AuthError,
  createAuthService,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  validatePassword,
  type AuthService,
} from './security/auth.js';
import { LoginRateLimiter } from './security/rate-limit.js';
import {
  createSecretStore,
  isSecretKey,
  SecretStoreError,
  SECRET_KEYS,
  type SecretStore,
} from './security/secret-store.js';
import { createRepositoryIndexer, type RepositoryIndexer } from './repository/indexer.js';
import { RepositoryError } from './repository/errors.js';
import {
  createRepositoryService,
  type RepositoryService,
  validateRepositoryUrl,
} from './repository/service.js';

export interface AppOptions {
  config: AppConfig;
  database: DatabaseContext;
  logger?: Logger;
  auth?: AuthService;
  secretStore?: SecretStore;
  configuration?: ConfigurationStore;
  connectivity?: ConnectivityRegistry;
  repository?: RepositoryService;
  indexer?: RepositoryIndexer;
}

interface JsonRecord {
  [key: string]: unknown;
}

export async function createApp(options: AppOptions) {
  const auth =
    options.auth ??
    (await createAuthService(options.database.sqlite, options.config.initialAdminPassword));
  const secretStore =
    options.secretStore ?? createSecretStore(options.database.sqlite, options.config.masterKey);
  const configuration =
    options.configuration ??
    createConfigurationStore(options.database.sqlite, {
      repoDir: options.config.repoDir,
      reportDir: options.config.reportDir,
    });
  const repository =
    options.repository ??
    createRepositoryService(options.database.sqlite, configuration, secretStore, {
      repoDir: options.config.repoDir,
    });
  const indexer = options.indexer ?? createRepositoryIndexer(options.database.sqlite, repository);
  const connectivity =
    options.connectivity ??
    createConnectivityRegistry(options.database.sqlite, configuration, repository);

  // Do not retain the bootstrap password or raw master-key string in the shared config object.
  options.config.initialAdminPassword = undefined;
  options.config.masterKey = undefined;

  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(options.config),
    requestIdHeader: 'x-request-id',
  });
  const staticRoot = options.config.webRoot;
  const loginLimiter = new LoginRateLimiter();

  await app.register(fastifyCookie);

  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: 'index.html',
    });
  }

  app.addHook('preHandler', async (request) => {
    if (
      isWriteMethod(request.method) &&
      request.url.startsWith('/api/') &&
      !isAllowedOrigin(request, options.config.allowedOrigin)
    ) {
      throw new AppError('ORIGIN_FORBIDDEN', '请求来源未被允许', 403);
    }
  });

  app.get('/health', async (request, reply) => {
    const health = makeHealth(options.config, options.database);
    reply.header('x-request-id', request.id);
    return reply.status(health.status === 'ok' ? 200 : 503).send(health);
  });

  app.get('/api/status', async (request, reply) => {
    reply.header('x-request-id', request.id);
    return reply.send(makeHealth(options.config, options.database));
  });

  app.get('/api/auth/status', async (request, reply) => {
    reply.header('x-request-id', request.id);
    return reply.send({
      configured: auth.isConfigured(),
      authenticated: auth.authenticate(request.cookies[SESSION_COOKIE_NAME]),
    });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = readBody(request);
    const password = body.password;
    if (typeof password !== 'string') {
      throw new AppError('PASSWORD_REQUIRED', '请输入管理员密码', 400);
    }

    const rateKey = request.ip || 'unknown';
    const decision = loginLimiter.check(rateKey);
    if (!decision.allowed) {
      reply.header('retry-after', String(decision.retryAfterSeconds));
      throw new AppError('LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试', 429);
    }

    const token = await auth.login(password);
    if (!token) {
      loginLimiter.recordFailure(rateKey);
      throw new AppError('INVALID_CREDENTIALS', '管理员密码不正确', 401);
    }

    loginLimiter.reset(rateKey);
    setSessionCookie(request, reply, token);
    return reply.send({ authenticated: true });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE_NAME]);
    clearSessionCookie(request, reply);
    return reply.send({ authenticated: false });
  });

  app.post('/api/auth/password', async (request, reply) => {
    const token = requireAuth(request, auth);
    const body = readBody(request);
    if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
      throw new AppError('PASSWORD_REQUIRED', '当前密码和新密码均为必填项', 400);
    }
    validatePassword(body.newPassword);
    const changed = await auth.changePassword(token, body.currentPassword, body.newPassword);
    if (!changed) {
      throw new AppError('INVALID_CURRENT_PASSWORD', '当前管理员密码不正确', 401);
    }

    clearSessionCookie(request, reply);
    return reply.send({ authenticated: false, passwordChanged: true });
  });

  app.get('/api/config', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    updateConfiguration(body, configuration, secretStore);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config/harness', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    applySecretValues(body.secrets, secretStore);
    configuration.updateHarness(body);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config/repository', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    applySecretValues(body.secrets, secretStore);
    if (body.repository !== undefined && typeof body.repository === 'string') {
      validateRepositoryUrl(body.repository);
    }
    configuration.updateRepository(body);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.get('/api/repository/status', async (request, reply) => {
    requireAuth(request, auth);
    const status: RepositoryStatusResponse = await repository.getStatus();
    return reply.send(status);
  });

  app.post('/api/repository/sync', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(await indexer.sync());
  });

  app.post('/api/repository/scenario-branch', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    const initialRef = body.initialRef;
    if (initialRef !== undefined && typeof initialRef !== 'string') {
      throw new AppError('INVALID_REQUEST', 'initialRef 必须是字符串', 400);
    }
    return reply.send(await repository.ensureScenarioBranch(initialRef));
  });

  app.post('/api/repository/merge', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    if (typeof body.sourceRef !== 'string' || body.sourceRef.trim() === '') {
      throw new AppError('INVALID_REQUEST', 'sourceRef 必须是非空字符串', 400);
    }
    if (typeof body.confirmed !== 'boolean') {
      throw new AppError('MERGE_CONFIRMATION_REQUIRED', '需要明确确认后才能合并', 400);
    }
    return reply.send(await repository.mergeSourceRef(body.sourceRef, body.confirmed));
  });

  app.get('/api/repository/tree', async (request, reply) => {
    requireAuth(request, auth);
    const commit = readOptionalQuery(request, 'commit');
    const target = commit ?? (await repository.getStatus()).remoteHead;
    if (!target) {
      throw new RepositoryError('SCENARIO_BRANCH_NOT_FOUND', '场景测试分支尚未创建', 409);
    }
    return reply.send({ commit: target, entries: await repository.listTree(target) });
  });

  app.get('/api/repository/history', async (request, reply) => {
    requireAuth(request, auth);
    const commit = readOptionalQuery(request, 'commit');
    const status = await repository.getStatus();
    const target = commit ?? status.remoteHead;
    if (!target) {
      throw new RepositoryError('SCENARIO_BRANCH_NOT_FOUND', '场景测试分支尚未创建', 409);
    }
    const git = await repository.getRepository();
    return reply.send({ commit: target, entries: await git.history(target) });
  });

  app.get('/api/scenarios', async (request, reply) => {
    requireAuth(request, auth);
    const status = readOptionalQuery(request, 'status');
    const tag = readOptionalQuery(request, 'tag');
    if (status !== undefined && !['draft', 'approved', 'deprecated'].includes(status)) {
      throw new AppError('INVALID_REQUEST', 'status 筛选值无效', 400);
    }
    return reply.send({
      scenarios: indexer.listScenarios({
        status: status as 'draft' | 'approved' | 'deprecated' | undefined,
        tag,
      }),
    });
  });

  app.get('/api/scenarios/:scenarioId', async (request, reply) => {
    requireAuth(request, auth);
    const scenario = indexer.getScenario(readParam(request, 'scenarioId'));
    if (!scenario) throw new AppError('SCENARIO_NOT_FOUND', '场景不存在或尚未索引', 404);
    return reply.send({ scenario });
  });

  app.get('/api/reports', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ reports: indexer.listReports() });
  });

  app.get('/api/reports/:runId', async (request, reply) => {
    requireAuth(request, auth);
    const report = indexer.getReport(readParam(request, 'runId'));
    if (!report) throw new AppError('REPORT_NOT_FOUND', '报告不存在或尚未索引', 404);
    return reply.send({ report });
  });

  app.get('/api/history', async (request, reply) => {
    requireAuth(request, auth);
    const status = await repository.getStatus();
    const reports = indexer.listReports();
    if (!status.configured) {
      const response: RepositoryHistoryResponse = {
        status: 'not_configured',
        reports,
        issues: [],
        issuesAvailable: false,
        issuesMessage: '目标 GitHub 仓库尚未配置',
      };
      return reply.send(response);
    }
    let issues = [] as RepositoryHistoryResponse['issues'];
    let issuesAvailable = true;
    let issuesMessage: string | null = null;
    try {
      issues = await repository.listIssues();
    } catch {
      issuesAvailable = false;
      issuesMessage = 'GitHub Issues 暂时不可用；已保留本地索引历史';
    }
    if (status.availability === 'unavailable') {
      issuesMessage = status.errorMessage ?? '目标仓库索引暂时不可用；已保留本地历史';
    }
    const response: RepositoryHistoryResponse = {
      status: status.availability === 'unavailable' || !issuesAvailable ? 'degraded' : 'ok',
      reports,
      issues,
      issuesAvailable,
      issuesMessage,
    };
    return reply.send(response);
  });

  app.get('/api/secrets', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ secrets: secretStore.metadata() });
  });

  app.delete('/api/secrets/:key', async (request, reply) => {
    requireAuth(request, auth);
    const key = readParam(request, 'key');
    if (!isSecretKey(key)) {
      throw new AppError('SECRET_KEY_INVALID', '不支持的 Secret 项', 400);
    }
    secretStore.delete(key);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.get('/api/connectivity/checks', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ checks: connectivity.list() });
  });

  app.get('/api/connectivity', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ checks: connectivity.list() });
  });

  app.post('/api/connectivity/checks/:checkId', async (request, reply) => {
    requireAuth(request, auth);
    const check = await connectivity.run(readParam(request, 'checkId'));
    if (!check.available) {
      return reply.status(501).send(check);
    }
    return reply.send(check);
  });

  app.post('/api/connectivity/:checkId', async (request, reply) => {
    requireAuth(request, auth);
    const check = await connectivity.run(readParam(request, 'checkId'));
    if (!check.available) {
      return reply.status(501).send(check);
    }
    return reply.send(check);
  });

  app.post('/api/config/repository/check', async (request, reply) => {
    requireAuth(request, auth);
    const check = await connectivity.run('test-environment-url');
    return reply.send(check);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/') && existsSync(staticRoot)) {
      return reply.sendFile('index.html');
    }

    reply.header('x-request-id', request.id);
    return reply.status(404).send(toErrorResponse('NOT_FOUND', 'Resource not found', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const possibleError = error as { statusCode?: unknown; name?: unknown; message?: unknown };
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : error instanceof SecretStoreError
          ? 503
          : error instanceof RepositoryError
            ? error.statusCode
            : error instanceof AuthError || possibleError.name === 'ConfigurationError'
              ? 400
              : typeof possibleError.statusCode === 'number'
                ? possibleError.statusCode
                : 500;
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof SecretStoreError
          ? 'SECRET_STORE_UNAVAILABLE'
          : error instanceof RepositoryError
            ? error.code
            : error instanceof AuthError
              ? error.code
              : possibleError.name === 'ConfigurationError'
                ? 'CONFIGURATION_INVALID'
                : statusCode === 400
                  ? 'BAD_REQUEST'
                  : 'INTERNAL_ERROR';
    const message =
      error instanceof AppError ||
      error instanceof RepositoryError ||
      error instanceof AuthError ||
      possibleError.name === 'ConfigurationError'
        ? typeof possibleError.message === 'string'
          ? possibleError.message
          : 'Request failed'
        : error instanceof SecretStoreError
          ? 'Secret Store 当前不可用'
          : statusCode < 500 && typeof possibleError.message === 'string'
            ? possibleError.message
            : 'Internal server error';

    request.log.error(
      {
        requestId: request.id,
        errorCode: code,
        errorName: typeof possibleError.name === 'string' ? possibleError.name : 'UnknownError',
        statusCode,
      },
      'request failed',
    );
    reply.header('x-request-id', request.id);
    return reply.status(statusCode).send(toErrorResponse(code, message, request.id));
  });

  app.addHook('onClose', async () => {
    options.database.close();
  });

  return app;
}

function makeHealth(config: AppConfig, database: DatabaseContext): HealthResponse {
  const databaseIsHealthy = database.isHealthy();
  return {
    status: databaseIsHealthy ? 'ok' : 'degraded',
    service: 'luowang',
    version: config.version,
    database: databaseIsHealthy ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  };
}

function makeConfigResponse(
  configuration: ConfigurationStore,
  secretStore: SecretStore,
): ConfigResponse {
  return {
    harness: configuration.getHarness(),
    repository: configuration.getRepository(),
    secrets: secretStore.metadata(),
    secretStore: { available: secretStore.isAvailable() },
  };
}

function updateConfiguration(
  body: JsonRecord,
  configuration: ConfigurationStore,
  secretStore: SecretStore,
): void {
  let updated = false;
  if (body.harness !== undefined) {
    const harness = readRecord(body.harness, 'harness must be an object');
    applySecretValues(harness.secrets, secretStore);
    configuration.updateHarness(harness);
    updated = true;
  }
  if (body.repository !== undefined) {
    const repository = readRecord(body.repository, 'repository must be an object');
    applySecretValues(repository.secrets, secretStore);
    if (repository.repository !== undefined && typeof repository.repository === 'string') {
      validateRepositoryUrl(repository.repository);
    }
    configuration.updateRepository(repository);
    updated = true;
  }
  applySecretValues(body.secrets, secretStore);
  if (!updated && body.secrets === undefined) {
    throw new AppError('CONFIGURATION_REQUIRED', '至少提供一组配置', 400);
  }
}

function applySecretValues(value: unknown, secretStore: SecretStore): void {
  if (value === undefined) {
    return;
  }
  const secrets = readRecord(value, 'secrets must be an object');
  for (const key of SECRET_KEYS) {
    const candidate = secrets[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      secretStore.set(key, candidate);
    }
  }
}

function requireAuth(request: FastifyRequest, auth: AuthService): string {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!auth.authenticate(token)) {
    throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
  }
  return token as string;
}

function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(request));
}

function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { ...sessionCookieOptions(request), maxAge: 0 });
}

function sessionCookieOptions(request: FastifyRequest): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: isHttpsRequest(request),
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

function isHttpsRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const firstForwardedProto =
    typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined;
  return request.protocol === 'https' || firstForwardedProto === 'https';
}

function isAllowedOrigin(request: FastifyRequest, configuredOrigin: string | undefined): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  if (configuredOrigin) {
    return origin === configuredOrigin;
  }

  const protocol = isHttpsRequest(request) ? 'https' : 'http';
  const host = request.headers.host;
  return typeof host === 'string' && origin === `${protocol}://${host}`;
}

function isWriteMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function readBody(request: FastifyRequest): JsonRecord {
  return readRecord(request.body, '请求体必须是 JSON 对象');
}

function readRecord(value: unknown, message: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_REQUEST', message, 400);
  }
  return value as JsonRecord;
}

function readParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_REQUEST', '请求参数无效', 400);
  }
  return value;
}

function readOptionalQuery(request: FastifyRequest, name: string): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_REQUEST', '查询参数无效', 400);
  }
  return value;
}
