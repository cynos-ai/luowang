import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectRunStore, type CompletedRunImport } from '../src/server/runs/store.js';

describe('project-bound Run Store', () => {
  it('isolates history, Run IDs, mutations, and progress', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyRunOwnership(database, null);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const runsA = createProjectRunStore(database, a.projectId);
      const runsB = createProjectRunStore(database, b.projectId);
      runsA.importCompleted(completed('RUN-A', 'a'.repeat(40)));
      runsB.importCompleted(completed('RUN-B', 'b'.repeat(40)));
      assert.deepEqual(
        runsA.list().map((run) => run.runId),
        ['RUN-A'],
      );
      assert.deepEqual(
        runsB.list().map((run) => run.runId),
        ['RUN-B'],
      );
      assert.equal(runsA.get('RUN-B'), null);
      assert.equal(runsB.get('RUN-A'), null);
      assert.throws(() => runsB.markReport('RUN-A', { status: 'published' }), /Run 不存在/);
      assert.throws(
        () => runsB.importCompleted(completed('RUN-A', 'a'.repeat(40))),
        /归属其他项目/,
      );
      runsA.markReport('RUN-A', { status: 'published' });
      runsA.completeArchive('RUN-A', { reportReady: true });
      assert.equal(runsA.getLastCompletedTarget(), 'a'.repeat(40));
      assert.equal(runsB.getLastCompletedTarget(), null);
      assert.equal(runsB.get('RUN-B')?.reportStatus, 'pending');
      runsB.markReport('RUN-B', {
        status: 'failed',
        errorMessage: '报告推送认证或权限被拒绝',
      });
      runsB.completeArchive('RUN-B', { reportReady: false });
      assert.equal(runsB.get('RUN-B')?.archiveError, '报告推送认证或权限被拒绝');
      runsB.markReport('RUN-B', { status: 'published' });
      runsB.completeArchive('RUN-B', { reportReady: true });
      assert.equal(runsB.get('RUN-B')?.archiveError, null);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});

function completed(runId: string, targetCommit: string): CompletedRunImport {
  return {
    runId,
    trigger: 'manual',
    baseCommit: null,
    targetCommit,
    includedCommits: [targetCommit],
    result: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    completedDirectory: `/tmp/${runId}`,
    artifacts: {},
    scenarioResults: [],
    confirmedBugs: [],
  };
}
