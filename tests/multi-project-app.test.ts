import { strict as assert } from 'node:assert';

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
import { createProjectApp } from '../src/server/projects/app.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createProjectRunStore } from '../src/server/runs/store.js';
import { encodeStableEvidenceId } from '../src/server/storage/oss.js';
import type { RunSummary } from '../src/shared/types.js';

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
  database.sqlite
    .prepare(
      `INSERT INTO system_metadata (key, value, created_at, updated_at)
    VALUES ('v061_empty_cutover', 'complete', '2026-01-01', '2026-01-01')`,
    )
    .run();
  let drains = 0;
  const evidenceReads: Array<{ projectId: string; key: string }> = [];
  let activeRun: { projectId: string; run: RunSummary } | null = null;
  const backgroundEvents: string[] = [];
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
      enqueue: (projectId, input) =>
        createProjectTestRequestQueue(database.sqlite, projectId).enqueue(input),
      drain: async () => {
        drains += 1;
      },
      recover: async () => {},
      retryArchives: async () => {},
      currentRun: async () => activeRun,
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
    readinessDependencies: {
      verifyRepository: async (project) => ({
        githubRepositoryId: project.githubRepositoryId,
        owner: project.repositoryOwner,
        name: project.repositoryName,
      }),
      checkDeployment: async () => ({ id: 'deployment', status: 'failed', message: 'not ready' }),
      checkEnvironment: async () => ({ id: 'environment', status: 'ok', message: 'ok' }),
      checkImage: async () => ({ id: 'image', status: 'not_configured', message: 'not ready' }),
    },
    images: {
      prepare: async () => {
        throw new Error('unused');
      },
    },
  });
  try {
    assert.deepEqual(backgroundEvents, ['recover', 'start']);
    assert.equal((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode, 401);
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
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/account', headers })).json().profile
        .displayName,
      '管理员',
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
    const createdB = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { displayName: 'B', repositoryUrl: 'https://github.com/example/b' },
    });
    assert.equal(createdB.statusCode, 201);
    const projectB = createdB.json().project.projectId;
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
      trigger: 'manual',
      baseCommit: null,
      targetCommit: 'a'.repeat(40),
      includedCommits: ['a'.repeat(40)],
      result: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      completedDirectory: '/tmp/RUN-A',
      artifacts: {},
      scenarioResults: [],
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
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/runs/RUN-A`, headers }))
        .statusCode,
      200,
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
  }
});
