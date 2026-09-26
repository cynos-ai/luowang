import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyIndexOwnership } from '../src/server/db/migrations/0010-project-index-ownership.js';
import { migrateProjectReportIndexIdentity } from '../src/server/db/migrations/0017-project-report-index-identity.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectRepositoryIndexer } from '../src/server/repository/indexer.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';
import type { RepositoryService } from '../src/server/repository/service.js';

const SCENARIO_PATH = 'docs/scenario-testing/scenarios/SHARED-001.md';
const REPORT_ID = '01M1GVQWWX89MQZWJW27AGBCDV';
const REPORT_PATH = `docs/scenario-testing/reports/${REPORT_ID}/report.md`;

describe('project-bound repository indexer', () => {
  it('keeps identical scenario IDs and paths independent across two projects', async () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyIndexOwnership(database, null);
      migrateProjectReportIndexIdentity(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const sourceA = fakeRepository('a', 'a'.repeat(40), 'A 的场景');
      const sourceB = fakeRepository('b', 'b'.repeat(40), 'B 的场景');
      const indexA = createProjectRepositoryIndexer(database, sourceA.service, a.projectId);
      const indexB = createProjectRepositoryIndexer(database, sourceB.service, b.projectId);
      await indexA.sync();
      await indexB.sync();
      assert.equal(indexA.getScenario('SHARED-001')?.name, 'A 的场景');
      assert.equal(indexB.getScenario('SHARED-001')?.name, 'B 的场景');
      assert.equal(indexA.listScenarios().length, 1);
      assert.equal(indexB.listScenarios().length, 1);
      assert.equal(indexB.indexState().commitSha, 'b'.repeat(40));

      sourceA.clear();
      await indexA.sync();
      assert.equal(indexA.listScenarios().length, 0);
      assert.equal(indexB.getScenario('SHARED-001')?.name, 'B 的场景');
      assert.equal(indexB.indexState().commitSha, 'b'.repeat(40));
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM indexed_scenarios').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.throws(
        () => createProjectRepositoryIndexer(database, sourceA.service, b.projectId),
        /项目身份不一致/,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });

  it('indexes equal historical report Run IDs in two repositories without mixing their content', async () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyIndexOwnership(database, null);
      migrateProjectReportIndexIdentity(database);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '201', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '202', owner: 'example', name: 'b' },
      });
      const sourceA = fakeRepository('a', 'a'.repeat(40), 'A 的场景', 'A 的历史报告');
      const sourceB = fakeRepository('b', 'b'.repeat(40), 'B 的场景', 'B 的历史报告');
      const indexA = createProjectRepositoryIndexer(database, sourceA.service, a.projectId);
      const indexB = createProjectRepositoryIndexer(database, sourceB.service, b.projectId);
      assert.equal((await indexA.sync()).status, 'synced');
      assert.equal((await indexB.sync()).status, 'synced');
      assert.match(indexA.getReport(REPORT_ID)?.content ?? '', /A 的历史报告/);
      assert.match(indexB.getReport(REPORT_ID)?.content ?? '', /B 的历史报告/);
      assert.equal(indexA.listReports().length, 1);
      assert.equal(indexB.listReports().length, 1);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});

function fakeRepository(
  name: string,
  initialCommit: string,
  scenarioName: string,
  reportText?: string,
): {
  service: RepositoryService;
  clear(): void;
} {
  let commit = initialCommit;
  let hasScenario = true;
  const git = {
    fetch: async () => undefined,
    remoteBranchHead: async () => commit,
    assertAncestor: async () => undefined,
    listTree: async () => [
      ...(hasScenario ? [{ path: SCENARIO_PATH, type: 'blob', mode: '100644' }] : []),
      ...(reportText ? [{ path: REPORT_PATH, type: 'blob', mode: '100644' }] : []),
    ],
    readFile: async (_commit: string, path: string) =>
      path === REPORT_PATH
        ? `---\nrun_id: ${REPORT_ID}\ntrigger: manual\nbase_commit: null\ntarget_commit: '${initialCommit}'\nincluded_commits: []\nresult: passed\nstarted_at: 2026-08-30T00:00:00Z\nfinished_at: 2026-08-30T00:01:00Z\nscenario_results: []\nconfirmed_bugs: []\n---\n\n# ${reportText}\n`
        : `---\nid: SHARED-001\nname: ${scenarioName}\ndescription: 测试项目内索引隔离\nstatus: approved\ntags: []\n---\n\n## 目的\n验证隔离\n`,
  } as unknown as GitRepository;
  const service = {
    getRepository: async () => git,
    getRepositoryUrl: () => `https://github.com/example/${name}`,
    getScenarioBranch: () => 'scenario-testing',
  } as RepositoryService;
  return {
    service,
    clear() {
      commit = 'c'.repeat(40);
      hasScenario = false;
    },
  };
}
