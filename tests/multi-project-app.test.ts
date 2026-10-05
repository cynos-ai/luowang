import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRepository } from '../src/server/repository/git-repository.js';

import type Database from 'better-sqlite3';
import pino from 'pino';
import { it } from 'vitest';

import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/db/client.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateLegacySecretOwnership } from '../src/server/db/migrations/0013-project-secret-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import { migrateProjectReportIndexIdentity } from '../src/server/db/migrations/0017-project-report-index-identity.js';
import { migrateConnectionResources } from '../src/server/db/migrations/0021-connection-resources.js';
import { createProjectApp } from '../src/server/projects/app.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createProjectRunStore } from '../src/server/runs/store.js';
import { encodeStableEvidenceId } from '../src/server/storage/oss.js';
import type { RunSummary } from '../src/shared/types.js';
import {
  parseLiveQueueResponse,
  parseLiveRunResponse,
  parseLiveRunsResponse,
} from './acceptance/live-contract.js';

it('uses only new-schema administration routes, scoped Secrets, and the existing administrator session', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATABASE_PATH: ':memory:',
    LUOWANG_ADMIN_PASSWORD: 'initial-password-123',
    LUOWANG_MASTER_KEY: 'test-master',
  });
  const database = openDatabase(config);
  runMigrations(database.sqlite);
  await assert.rejects(
    () => createProjectApp({ config: { ...config }, database, logger: pino({ level: 'silent' }) }),
    /迁移不完整/,
  );
  runMigrations(database.sqlite, [projectIdentityMigration]);
  migrateLegacyIndexOwnership(database.sqlite, null);
  migrateLegacyRunOwnership(database.sqlite, null);
  migrateLegacyConfigurationOwnership(database.sqlite, null);
  migrateLegacySecretOwnership(database.sqlite, config.masterKey, null);
  migrateProjectQueueContext(database.sqlite);
  migrateProjectImageState(database.sqlite);
  migrateProjectRunImage(database.sqlite);
  migrateProjectReportIndexIdentity(database.sqlite);
  migrateConnectionResources(database.sqlite);
  database.sqlite
    .prepare(
      `INSERT INTO system_metadata (key, value, created_at, updated_at)
    VALUES ('v061_empty_cutover', 'complete', '2026-01-01', '2026-01-01')`,
    )
    .run();
  let drains = 0;
  let archiveRetries = 0;
  let dispatcherLimit = 2;
  let stalledRepository: GitRepository | null = null;
  const evidenceReads: Array<{ projectId: string; key: string }> = [];
  let activeRun: { projectId: string; run: RunSummary } | null = null;
  const backgroundEvents: string[] = [];
  const dependencyEvents: string[] = [];
  const app = await createProjectApp({
    config,
    database,
    logger: pino({ level: 'silent' }),
    verifyRepository: async (url) => ({
      githubRepositoryId: url.endsWith('/a') ? '101' : '102',
      owner: 'example',
      name: url.endsWith('/a') ? 'a' : 'b',
    }),
    dispatcher: {
      stopRequest: async (projectId, queueId) =>
        createProjectTestRequestQueue(database.sqlite, projectId).requestStop(queueId),
      enqueue: (projectId, input) =>
        createProjectTestRequestQueue(database.sqlite, projectId).enqueue(input),
      drain: async () => {
        drains += 1;
      },
      recover: async () => {},
      retryArchives: async () => {},
      retryArchive: async (projectId, runId) => {
        archiveRetries++;
        const queue = createProjectTestRequestQueue(database.sqlite, projectId)
          .list()
          .find((item) => item.runId === runId);
        assert.ok(queue);
        return queue;
      },
      get maxConcurrentProjects() {
        return dispatcherLimit;
      },
      setMaxConcurrentProjects(limit) {
        dispatcherLimit = limit;
      },
      stop: async () => undefined,
      currentRuns: async () => (activeRun ? [activeRun] : []),
      getActiveRun: async (projectId, runId) =>
        activeRun?.projectId === projectId && activeRun.run.runId === runId
          ? { ...activeRun.run, artifacts: { 'plan.md': 'active plan' } }
          : null,
    },
    readEvidence: async (projectId, key) => {
      evidenceReads.push({ projectId, key });
      return {
        key,
        body: Buffer.from('evidence-body'),
        contentType: 'text/plain; charset=utf-8',
        contentLength: 13,
        etag: null,
      };
    },
    backgroundTasks: true,
    background: {
      recover: async () => {
        backgroundEvents.push('recover');
      },
      start: () => {
        backgroundEvents.push('start');
      },
      tick: async () => {},
      stop: async () => {
        backgroundEvents.push('stop');
      },
    },
    sharedDependencyMonitor: {
      trigger: (ids) => dependencyEvents.push(`trigger:${ids.join(',')}`),
      checkStale: async () => {},
      start: () => dependencyEvents.push('start'),
      stop: async () => {
        dependencyEvents.push('stop');
      },
    },
    readinessDependencies: {
      verifyRepository: async (project) => ({
        githubRepositoryId: project.githubRepositoryId,
        owner: project.repositoryOwner,
        name: project.repositoryName,
      }),
      checkDeployment: async () => ({ id: 'deployment', status: 'failed', message: 'not ready' }),
      checkEnvironment: async () => ({ id: 'environment', status: 'ok', message: 'ok' }),
      checkImage: async () => {
        if (stalledRepository) await stalledRepository.remoteBranchHead('scenario-testing');
        return { id: 'image', status: 'not_configured', message: 'not ready' };
      },
    },
    images: {
      prepare: async () => {
        throw new Error('unused');
      },
    },
  });
  try {
    assert.deepEqual(backgroundEvents, ['recover', 'start']);
    assert.deepEqual(dependencyEvents, ['start']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/provider/providers' })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/provider/models?provider=openai' })).statusCode,
      401,
    );
    assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/runs' })).statusCode, 404);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'initial-password-123' },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    assert.ok(cookie);
    const headers = { cookie };
    const providers = await app.inject({ method: 'GET', url: '/api/provider/providers', headers });
    assert.equal(providers.statusCode, 200);
    assert.ok(providers.json().providers.some((item: { id: string }) => item.id === 'openai'));
    const openAiCatalog = providers
      .json()
      .providers.find((item: { id: string }) => item.id === 'openai') as { baseUrl?: string };
    assert.equal(typeof openAiCatalog.baseUrl, 'string');
    assert.ok(openAiCatalog.baseUrl?.startsWith('http'));
    const models = await app.inject({
      method: 'GET',
      url: '/api/provider/models?provider=openai',
      headers,
    });
    assert.equal(models.statusCode, 200);
    assert.equal(models.json().provider, 'openai');
    assert.ok(models.json().models.length > 0);
    assert.ok(
      models.json().models.every((item: { provider: string }) => item.provider === 'openai'),
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/account', headers })).json().profile
        .displayName,
      '管理员',
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/system-settings', headers })).json().runtime
        .maxConcurrentProjects,
      2,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/system-settings',
          headers,
          payload: { maxConcurrentProjects: 3 },
        })
      ).json().runtime.maxConcurrentProjects,
      3,
    );
    assert.equal(dispatcherLimit, 3);
    assert.equal(
      database.sqlite
        .prepare("SELECT value FROM system_metadata WHERE key = 'runtime_max_concurrent_projects'")
        .pluck()
        .get(),
      '3',
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/account',
          headers,
          payload: { displayName: '  负责人  ' },
        })
      ).json().profile.displayName,
      '负责人',
    );
    const badDeployment = await app.inject({
      method: 'PUT',
      url: '/api/deployment',
      headers,
      payload: { repository: 'evil' },
    });
    assert.equal(badDeployment.statusCode, 400, badDeployment.body);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/deployment/secrets/gitToken',
          headers,
          payload: { value: 'wrong' },
        })
      ).statusCode,
      400,
    );
    const deploymentSecret = await app.inject({
      method: 'PUT',
      url: '/api/deployment/secrets/providerApiKey',
      headers,
      payload: { value: 'provider-secret' },
    });
    assert.equal(deploymentSecret.statusCode, 200);
    assert.ok(!deploymentSecret.body.includes('provider-secret'));
    assert.deepEqual(dependencyEvents, ['start', 'trigger:provider-model']);
    const savedDeployment = (
      await app.inject({ method: 'GET', url: '/api/deployment', headers })
    ).json().configuration;
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/deployment',
          headers,
          payload: { mcp: savedDeployment.mcp },
        })
      ).statusCode,
      200,
    );
    assert.equal(dependencyEvents.at(-1), 'trigger:playwright-mcp');
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/deployment',
          headers,
          payload: { oss: savedDeployment.oss },
        })
      ).statusCode,
      200,
    );
    assert.equal(dependencyEvents.at(-1), 'trigger:oss');
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        displayName: 'A',
        repositoryUrl: 'https://github.com/example/a',
        gitToken: 'project-secret',
      },
    });
    assert.equal(created.statusCode, 201);
    const projectId = created.json().project.projectId;
    const namedToken = await app.inject({
      method: 'POST',
      url: '/api/connection-resources/github',
      headers,
      payload: { name: '共享 GitHub', token: 'shared-project-secret' },
    });
    assert.equal(namedToken.statusCode, 201);
    assert.doesNotMatch(namedToken.body, /shared-project-secret/);
    const credentialId = namedToken.json().credential.id;
    const server = await app.inject({
      method: 'POST',
      url: '/api/connection-resources/servers',
      headers,
      payload: {
        name: 'Beta 服务器',
        host: 'beta.example.test',
        port: 22,
        username: 'runner',
        authType: 'private-key',
        privateKey: 'test-private-key',
      },
    });
    assert.equal(server.statusCode, 201);
    assert.doesNotMatch(server.body, /test-private-key/);
    const serverId = server.json().server.id;
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/projects/${projectId}/resources`,
          headers,
          payload: { githubCredentialId: credentialId, executionServerId: serverId },
        })
      ).statusCode,
      200,
    );
    const managedFile = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/files`,
      headers,
      payload: { path: 'config/beta.yml', content: 'secret: hidden-value' },
    });
    assert.equal(managedFile.statusCode, 201);
    assert.doesNotMatch(managedFile.body, /hidden-value/);
    for (const payload of [
      { path: 'C:/config.env', content: 'invalid-path' },
      { path: 'too-large.txt', content: '密'.repeat(90_000) },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/files`,
            headers,
            payload,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers })).json()
        .managedFiles[0].path,
      'config/beta.yml',
    );
    const stalled = createServer(() => {});
    const gitDirectory = await mkdtemp(join(tmpdir(), 'luowang-api-timeout-'));
    await new Promise<void>((done) => stalled.listen(0, '127.0.0.1', done));
    const remote = stalled.address();
    assert.ok(remote && typeof remote !== 'string');
    try {
      execFileSync('git', ['init', gitDirectory], { stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-C',
          gitDirectory,
          'remote',
          'add',
          'origin',
          `http://127.0.0.1:${remote.port}/private.git`,
        ],
        { stdio: 'ignore' },
      );
      stalledRepository = new GitRepository({
        directory: gitDirectory,
        remoteUrl: `http://127.0.0.1:${remote.port}/private.git`,
        tokenProvider: () => 'private-timeout-token',
        timeouts: { remoteReadMs: 100 },
      });
      const timeout = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/readiness/check`,
        headers,
        payload: {},
      });
      assert.equal(timeout.statusCode, 200);
      assert.equal(timeout.json().readiness.ready, false);
      assert.match(timeout.body, /Git 远程检查超时/);
      assert.doesNotMatch(timeout.body, /private-timeout-token|private.git/);
      const persisted = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/readiness/status`,
        headers,
      });
      assert.match(persisted.body, /Git 远程检查超时/);
      assert.equal(createProjectTestRequestQueue(database.sqlite, projectId).list().length, 0);
    } finally {
      stalledRepository = null;
      stalled.closeAllConnections();
      await new Promise<void>((done) => stalled.close(() => done()));
      await rm(gitDirectory, { recursive: true, force: true });
      database.sqlite
        .prepare('DELETE FROM project_connectivity_check_results WHERE project_id = ?')
        .run(projectId);
    }
    const createdB = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { displayName: 'B', repositoryUrl: 'https://github.com/example/b' },
    });
    assert.equal(createdB.statusCode, 201);
    const projectB = createdB.json().project.projectId;
    for (const id of [projectId, projectB]) {
      database.sqlite
        .prepare(
          `INSERT INTO project_connectivity_check_results
             (project_id, check_id, status, message, checked_at, latency_ms)
           VALUES (?, 'deployment', 'ok', '通过', '2026-09-27T00:00:00.000Z', NULL)`,
        )
        .run(id);
    }
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/connection-resources/servers/${serverId}`,
          headers,
          payload: { host: 'updated.example.test' },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(
      database.sqlite.prepare('SELECT project_id FROM project_connectivity_check_results').all(),
      [{ project_id: projectB }],
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/deployment',
          headers,
          payload: { providerBaseUrl: 'https://provider.example.test' },
        })
      ).statusCode,
      200,
    );
    assert.equal(projectReadinessRows(database.sqlite, 'deployment'), 0);
    assert.equal(dependencyEvents.at(-1), 'trigger:provider-model');
    for (const id of [projectId, projectB]) {
      database.sqlite
        .prepare(
          `INSERT INTO project_connectivity_check_results
             (project_id, check_id, status, message, checked_at, latency_ms)
           VALUES (?, 'deployment', 'ok', '通过', '2026-09-27T00:00:00.000Z', NULL)`,
        )
        .run(id);
    }
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/deployment/secrets/providerApiKey',
          headers,
          payload: { value: 'replacement-provider-secret' },
        })
      ).statusCode,
      200,
    );
    assert.equal(projectReadinessRows(database.sqlite, 'deployment'), 0);
    assert.equal(dependencyEvents.at(-1), 'trigger:provider-model');
    const activeId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    activeRun = {
      projectId,
      run: {
        runId: activeId,
        status: 'running',
        phase: 'runner',
        result: null,
        trigger: 'manual',
        request: 'active A',
        baseCommit: null,
        targetCommit: 'a'.repeat(40),
        includedCommits: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        errorMessage: null,
        artifactNames: ['plan.md'],
        evidence: [
          {
            id: encodeStableEvidenceId(`prefix/projects/${projectId}/runs/${activeId}/active.png`),
            filename: 'active.png',
            objectKey: `prefix/projects/${projectId}/runs/${activeId}/active.png`,
            url: 'https://example.invalid/active',
            contentType: 'image/png',
            sizeBytes: 13,
            sha256: 'a'.repeat(64),
            uploadedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    };
    assert.equal(
      (
        await app.inject({ method: 'GET', url: `/api/projects/${projectId}/runs/current`, headers })
      ).json().run.runId,
      activeId,
    );
    assert.equal(
      (
        await app.inject({ method: 'GET', url: `/api/projects/${projectB}/runs/current`, headers })
      ).json().run,
      null,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/${activeId}`,
          headers,
        })
      ).json().run.artifacts['plan.md'],
      'active plan',
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectB}/runs/${activeId}`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/${activeId}/evidence/${encodeStableEvidenceId(`prefix/projects/${projectId}/runs/${activeId}/active.png`)}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/runs`, headers })).json()
        .runs[0].runId,
      activeId,
    );
    evidenceReads.length = 0;
    activeRun = null;
    const scenarioPath = 'docs/scenario-testing/scenarios/SHARED.md';
    const insertScenario = database.sqlite.prepare(
      `INSERT INTO indexed_scenarios
       (project_id, path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
       VALUES (?, ?, 'SHARED', ?, '', 'approved', '[]', ?, ?, '2026-01-01')`,
    );
    insertScenario.run(projectId, scenarioPath, 'A scenario', 'A content', 'a'.repeat(40));
    insertScenario.run(projectB, scenarioPath, 'B scenario', 'B content', 'b'.repeat(40));
    const insertReport = database.sqlite.prepare(
      `INSERT INTO indexed_reports
       (project_id, run_id, path, trigger, base_commit, target_commit, included_commits_json,
        result, started_at, finished_at, scenario_results_json, confirmed_bugs_json,
        files_json, content, commit_sha, indexed_at)
       VALUES (?, ?, ?,
               'manual', NULL, ?, '[]', 'passed', '2026-01-01', '2026-01-01',
               '[]', '[]', '[]', ?, ?, '2026-01-01')`,
    );
    insertReport.run(
      projectId,
      'RUN-A',
      'docs/scenario-testing/reports/RUN-A/report.md',
      'a'.repeat(40),
      'A report',
      'a'.repeat(40),
    );
    insertReport.run(
      projectB,
      'RUN-B',
      'docs/scenario-testing/reports/RUN-B/report.md',
      'b'.repeat(40),
      'B report',
      'b'.repeat(40),
    );
    for (const [id, name, content, reportId] of [
      [projectId, 'A scenario', 'A report', 'RUN-A'],
      [projectB, 'B scenario', 'B report', 'RUN-B'],
    ]) {
      const base = `/api/projects/${id}`;
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/scenarios`, headers })).json().scenarios[0]
          .name,
        name,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/scenarios/SHARED`, headers })).json()
          .scenario.name,
        name,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/reports/${reportId}`, headers })).json()
          .report.content,
        content,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: `${base}/reports`, headers })).json().reports
          .length,
        1,
      );
    }
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectB}/reports/RUN-A`, headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/scenarios` })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/missing/scenarios`, headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/reports/nope`, headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/index`, headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers })).json()
        .secrets.gitToken.configured,
      true,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/deployment', headers })).json().secrets
        .providerApiKey.configured,
      true,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/deployment', headers })).json().secrets
        .gitToken,
      undefined,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/projects/${projectId}/resume`, headers }))
        .statusCode,
      409,
    );
    const runUrl = `/api/projects/${projectId}/runs`;
    assert.equal((await app.inject({ method: 'GET', url: runUrl })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'POST', url: runUrl, headers, payload: { request: 'test' } }))
        .statusCode,
      409,
    );
    database.sqlite
      .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
      .run(projectId);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: runUrl,
          headers,
          payload: { request: 'test', projectId: projectB },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: runUrl,
          headers,
          payload: { request: 'test', targetCommit: 'a'.repeat(40) },
        })
      ).statusCode,
      400,
    );
    const submitted = await app.inject({
      method: 'POST',
      url: runUrl,
      headers,
      payload: { request: 'test A' },
    });
    assert.equal(submitted.statusCode, 202);
    const queueId = submitted.json().queue.queueId;
    assert.equal(submitted.json().queue.projectId, projectId);
    assert.equal(drains, 1);
    const mergeUrl = `/api/projects/${projectId}/merge`;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: mergeUrl,
          headers,
          payload: { sourceRef: 'feat/source' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: mergeUrl,
          headers: { ...headers, origin: 'https://other.example' },
          payload: { sourceRef: 'feat/source', confirmed: true },
        })
      ).statusCode,
      403,
    );
    const merged = await app.inject({
      method: 'POST',
      url: mergeUrl,
      headers,
      payload: { sourceRef: 'feat/source', confirmed: true },
    });
    assert.equal(merged.statusCode, 202);
    assert.equal(merged.json().queue.requestKind, 'manual-merge-source');
    assert.equal(merged.json().queue.projectId, projectId);
    assert.equal(drains, 2);
    const stopUrl = `/api/projects/${projectId}/queue/${queueId}/stop`;
    assert.equal(
      (await app.inject({ method: 'POST', url: stopUrl, payload: { confirmed: true } })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: stopUrl,
          headers: { ...headers, origin: 'https://other.example' },
          payload: { confirmed: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectB}/queue/${queueId}/stop`,
          headers,
          payload: { confirmed: true },
        })
      ).statusCode,
      404,
    );
    for (const payload of [{}, { confirmed: false }, { confirmed: true, runId: 'foreign' }]) {
      assert.equal(
        (await app.inject({ method: 'POST', url: stopUrl, headers, payload })).statusCode,
        400,
      );
    }
    const stopped = await app.inject({
      method: 'POST',
      url: stopUrl,
      headers,
      payload: { confirmed: true },
    });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().queue.status, 'interrupted');
    assert.equal(stopped.json().queue.runId, null);
    assert.deepEqual(
      (
        await app.inject({ method: 'POST', url: stopUrl, headers, payload: { confirmed: true } })
      ).json(),
      stopped.json(),
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/queue/${queueId}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectB}/queue/${queueId}`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectB}/queue`, headers })).json()
        .queue.length,
      0,
    );
    createProjectRunStore(database.sqlite, projectId).importCompleted({
      runId: 'RUN-A',
      telemetry: {
        stages: [
          {
            phase: 'runner',
            startedAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:01:00.000Z',
          },
        ],
        sessions: [
          {
            sessionId: 'one',
            kind: 'runner-execution',
            startedAt: null,
            finishedAt: '2026-01-01T00:01:00.000Z',
            usage: null,
          },
        ],
      },
      trigger: 'manual',
      baseCommit: null,
      targetCommit: 'a'.repeat(40),
      includedCommits: ['a'.repeat(40)],
      result: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      completedDirectory: '/tmp/RUN-A',
      artifacts: {},
      scenarioResults: [{ id: 'SHARED', result: 'passed' }],
      confirmedBugs: [],
      evidence: [
        {
          id: encodeStableEvidenceId(`prefix/projects/${projectId}/runs/RUN-A/screenshot.png`),
          filename: 'screenshot.png',
          objectKey: `prefix/projects/${projectId}/runs/RUN-A/screenshot.png`,
          url: 'https://example.invalid/evidence',
          contentType: 'image/png',
          sizeBytes: 13,
          sha256: 'a'.repeat(64),
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: encodeStableEvidenceId(`prefix/projects/${projectB}/runs/RUN-A/foreign.png`),
          filename: 'foreign.png',
          objectKey: `prefix/projects/${projectB}/runs/RUN-A/foreign.png`,
          url: 'https://example.invalid/foreign',
          contentType: 'image/png',
          sizeBytes: 13,
          sha256: 'b'.repeat(64),
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: encodeStableEvidenceId('prefix/RUN-A/legacy.png'),
          filename: 'legacy.png',
          objectKey: 'prefix/RUN-A/legacy.png',
          url: 'https://example.invalid/legacy',
          contentType: 'image/png',
          sizeBytes: 13,
          sha256: 'c'.repeat(64),
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const evidenceId = encodeStableEvidenceId(
      `prefix/projects/${projectId}/runs/RUN-A/screenshot.png`,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/RUN-A/evidence/${evidenceId}`,
        })
      ).statusCode,
      401,
    );
    const evidence = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs/RUN-A/evidence/${evidenceId}`,
      headers,
    });
    assert.equal(evidence.statusCode, 200);
    assert.equal(evidence.body, 'evidence-body');
    assert.equal(evidence.headers['cache-control'], 'private, no-store');
    assert.equal(evidence.headers['x-content-type-options'], 'nosniff');
    assert.equal(evidence.headers['content-type'], 'image/png');
    assert.deepEqual(evidenceReads, [
      { projectId, key: `prefix/projects/${projectId}/runs/RUN-A/screenshot.png` },
    ]);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/RUN-A/evidence/${encodeStableEvidenceId(`prefix/projects/${projectB}/runs/RUN-A/foreign.png`)}`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/RUN-A/evidence/${encodeStableEvidenceId('prefix/RUN-A/legacy.png')}`,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectB}/runs/RUN-A/evidence/${evidenceId}`,
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/runs/RUN-A/evidence/${encodeStableEvidenceId('other/key')}`,
          headers,
        })
      ).statusCode,
      404,
    );
    const storedRunDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs/RUN-A`,
      headers,
    });
    assert.equal(storedRunDetail.statusCode, 200);
    assert.equal(storedRunDetail.json().run.phase, 'completed');
    assert.equal(storedRunDetail.json().run.archive.reportStatus, 'pending');
    // Consumer contract uses real HTTP serialization, not a hand-written flat StoredRun.
    assert.equal(parseLiveRunResponse(storedRunDetail.json()).archive?.reportStatus, 'pending');
    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs`,
      headers,
    });
    assert.ok(parseLiveRunsResponse(listResponse.json()).some((run) => run.runId === 'RUN-A'));
    const queueResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/queue`,
      headers,
    });
    assert.ok(parseLiveQueueResponse(queueResponse.json()).length > 0);
    const store = createProjectRunStore(database.sqlite, projectId);
    const persisted = store.get('RUN-A')!;
    assert.deepEqual(storedRunDetail.json().run.telemetry, persisted.telemetry);
    store.importCompleted(persisted);
    assert.equal(
      createProjectRunStore(database.sqlite, projectId).get('RUN-A')?.telemetry?.sessions.length,
      1,
    );
    assert.throws(
      () => store.importCompleted({ ...persisted, telemetry: { stages: [], sessions: [] } }),
      /telemetry 冲突/,
    );
    store.importCompleted({
      ...store.get('RUN-A')!,
      runId: 'SPECIAL-REVIEW',
      result: 'blocked',
      specialRun: true,
      initialization: true,
      completedDirectory: '/tmp/SPECIAL-REVIEW',
      artifacts: { 'scenario-changes.patch': 'synthetic patch', 'report.md': 'synthetic report' },
      scenarioResults: [],
      evidence: [],
    });
    store.markScenario('SPECIAL-REVIEW', {
      status: 'pull_request',
      scenarioPrUrl: 'https://github.com/example/a/pull/1',
    });
    store.completeArchive('SPECIAL-REVIEW', { reportReady: true, scenarioReady: true });
    const specialResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs/SPECIAL-REVIEW`,
      headers,
    });
    assert.equal(specialResponse.statusCode, 200);
    const special = parseLiveRunResponse(specialResponse.json());
    assert.equal(special.archive?.reportStatus, 'not_applicable');
    assert.equal(special.archive?.scenarioStatus, 'pull_request');
    assert.equal(special.archive?.archiveStatus, 'completed');
    assert.equal(special.archive?.progressed, false);
    assert.deepEqual(Object.keys(special.artifacts!).sort(), [
      'report.md',
      'scenario-changes.patch',
    ]);
    assert.deepEqual(storedRunDetail.json().run.scenarioResults, [
      { id: 'SHARED', result: 'passed' },
    ]);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectId}/scenarios/SHARED`,
          headers,
        })
      ).json().scenario.history[0].runId,
      'RUN-A',
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectB}/runs/RUN-A`, headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectB}/runs`, headers })).json()
        .runs.length,
      0,
    );
    const failedRunId = '01M39Z2H59PP6TWS8D9JHAB0RM';
    database.sqlite
      .prepare(
        `UPDATE test_request_queue SET status = 'failed', run_id = ?,
         resolved_target_commit = ?, error_message = 'Run 执行失败',
         completed_at = '2026-01-02T00:00:00.000Z'
         WHERE queue_id = ?`,
      )
      .run(failedRunId, 'a'.repeat(40), queueId);
    const failedList = (
      await app.inject({ method: 'GET', url: `/api/projects/${projectId}/runs`, headers })
    ).json().runs;
    assert.equal(failedList.find((run: RunSummary) => run.runId === failedRunId)?.status, 'failed');
    const failedDetail = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs/${failedRunId}`,
      headers,
    });
    assert.equal(failedDetail.statusCode, 200);
    assert.equal(failedDetail.json().run.targetCommit, 'a'.repeat(40));
    assert.equal(failedDetail.json().run.errorMessage, 'Run 执行失败');
    assert.deepEqual(failedDetail.json().run.artifacts, {});
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/${projectB}/runs/${failedRunId}`,
          headers,
        })
      ).statusCode,
      404,
    );
    database.sqlite
      .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
      .run(projectId);
    const retestUrl = `/api/projects/${projectId}/runs/RUN-A/retest`;
    const retestBody = { confirmed: true, idempotencyKey: 'fixed-api-followup-token' };
    assert.equal(
      (await app.inject({ method: 'POST', url: retestUrl, payload: retestBody })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: retestUrl,
          headers: { ...headers, origin: 'https://foreign.example' },
          payload: retestBody,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectB}/runs/RUN-A/retest`,
          headers,
          payload: retestBody,
        })
      ).statusCode,
      404,
    );
    for (const payload of [
      { confirmed: true },
      { ...retestBody, targetCommit: 'b'.repeat(40) },
      { ...retestBody, confirmed: false },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: retestUrl, headers, payload })).statusCode,
        400,
      );
    const firstFollowup = await app.inject({
      method: 'POST',
      url: retestUrl,
      headers,
      payload: retestBody,
    });
    assert.equal(firstFollowup.statusCode, 202, firstFollowup.body);
    const repeatedFollowup = await app.inject({
      method: 'POST',
      url: retestUrl,
      headers,
      payload: retestBody,
    });
    assert.deepEqual(repeatedFollowup.json(), firstFollowup.json());
    assert.equal(firstFollowup.json().queue.sourceRunId, 'RUN-A');
    assert.equal(firstFollowup.json().queue.resolvedTargetCommit, null);
    assert.equal(firstFollowup.json().queue.requestKind, 'manual-current-head');
    const oldAfterFollowup = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/runs/RUN-A`,
      headers,
    });
    assert.deepEqual(oldAfterFollowup.json().run, storedRunDetail.json().run);
    assert.equal(oldAfterFollowup.json().followups.length, 1);
    const retryUrl = `/api/projects/${projectId}/runs/${failedRunId}/archive/retry`;
    assert.equal(
      (await app.inject({ method: 'POST', url: retryUrl, payload: {} })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: retryUrl,
          headers: { ...headers, origin: 'https://foreign.example' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: retryUrl, headers, payload: { runId: 'foreign' } }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${projectB}/runs/${failedRunId}/archive/retry`,
          headers,
          payload: {},
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: retryUrl, headers, payload: {} })).statusCode,
      200,
    );
    assert.equal(archiveRetries, 1);
    const password = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers,
      payload: { currentPassword: 'initial-password-123', newPassword: 'changed-password-123' },
    });
    assert.equal(password.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/projects', headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
    assert.deepEqual(backgroundEvents, ['recover', 'start', 'stop']);
    assert.equal(dependencyEvents.at(-1), 'stop');
  }
});

function projectReadinessRows(database: Database.Database, checkId: string): number {
  return (
    database
      .prepare(
        'SELECT count(*) AS count FROM project_connectivity_check_results WHERE check_id = ?',
      )
      .get(checkId) as { count: number }
  ).count;
}
