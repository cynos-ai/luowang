import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { createProjectAutomationStateStore } from '../src/server/automation/state.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectBackgroundScheduler } from '../src/server/projects/background-scheduler.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

it('polls active projects independently and drains through one global dispatcher', async () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateLegacyRunOwnership(database, null);
    migrateLegacyConfigurationOwnership(database, null);
    migrateProjectQueueContext(database);
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
    configuration.update(a.projectId, { pollIntervalSeconds: 60, cron: '* * * * *' });
    configuration.update(b.projectId, { pollIntervalSeconds: 60, cron: '* * * * *' });
    database.prepare("UPDATE projects SET status = 'active'").run();
    const events: string[] = [];
    let aFailed = true;
    let aIndexFailed = true;
    const dispatcher = {
      enqueue: (
        projectId: string,
        input: Parameters<ReturnType<typeof createProjectTestRequestQueue>['enqueue']>[0],
      ) => createProjectTestRequestQueue(database, projectId).enqueue(input),
      drain: async () => {
        events.push('drain');
      },
      recover: async () => {
        events.push('recover');
      },
      retryArchives: async () => {
        events.push('retry-archives');
      },
    };
    const scheduler = createProjectBackgroundScheduler({
      database,
      deployment: createConfigurationStore(database, { repoDir: '/repos', reportDir: '/reports' }),
      projects,
      configuration,
      secrets: createScopedSecretStore(database, 'test-master'),
      dispatcher,
      repoRoot: '/repos',
      reportRoot: '/reports',
      createPoller: (projectId) => ({
        reset() {},
        async poll(trigger = 'git') {
          events.push(`${projectId}:${trigger}`);
          if (projectId === a.projectId && aFailed) {
            aFailed = false;
            return {
              status: 'failed',
              trigger,
              scenarioBranch: 'scenario-testing',
              currentHead: null,
              baselineCommit: null,
              includedCommits: [],
              queue: null,
              message: 'A Git unavailable',
            };
          }
          const queue = dispatcher.enqueue(projectId, {
            trigger,
            request: 'change',
            requestKind: 'automatic-head',
          });
          return {
            status: 'queued',
            trigger,
            scenarioBranch: 'scenario-testing',
            currentHead: 'a'.repeat(40),
            baselineCommit: null,
            includedCommits: [],
            queue,
            message: 'queued',
          };
        },
      }),
      createIndexer: (projectId) => ({
        async sync() {
          events.push(`${projectId}:index`);
          if (projectId === a.projectId && aIndexFailed) {
            aIndexFailed = false;
            throw new Error('A index unavailable');
          }
          return {
            status: 'synced',
            commitSha: 'a'.repeat(40),
            syncedAt: '2026-01-01T00:00:00.000Z',
            scenarios: 0,
            reports: 0,
            errors: [],
            message: 'synced',
          };
        },
      }),
    });
    const first = new Date('2026-01-01T00:00:00.000Z');
    await scheduler.recover();
    await scheduler.tick(first);
    assert.equal(events.filter((event) => event.endsWith(':index')).length, 2);
    assert.equal(
      createProjectAutomationStateStore(database, a.projectId).get('scheduler.index-error'),
      'A index unavailable',
    );
    assert.equal(
      createProjectAutomationStateStore(database, b.projectId).get('scheduler.index-error'),
      null,
    );
    assert.equal(createProjectTestRequestQueue(database, a.projectId).list().length, 0);
    assert.equal(createProjectTestRequestQueue(database, b.projectId).list().length, 1);
    assert.equal(
      createProjectAutomationStateStore(database, a.projectId).get('scheduler.last-error'),
      'A Git unavailable',
    );
    assert.equal(
      createProjectAutomationStateStore(database, b.projectId).get('scheduler.last-error'),
      null,
    );
    await scheduler.tick(new Date('2026-01-01T00:00:01.000Z'));
    assert.equal(events.filter((event) => event.endsWith(':schedule')).length, 2);
    await scheduler.tick(new Date('2026-01-01T00:01:00.000Z'));
    assert.equal(createProjectTestRequestQueue(database, a.projectId).list().length, 1);
    assert.equal(
      createProjectAutomationStateStore(database, a.projectId).get('scheduler.last-error'),
      null,
    );
    const aEvents = events.filter((event) => event.startsWith(`${a.projectId}:`)).length;
    database.prepare("UPDATE projects SET status = 'paused' WHERE project_id = ?").run(a.projectId);
    await scheduler.tick(new Date('2026-01-01T00:02:00.000Z'));
    assert.equal(events.filter((event) => event.startsWith(`${a.projectId}:`)).length, aEvents);
    assert.equal(events.filter((event) => event === 'drain').length, 4);
    await scheduler.tick(new Date('2026-01-01T00:05:00.000Z'));
    assert.equal(events.filter((event) => event === `${a.projectId}:index`).length, 2);
    assert.equal(
      createProjectAutomationStateStore(database, a.projectId).get('scheduler.index-error'),
      null,
    );
    assert.equal(events.filter((event) => event === 'retry-archives').length, 5);
    await scheduler.stop();
  } finally {
    database.close();
  }
});
