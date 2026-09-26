import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { createRunStore } from '../src/server/runs/store.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectRunWorkspaceStore, RunWorkspaceStore } from '../src/server/runs/workspace.js';

describe('project-bound Run workspace', () => {
  it('separates new artifacts and evidence while retaining the legacy directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luowang-project-runs-'));
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const storeA = createProjectRunWorkspaceStore(database, root, a.projectId);
      const storeB = createProjectRunWorkspaceStore(database, root, b.projectId);
      const runA = '01K00000000000000000000001';
      const runB = '01K00000000000000000000002';
      const workspaceA = await storeA.create(runA);
      const workspaceB = await storeB.create(runB);
      await workspaceA.writer('main-a').writePlan('# A');
      await workspaceB.writer('main-a').writePlan('# B');
      await workspaceA.writeHarnessEvidence('command-1.json', '{"project":"A"}');
      await workspaceB.writeHarnessEvidence('command-1.json', '{"project":"B"}');
      assert.equal(storeA.root, resolve(root, 'projects', a.projectId));
      assert.equal(storeB.root, resolve(root, 'projects', b.projectId));
      assert.deepEqual(await storeA.list('running'), [runA]);
      assert.deepEqual(await storeB.list('running'), [runB]);
      assert.equal(await storeA.open(runA, 'running').read('plan.md'), '# A');
      assert.equal(await storeB.open(runB, 'running').read('plan.md'), '# B');
      assert.equal((await workspaceA.readEvidence('command-1.json')).toString(), '{"project":"A"}');
      assert.equal((await workspaceB.readEvidence('command-1.json')).toString(), '{"project":"B"}');
      assert.equal(await storeB.open(runA, 'running').exists('plan.md'), false);
      await storeA.remove(runA, 'running');
      assert.equal(await storeB.open(runB, 'running').read('plan.md'), '# B');

      const legacy = new RunWorkspaceStore(root);
      const oldRun = '01K00000000000000000000003';
      const oldWorkspace = await legacy.create(oldRun);
      await oldWorkspace.writer('main-a').writePlan('# Legacy');
      await oldWorkspace.writer('runner').writeExecution('# Execution');
      await oldWorkspace.writer('reviewer').writeReview('# Review');
      await oldWorkspace.writer('main-b').writeReport('# Report');
      await oldWorkspace.finalize();
      createRunStore(database).importCompleted({
        runId: oldRun,
        trigger: 'manual',
        baseCommit: null,
        targetCommit: 'a'.repeat(40),
        includedCommits: [],
        result: 'passed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        completedDirectory: oldWorkspace.completedDirectory,
        artifacts: await legacy.open(oldRun, 'completed').list(),
        scenarioResults: [],
        confirmedBugs: [],
      });
      migrateLegacyRunOwnership(database, a.projectId);
      assert.equal(await legacy.open(oldRun, 'completed').read('plan.md'), '# Legacy');
      assert.equal(await storeA.open(oldRun, 'completed').read('plan.md'), '# Legacy');
      assert.equal(await storeB.open(oldRun, 'completed').exists('plan.md'), false);
      database
        .prepare('UPDATE run_store_runs SET completed_directory = ? WHERE run_id = ?')
        .run(resolve(root, '..', 'outside', oldRun), oldRun);
      assert.equal(await storeA.open(oldRun, 'completed').exists('plan.md'), false);
      assert.equal(await legacy.open(oldRun, 'completed').read('plan.md'), '# Legacy');
      assert.deepEqual(await storeA.list('running'), []);
      assert.throws(
        () => createProjectRunWorkspaceStore(database, root, '../outside'),
        /项目不存在/,
      );
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
