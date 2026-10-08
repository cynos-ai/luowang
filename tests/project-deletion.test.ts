import { strict as assert } from 'node:assert';

import fastifyCookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { it } from 'vitest';

import { ensureSystemMetadata, runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import { migrateRunStop } from '../src/server/db/migrations/0018-run-stop.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { registerProjectAdminRoutes } from '../src/server/projects/admin-routes.js';
import { createProjectBackgroundScheduler } from '../src/server/projects/background-scheduler.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createConnectionResourceService } from '../src/server/projects/connection-resources.js';
import { deleteProject } from '../src/server/projects/delete-project.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectRunStore } from '../src/server/runs/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'test' });
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyIndexOwnership(database, null);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  migrateRunStop(database);
  migrateExecutionRuntime(database);
  const projects = createProjectStore(database);
  const a = projects.createVerified({
    displayName: 'A',
    repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
  });
  const b = projects.createVerified({
    displayName: 'B',
    repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
  });
  const configuration = createProjectConfigurationStore(database);
  configuration.update(a.projectId, { language: 'zh-CN' });
  configuration.update(b.projectId, { language: 'en' });
  const secrets = createScopedSecretStore(database, 'synthetic-master-key');
  const resources = createConnectionResourceService({ database, secrets });
  return { database, projects, a, b, configuration, secrets, resources };
}

it('deletes only local project data and scoped Secrets, allows reimport, and preserves shared resources', () => {
  const f = fixture();
  const { database, a, b, secrets, projects, resources } = f;
  try {
    const token = resources.createGithubCredential({ name: 'Shared', token: 'synthetic-token' });
    resources.bindProject(a.projectId, { githubCredentialId: token.id });
    resources.bindProject(b.projectId, { githubCredentialId: token.id });
    const file = resources.createProjectFile(a.projectId, {
      path: '.env.test',
      content: 'A=secret',
    });
    secrets.project(a.projectId).set('testPassword', 'synthetic-a');
    secrets.project(b.projectId).set('testPassword', 'synthetic-b');
    for (const project of [a, b]) {
      const runs = createProjectRunStore(database, project.projectId);
      const runId = `RUN-${project.displayName}`;
      runs.importCompleted({
        runId,
        trigger: 'manual',
        baseCommit: null,
        targetCommit: 'a'.repeat(40),
        includedCommits: [],
        result: 'passed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        completedDirectory: `/tmp/${runId}`,
        artifacts: { 'report.md': 'synthetic-report' },
        scenarioResults: [],
        confirmedBugs: [],
      });
      runs.markReport(runId, { status: 'published' });
      runs.completeArchive(runId, { reportReady: true });
    }
    database.prepare("UPDATE projects SET status = 'active' WHERE project_id = ?").run(a.projectId);
    const beforeB = projects.get(b.projectId);
    deleteProject(database, a.projectId);
    assert.equal(projects.get(a.projectId), null);
    assert.deepEqual(projects.list(), [beforeB]);
    assert.equal(secrets.project(a.projectId).has('testPassword'), false);
    assert.equal(secrets.resource('project-file', file.id).has('content'), false);
    assert.equal(secrets.project(b.projectId).get('testPassword'), 'synthetic-b');
    assert.equal(resources.githubToken(token.id), 'synthetic-token');
    assert.equal(resources.bindings(b.projectId).githubCredentialId, token.id);
    assert.equal(createProjectRunStore(database, b.projectId).get('RUN-B')?.result, 'passed');
    assert.equal(
      database.prepare('SELECT 1 FROM run_store_artifacts WHERE run_id = ?').get('RUN-A'),
      undefined,
    );
    const reimported = projects.createVerified({
      displayName: 'A again',
      repository: {
        githubRepositoryId: a.githubRepositoryId,
        owner: a.repositoryOwner,
        name: a.repositoryName,
      },
    });
    assert.notEqual(reimported.projectId, a.projectId);
    assert.equal(resources.bindings(reimported.projectId).githubCredentialId, null);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
});

it.each(['queued', 'running', 'waiting_archive', 'archive_failed', 'archive_partial'])(
  'rejects deletion with a %s task atomically',
  (status) => {
    const { database, a, projects } = fixture();
    try {
      database
        .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
        .run(a.projectId);
      const queue = createProjectTestRequestQueue(database, a.projectId).enqueue({
        trigger: 'manual',
        request: 'test',
      });
      database
        .prepare('UPDATE test_request_queue SET status = ?, archive_status = ? WHERE queue_id = ?')
        .run(
          status.startsWith('archive_') ? 'completed' : status,
          status.startsWith('archive_') ? status.slice(8) : null,
          queue.queueId,
        );
      assert.throws(() => deleteProject(database, a.projectId), /待处理任务/);
      assert.ok(projects.get(a.projectId));
      assert.ok(
        database.prepare('SELECT 1 FROM project_config WHERE project_id = ?').get(a.projectId),
      );
    } finally {
      database.close();
    }
  },
);

it.each(['planned', 'created', 'cleanup_pending', 'unknown'])(
  'retains a project with %s resources',
  (state) => {
    const { database, a, projects } = fixture();
    try {
      database
        .prepare(
          `INSERT INTO execution_resource_ledger
      (resource_id, instance_id, project_id, attempt_id, execution_location_id, execution_location_revision,
       resource_type, owner_labels_json, state, created_at, updated_at)
      VALUES ('resource', 'instance', ?, 'attempt', 'local:instance', 1, 'image-preparation', '{}', ?, 'now', 'now')`,
        )
        .run(a.projectId, state);
      assert.throws(() => deleteProject(database, a.projectId), /未回收的运行资源/);
      assert.ok(projects.get(a.projectId));
      database
        .prepare("UPDATE execution_resource_ledger SET state = 'released', occupies_slot = 0")
        .run();
      deleteProject(database, a.projectId);
      assert.deepEqual(database.pragma('foreign_key_check'), []);
    } finally {
      database.close();
    }
  },
);

it('rejects preparing images and live Run snapshots even without queue entries', () => {
  const { database, a } = fixture();
  try {
    database
      .prepare(
        `INSERT INTO execution_image_cache VALUES ('local:instance', 1, ?, ?, 'build', 'linux/amd64', NULL, 'preparing', NULL, 'now')`,
      )
      .run(a.projectId, 'a'.repeat(40));
    assert.throws(() => deleteProject(database, a.projectId), /仍在准备/);
    database.prepare('DELETE FROM execution_image_cache').run();
    database.prepare("INSERT INTO active_run_snapshots VALUES ('run', ?, '{}')").run(a.projectId);
    assert.throws(() => deleteProject(database, a.projectId), /未回收的运行资源/);
  } finally {
    database.close();
  }
});

it('authenticates deletion, rejects foreign origins, and returns not found after deletion', async () => {
  const f = fixture();
  const app = Fastify();
  try {
    await app.register(fastifyCookie);
    await registerProjectAdminRoutes(app, {
      ...f,
      auth: {
        isConfigured: () => true,
        authenticate: (token) => token === 'valid',
        login: async () => null,
        logout() {},
        changePassword: async () => false,
        revokeAll() {},
      },
      deployment: createDeploymentConfigurationStore(f.database, {
        repoDir: '/repos',
        reportDir: '/reports',
      }),
      readiness: {
        check: async () => {
          throw new Error('unused');
        },
        latest: () => null,
        pause: () => {
          throw new Error('unused');
        },
        resume: async () => {
          throw new Error('unused');
        },
      },
      images: {
        prepare: async () => {
          throw new Error('unused');
        },
      },
    });
    const url = `/api/projects/${f.a.projectId}`;
    assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 401);
    const headers = { cookie: 'luowang_session=valid' };
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { ...headers, origin: 'https://foreign.test' },
        })
      ).statusCode,
      403,
    );
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 404);
  } finally {
    await app.close();
    f.database.close();
  }
});

it('does not start automatic checks or restore state after deletion during background indexing', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  let polls = 0;
  try {
    f.database
      .prepare("UPDATE projects SET status = 'active' WHERE project_id = ?")
      .run(f.a.projectId);
    const scheduler = createProjectBackgroundScheduler({
      ...f,
      deployment: createDeploymentConfigurationStore(f.database, {
        repoDir: '/repos',
        reportDir: '/reports',
      }),
      repoRoot: '/repos',
      reportRoot: '/reports',
      dispatcher: {
        enqueue() {
          throw new Error('unused');
        },
        drain: async () => {},
        recover: async () => {},
        retryArchives: async () => {},
        maxConcurrentProjects: 2,
        stop: async () => {},
        currentRuns: async () => [],
        getActiveRun: async () => null,
      },
      createIndexer: (id) => ({
        sync: async () => {
          if (id === f.a.projectId) await gate.promise;
          throw new Error('synthetic-index-failure');
        },
      }),
      createPoller: () => ({
        reset() {},
        poll: async () => {
          polls++;
          throw new Error('unexpected poll');
        },
      }),
    });
    const tick = scheduler.tick();
    deleteProject(f.database, f.a.projectId);
    gate.resolve();
    await tick;
    assert.equal(polls, 0);
    assert.equal(
      f.database
        .prepare('SELECT 1 FROM project_automation_state WHERE project_id = ?')
        .get(f.a.projectId),
      undefined,
    );
  } finally {
    f.database.close();
  }
});
