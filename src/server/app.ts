import { existsSync } from 'node:fs';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type {
  ConfigResponse,
  HealthResponse,
  OperationsDashboardResponse,
  RepositoryHistoryResponse,
  RepositoryStatusResponse,
} from '../shared/types.js';
import {
  createAutomationScheduler,
  createAutomationService,
  AutomationServiceError,
  type AutomationScheduler,
  type AutomationService,
  type AutomationSubmission,
} from './automation/index.js';
import { TestRequestQueueError } from './automation/queue.js';
import { createRunRecoveryStore, type RunRecoveryStore } from './automation/recovery.js';
import { createGitPoller } from './automation/poller.js';
import { createConfigurationStore, type ConfigurationStore } from './configuration.js';
import { exportConfigurationYaml, parseConfigurationYaml } from './config-transfer.js';
import { createConnectivityRegistry, type ConnectivityRegistry } from './connectivity.js';
import { createPlaywrightMcpAdapter, type BrowserMcpAdapter } from './browser/playwright-mcp.js';
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
import { createOssAdapter, OssError, type OssAdapter } from './storage/oss.js';
import {
  createRepositoryService,
  type RepositoryService,
  validateRepositoryUrl,
} from './repository/service.js';
import { createProviderAdapter, type ProviderAdapter } from './runs/provider.js';
import {
  createRunOrchestrator,
  RunOrchestratorError,
  type RunOrchestrator,
} from './runs/orchestrator.js';
import { createRunArchiver, type RunArchiver } from './runs/archiver.js';
import { createRunStore, type RunStore } from './runs/store.js';
import { createOperationsService, type OperationsService } from './operations/service.js';

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
  provider?: ProviderAdapter;
  runs?: RunOrchestrator;
  runStore?: RunStore;
  archiver?: RunArchiver;
  recoveryStore?: RunRecoveryStore;
  automation?: AutomationService;
  scheduler?: AutomationScheduler;
  operations?: OperationsService;
  backgroundTasks?: boolean;
  browser?: BrowserMcpAdapter;
  oss?: OssAdapter;
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
  const provider = options.provider ?? createProviderAdapter(configuration, secretStore);
  const browser = options.browser ?? createPlaywrightMcpAdapter(configuration);
  const oss = options.oss ?? createOssAdapter(configuration, secretStore);
  const runStore = options.runStore ?? createRunStore(options.database.sqlite);
  const recoveryStore = options.recoveryStore ?? createRunRecoveryStore(options.database.sqlite);
  const archiver =
    options.archiver ??
    createRunArchiver({
      database: options.database.sqlite,
      reportDir: configuration.getHarness().local.reportDir,
      repository,
      indexer,
      runStore,
    });
  const connectivity =
    options.connectivity ??
    createConnectivityRegistry(
      options.database.sqlite,
      configuration,
      repository,
      provider,
      browser,
      oss,
    );
  const runs =
    options.runs ??
    createRunOrchestrator({
      configuration,
      repository,
      indexer,
      reportDir: configuration.getHarness().local.reportDir,
      secretStore,
      provider,
      browser,
      oss,
      runStore,
      recoveryStore,
    });
  const automation =
    options.automation ??
    createAutomationService({
      database: options.database.sqlite,
      configuration,
      repository,
      indexer,
      runs,
      archiver,
      runStore,
      recoveryStore,
      reportDir: configuration.getHarness().local.reportDir,
    });
  const scheduler =
    options.scheduler ??
    createAutomationScheduler({
      configuration,
      poller: createGitPoller({
        configuration,
        repository,
        submitter: automation,
        state: automation.state(),
        runStore,
      }),
      automation,
      indexer,
      state: automation.state(),
      logger: options.logger,
    });
  const operations =
    options.operations ??
    createOperationsService({
      database: options.database.sqlite,
      databaseContext: options.database,
      configuration,
      connectivity,
      repository,
      indexer,
      runs,
      runStore,
      recoveryStore,
      automation,
      scheduler,
      reportDir: configuration.getHarness().local.reportDir,
    });
  await automation.recover();

  // Do not retain the bootstrap password or raw master-key string in the shared config object.
  options.config.initialAdminPassword = undefined;
  options.config.masterKey = undefined;

  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(options.config),
    requestIdHeader: 'x-request-id',
    // Private evidence IDs encode an allowlisted OSS prefix, Run ID, and filename.
    // Fastify's 100-character default would reject these valid stable URLs at routing time.
    routerOptions: { maxParamLength: 2048 },
  });
  const staticRoot = options.config.webRoot;
  const loginLimiter = new LoginRateLimiter();

  await app.register(fastifyCookie);

  if (options.backgroundTasks ?? options.config.environment !== 'test') {
    scheduler.start();
  }

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

  app.get('/api/config/export', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({
      fileName: 'luowang-config.yml',
      yaml: exportConfigurationYaml({
        harness: configuration.getHarness(),
        repository: configuration.getRepository(),
      }),
    });
  });

  app.post('/api/config/import', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    const imported = parseConfigurationYaml(body.yaml);
    assertRepositoryIdentityMutable(imported.repository, configuration, automation);
    if (imported.repository.repository.trim() !== '') {
      validateRepositoryUrl(imported.repository.repository);
    }
    options.database.sqlite.transaction(() => {
      configuration.updateHarness(imported.harness);
      configuration.updateRepository(imported.repository);
    })();
    connectivity.invalidate?.(connectivity.list().map((check) => check.id));
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    assertRepositoryIdentityMutable(body.repository, configuration, automation);
    updateConfiguration(body, configuration, secretStore);
    if (isJsonRecord(body.harness)) invalidateHarnessChecks(body.harness, connectivity);
    if (isJsonRecord(body.repository)) invalidateRepositoryChecks(body.repository, connectivity);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config/harness', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    applySecretValues(body.secrets, secretStore);
    configuration.updateHarness(body);
    invalidateHarnessChecks(body, connectivity);
    return reply.send(makeConfigResponse(configuration, secretStore));
  });

  app.put('/api/config/repository', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    assertRepositoryIdentityMutable(body, configuration, automation);
    applySecretValues(body.secrets, secretStore);
    if (body.repository !== undefined && typeof body.repository === 'string') {
      validateRepositoryUrl(body.repository);
    }
    configuration.updateRepository(body);
    invalidateRepositoryChecks(body, connectivity);
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

  app.post('/api/repository/scenario-branch', async (request) => {
    requireAuth(request, auth);
    throw new AppError(
      'SCENARIO_BRANCH_QUEUE_REQUIRED',
      '场景测试分支不能在队列外创建；请提交 confirmed initialization merge-source 请求',
      409,
    );
  });

  app.post('/api/repository/merge', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    if (typeof body.sourceRef !== 'string' || body.sourceRef.trim() === '') {
      throw new AppError('INVALID_REQUEST', 'sourceRef 必须是非空字符串', 400);
    }
    if (body.confirmed !== true) {
      throw new AppError('MERGE_CONFIRMATION_REQUIRED', '需要明确确认后才能合并', 400);
    }
    if (body.initialization !== undefined && typeof body.initialization !== 'boolean') {
      throw new AppError('RUN_REQUEST_INVALID', 'initialization 必须是布尔值', 400);
    }
    if (body.request !== undefined && typeof body.request !== 'string') {
      throw new AppError('RUN_REQUEST_INVALID', 'request 必须是字符串', 400);
    }
    const sourceRef = body.sourceRef.trim();
    const submission = await automation.submitTestRequest({
      request:
        typeof body.request === 'string' && body.request.trim() !== ''
          ? body.request
          : '合并已确认来源并测试固定场景分支 target',
      trigger: 'manual',
      requestKind: 'manual-merge-source',
      sourceRef,
      confirmed: true,
      ...(body.initialization === true ? { initialization: true } : {}),
    });
    return reply.status(202).send(formatAutomationSubmission(submission));
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
    const query = readOptionalQuery(request, 'query') ?? readOptionalQuery(request, 'q');
    if (status !== undefined && !['draft', 'approved', 'deprecated'].includes(status)) {
      throw new AppError('INVALID_REQUEST', 'status 筛选值无效', 400);
    }
    return reply.send({
      scenarios: operations.listScenarios({
        status: status as 'draft' | 'approved' | 'deprecated' | undefined,
        tag,
        query,
      }),
    });
  });

  app.get('/api/scenarios/:scenarioId', async (request, reply) => {
    requireAuth(request, auth);
    const scenario = operations.getScenario(readParam(request, 'scenarioId'));
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

  app.get('/api/provider/providers', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ providers: (await provider.listProviders?.()) ?? [] });
  });

  app.get('/api/provider/models', async (request, reply) => {
    requireAuth(request, auth);
    const harness = configuration.getHarness();
    const requestedProvider = readOptionalQuery(request, 'provider')?.trim();
    const selectedProvider = requestedProvider || harness.provider;
    return reply.send({
      provider: selectedProvider,
      models: await provider.listModels(selectedProvider),
    });
  });

  app.post('/api/runs', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    if (typeof body.request !== 'string' || body.request.trim() === '') {
      throw new AppError('RUN_REQUEST_REQUIRED', 'Run 请求内容不能为空', 400);
    }
    if (body.targetCommit !== undefined || body.targetRef !== undefined) {
      throw new AppError(
        'RUN_TARGET_INVALID',
        '普通 Run 不能指定任意 target；请使用 merge-source 或当前场景分支 HEAD',
        400,
      );
    }
    if (body.initialization !== undefined && typeof body.initialization !== 'boolean') {
      throw new AppError('RUN_REQUEST_INVALID', 'initialization 必须是布尔值', 400);
    }
    const trigger = body.trigger === undefined ? 'manual' : body.trigger;
    if (trigger !== 'manual' && trigger !== 'api') {
      throw new AppError('RUN_TRIGGER_INVALID', 'Phase 3 只支持 manual 或 api 触发', 400);
    }
    const submission = await automation.submitTestRequest({
      request: body.request,
      trigger,
      requestKind: 'manual-current-head',
      ...(body.initialization === true ? { initialization: true } : {}),
    });
    return reply.status(202).send(formatAutomationSubmission(submission));
  });

  app.get('/api/queue', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ queue: automation.listQueue() });
  });

  app.get('/api/queue/:queueId', async (request, reply) => {
    requireAuth(request, auth);
    const queueId = readQueueId(request);
    const item = automation.getQueue(queueId);
    if (!item) throw new AppError('QUEUE_NOT_FOUND', '队列请求不存在', 404);
    return reply.send({ queue: item });
  });

  app.get('/api/automation/status', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ scheduler: scheduler.status(), queue: automation.listQueue() });
  });

  app.get('/api/runs', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ runs: await operations.listRuns() });
  });

  app.get('/api/runs/current', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ run: await runs.current() });
  });

  app.post('/api/archive/scan', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ runs: await automation.scanArchives() });
  });

  app.post('/api/runs/:runId/archive', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ archive: await archiver.archive(readParam(request, 'runId')) });
  });

  app.post('/api/runs/:runId/rerun', async (request, reply) => {
    requireAuth(request, auth);
    const body = readBody(request);
    if (body.request !== undefined && typeof body.request !== 'string') {
      throw new AppError('RUN_REQUEST_INVALID', 'request 必须是字符串', 400);
    }
    const submission = await automation.rerun(
      readParam(request, 'runId'),
      body.request as string | undefined,
    );
    return reply.status(202).send(formatAutomationSubmission(submission));
  });

  app.delete('/api/runs/:runId/cleanup', async (request, reply) => {
    requireAuth(request, auth);
    await automation.cleanupRun(readParam(request, 'runId'));
    return reply.send({ cleaned: true });
  });

  app.get('/api/runs/:runId/archive', async (request, reply) => {
    requireAuth(request, auth);
    const archived = runStore.get(readParam(request, 'runId'));
    if (!archived) throw new AppError('RUN_NOT_FOUND', 'Run 归档记录不存在', 404);
    return reply.send({
      archive: {
        runId: archived.runId,
        status:
          archived.archiveStatus === 'failed'
            ? 'failed'
            : archived.archiveStatus === 'partial'
              ? 'partial'
              : 'completed',
        reportStatus: archived.reportStatus,
        reportCommitSha: archived.reportCommitSha,
        issues: archived.issues.map((issue) => ({
          bugKey: issue.bugKey,
          status: issue.status,
          issueNumber: issue.issueNumber,
          issueUrl: issue.issueUrl,
          errorMessage: issue.errorMessage,
        })),
        progressed: archived.progressed,
        archiveStatus: archived.archiveStatus,
        errorMessage: archived.archiveError,
        indexerTriggered: false,
        scenarioStatus: archived.scenarioStatus,
        scenarioCommitSha: archived.scenarioCommitSha,
        scenarioPrUrl: archived.scenarioPrUrl,
        scenarioError: archived.scenarioError,
      },
    });
  });

  app.get('/api/evidence/:objectId', async (request, reply) => {
    requireAuth(request, auth);
    const evidence = await oss.getEvidenceByStableId(readParam(request, 'objectId'));
    const contentType = safeContentType(evidence.contentType);
    reply.header('cache-control', 'private, no-store');
    reply.type(contentType);
    return reply.send(evidence.body);
  });

  app.get('/api/runs/:runId', async (request, reply) => {
    requireAuth(request, auth);
    const run = await operations.getRun(readParam(request, 'runId'));
    if (!run) throw new AppError('RUN_NOT_FOUND', 'Run 不存在', 404);
    return reply.send({ run });
  });

  app.get('/api/operations/dashboard', async (request, reply) => {
    requireAuth(request, auth);
    const dashboard: OperationsDashboardResponse = await operations.dashboard();
    return reply.send(dashboard);
  });

  app.get('/api/dashboard', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(await operations.dashboard());
  });

  app.get('/api/operations/git-tree', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(await operations.gitTree(readOptionalQuery(request, 'commit')));
  });

  app.get('/api/operations/scenarios', async (request, reply) => {
    requireAuth(request, auth);
    const status = readOptionalQuery(request, 'status');
    const tag = readOptionalQuery(request, 'tag');
    const query = readOptionalQuery(request, 'query') ?? readOptionalQuery(request, 'q');
    if (status !== undefined && !['draft', 'approved', 'deprecated'].includes(status)) {
      throw new AppError('INVALID_REQUEST', 'status 筛选值无效', 400);
    }
    return reply.send({
      scenarios: operations.listScenarios({
        status: status as 'draft' | 'approved' | 'deprecated' | undefined,
        tag,
        query,
      }),
    });
  });

  app.get('/api/operations/scenarios/:scenarioId', async (request, reply) => {
    requireAuth(request, auth);
    const scenario = operations.getScenario(readParam(request, 'scenarioId'));
    if (!scenario) throw new AppError('SCENARIO_NOT_FOUND', '场景不存在或尚未索引', 404);
    return reply.send({ scenario });
  });

  app.get('/api/operations/runs', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ runs: await operations.listRuns() });
  });

  app.get('/api/operations/runs/:runId', async (request, reply) => {
    requireAuth(request, auth);
    const run = await operations.getRun(readParam(request, 'runId'));
    if (!run) throw new AppError('RUN_NOT_FOUND', 'Run 不存在', 404);
    return reply.send({ run });
  });

  app.get('/api/operations/current', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(await operations.current());
  });

  app.get('/api/operations/active', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send(await operations.current());
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
    if (key === 'providerApiKey' || key === 'ossAccessKeyId' || key === 'ossAccessKeySecret') {
      invalidateHarnessChecks({ secrets: { [key]: true } }, connectivity);
    }
    if (key === 'gitToken') {
      invalidateRepositoryChecks({ secrets: { [key]: true } }, connectivity);
    }
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

  app.post('/api/connectivity/checks', async (request, reply) => {
    requireAuth(request, auth);
    return reply.send({ checks: await connectivity.runAll() });
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
          : error instanceof OssError
            ? ossStatusCode(error)
            : error instanceof RepositoryError
              ? error.statusCode
              : error instanceof RunOrchestratorError
                ? error.code === 'RUN_ALREADY_ACTIVE'
                  ? 409
                  : error.code === 'RUN_NOT_FOUND'
                    ? 404
                    : 400
                : error instanceof AutomationServiceError
                  ? error.code === 'AUTOMATION_RUN_NOT_FOUND'
                    ? 404
                    : error.code === 'AUTOMATION_RUN_ACTIVE'
                      ? 409
                      : error.code === 'AUTOMATION_CLEANUP_FAILED'
                        ? 409
                        : 400
                  : error instanceof TestRequestQueueError
                    ? error.code === 'QUEUE_NOT_FOUND'
                      ? 404
                      : error.code === 'QUEUE_STATE_INVALID'
                        ? 409
                        : 400
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
          : error instanceof OssError
            ? error.code
            : error instanceof RepositoryError
              ? error.code
              : error instanceof RunOrchestratorError
                ? error.code
                : error instanceof AutomationServiceError
                  ? error.code
                  : error instanceof TestRequestQueueError
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
      error instanceof AutomationServiceError ||
      error instanceof TestRequestQueueError ||
      possibleError.name === 'ConfigurationError'
        ? typeof possibleError.message === 'string'
          ? possibleError.message
          : 'Request failed'
        : error instanceof SecretStoreError
          ? 'Secret Store 当前不可用'
          : error instanceof OssError
            ? ossMessage(error)
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
    scheduler.stop();
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

function formatAutomationSubmission(submission: AutomationSubmission): Record<string, unknown> {
  const queue = submission.queue;
  if (submission.run) {
    return {
      ...submission.run,
      queueId: queue.queueId,
      queueStatus: queue.status,
      requestId: queue.requestId,
    };
  }
  return {
    queueId: queue.queueId,
    requestId: queue.requestId,
    status: queue.status,
    trigger: queue.trigger,
    request: queue.request,
    requestKind: queue.requestKind,
    sourceRef: queue.sourceRef,
    preparedMergeCommit: queue.preparedMergeCommit,
    preparedMergeMode: queue.preparedMergeMode,
    resolvedTargetCommit: queue.resolvedTargetCommit,
    run: null,
    errorMessage: queue.errorMessage,
  };
}

function readQueueId(request: FastifyRequest): number {
  const value = readParam(request, 'queueId');
  const queueId = Number(value);
  if (!Number.isSafeInteger(queueId) || queueId <= 0) {
    throw new AppError('QUEUE_ID_INVALID', '队列 ID 无效', 400);
  }
  return queueId;
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

function assertRepositoryIdentityMutable(
  value: unknown,
  configuration: ConfigurationStore,
  automation: AutomationService,
): void {
  if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return;
  }
  const candidate = value as JsonRecord;
  const current = configuration.getRepository();
  const repositoryChanges =
    typeof candidate.repository === 'string' && candidate.repository !== current.repository;
  const branchChanges =
    typeof candidate.scenarioBranch === 'string' &&
    candidate.scenarioBranch !== current.scenarioBranch;
  if (
    (repositoryChanges || branchChanges) &&
    automation
      .listQueue()
      .some((item) => ['queued', 'running', 'waiting_archive'].includes(item.status))
  ) {
    throw new AppError(
      'REPOSITORY_CHANGE_BLOCKED',
      '存在未结束的测试请求，不能更换目标仓库或场景测试分支',
      409,
    );
  }
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

function invalidateHarnessChecks(body: JsonRecord, connectivity: ConnectivityRegistry): void {
  const secrets = isJsonRecord(body.secrets) ? body.secrets : {};
  const checkIds: string[] = [];
  if (
    ['provider', 'providerBaseUrl', 'agents'].some((key) => body[key] !== undefined) ||
    secrets.providerApiKey !== undefined
  ) {
    checkIds.push('provider-model');
  }
  if (body.mcp !== undefined) checkIds.push('playwright-mcp');
  if (
    body.oss !== undefined ||
    secrets.ossAccessKeyId !== undefined ||
    secrets.ossAccessKeySecret !== undefined
  ) {
    checkIds.push('oss');
  }
  connectivity.invalidate?.(checkIds);
}

function invalidateRepositoryChecks(body: JsonRecord, connectivity: ConnectivityRegistry): void {
  const secrets = isJsonRecord(body.secrets) ? body.secrets : {};
  const checkIds: string[] = [];
  if (
    body.repository !== undefined ||
    body.scenarioBranch !== undefined ||
    secrets.gitToken !== undefined
  ) {
    checkIds.push(
      'github-repository-read',
      'github-scenario-branch-write',
      'github-pull-request',
      'github-issue',
    );
  }
  if (body.baseUrl !== undefined) checkIds.push('test-environment-url');
  connectivity.invalidate?.(checkIds);
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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function safeContentType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

function ossStatusCode(error: OssError): number {
  switch (error.code) {
    case 'OSS_OBJECT_INVALID':
    case 'OSS_CONFIGURATION_INVALID':
      return 400;
    case 'OSS_OBJECT_NOT_FOUND':
      return 404;
    case 'OSS_NOT_CONFIGURED':
      return 503;
    case 'OSS_REQUEST_FAILED':
      return 502;
  }
}

function ossMessage(error: OssError): string {
  return error.code === 'OSS_REQUEST_FAILED' ? '对象存储请求失败' : error.message;
}
