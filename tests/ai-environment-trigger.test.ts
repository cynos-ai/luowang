import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { it } from 'vitest';
import { createGitPoller } from '../src/server/automation/poller.js';
import { createAutomationStateStore } from '../src/server/automation/state.js';
import { createTestRequestQueue } from '../src/server/automation/queue.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import type { RunStore } from '../src/server/runs/store.js';

it('ordinary checks skip completed commits, coalesce simultaneous triggers and do not retry a failed observed head on each tick', async () => {
  const database = new Database(':memory:');
  runMigrations(database);
  const configuration = createConfigurationStore(database, {
    repoDir: '/repo',
    reportDir: '/report',
  });
  configuration.updateRepository({
    repository: 'https://github.com/example/fixture',
    triggerOnCommit: true,
  });
  const state = createAutomationStateStore(database);
  const queue = createTestRequestQueue(database);
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40),
    c = 'c'.repeat(40);
  let paths = ['src/app.ts'];
  let head = a,
    progress = a;
  const repository = {
    getScenarioBranch: () => 'scenario-testing',
    getRepository: async () => ({
      fetch: async () => {},
      remoteBranchHead: async () => head,
      commitsBetween: async (base: string, target: string) =>
        base === target ? [] : [{ sha: target, paths }],
    }),
  } as unknown as RepositoryService;
  const makePoller = () =>
    createGitPoller({
      configuration,
      state,
      repository,
      runStore: { getLastCompletedTarget: () => progress } as RunStore,
      hasPendingRequest: () => queue.listPending().length > 0,
      submitter: { submitTestRequest: async (input) => ({ queue: queue.enqueue(input) }) },
    });
  try {
    state.set('git-poller.last-seen-commit', b);
    assert.equal((await makePoller().poll('schedule')).status, 'no_change');
    assert.equal(queue.list().length, 0);
    head = b;
    state.set('git-poller.last-seen-commit', a);
    const results = await Promise.all([makePoller().poll('manual'), makePoller().poll('git')]);
    assert.equal(results.filter(({ status }) => status === 'queued').length, 1);
    assert.equal(queue.list().length, 1);
    const task = queue.claimNext()!;
    queue.fail(task.queueId, 'fixture infrastructure failure');
    assert.equal((await makePoller().poll('schedule')).status, 'no_change');
    assert.equal(queue.list().length, 1);
    progress = b;
    state.set('git-poller.last-seen-commit', a);
    assert.equal((await makePoller().poll('api')).status, 'no_change');
    head = c;
    paths = ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'];
    const ignored = await makePoller().poll('schedule');
    assert.equal(ignored.status, 'ignored');
    assert.equal(ignored.baselineCommit, b);
    assert.deepEqual(ignored.includedCommits, []);
    assert.equal(queue.list().length, 1);
    assert.equal((await makePoller().poll('git')).status, 'no_change');
    assert.equal(queue.list().length, 1);
    // Explicit retesting remains the old queue operation and is not subject to no-change checks.
    queue.enqueue({
      trigger: 'manual',
      request: 'explicit retest',
      requestKind: 'manual-current-head',
    });
    assert.equal(queue.list().length, 2);
  } finally {
    database.close();
  }
});
