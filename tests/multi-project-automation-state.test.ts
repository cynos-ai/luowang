import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectAutomationStateStore } from '../src/server/automation/state.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('project-bound automation state', () => {
  it('keeps identical poller and scheduler keys independent', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    try {
      runMigrations(database);
      runMigrations(database, [projectIdentityMigration]);
      migrateLegacyConfigurationOwnership(database, null);
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      const stateA = createProjectAutomationStateStore(database, a.projectId);
      const stateB = createProjectAutomationStateStore(database, b.projectId);
      stateA.set('git-poller.last-seen-commit', 'a'.repeat(40));
      stateB.set('git-poller.last-seen-commit', 'b'.repeat(40));
      assert.equal(stateA.get('git-poller.last-seen-commit'), 'a'.repeat(40));
      assert.equal(stateB.get('git-poller.last-seen-commit'), 'b'.repeat(40));
      stateA.delete('git-poller.last-seen-commit');
      assert.equal(stateA.get('git-poller.last-seen-commit'), null);
      assert.equal(stateB.get('git-poller.last-seen-commit'), 'b'.repeat(40));
      assert.throws(() => createProjectAutomationStateStore(database, 'missing'), /项目不存在/);
    } finally {
      database.close();
    }
  });
});
