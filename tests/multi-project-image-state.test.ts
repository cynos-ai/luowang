import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createProjectStore } from '../src/server/projects/store.js';

it('keeps image preparation state separate by project, commit and Dockerfile', () => {
  const database = new Database(':memory:');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateProjectImageState(database);
    migrateProjectImageState(database);
    const projects = createProjectStore(database);
    const a = projects.createVerified({
      displayName: 'A',
      repository: { githubRepositoryId: '1', owner: 'cynos-ai', name: 'a' },
    });
    const b = projects.createVerified({
      displayName: 'B',
      repository: { githubRepositoryId: '2', owner: 'cynos-ai', name: 'b' },
    });
    const store = createProjectImageStateStore(database, () => '2026-09-24T00:00:00.000Z');
    const key = {
      projectId: a.projectId,
      targetCommit: 'a'.repeat(40),
      dockerfilePath: 'Dockerfile',
    };
    const other = { ...key, projectId: b.projectId };
    assert.equal(store.get(key), null);
    assert.equal(store.begin(key).status, 'preparing');
    assert.throws(() => store.begin(key), /正在准备/);
    assert.equal(store.begin(other).status, 'preparing');
    assert.equal(store.ready(key, `sha256:${'b'.repeat(64)}`).status, 'ready');
    assert.equal(store.get(other)?.status, 'preparing');
    assert.equal(store.fail(other, 'BUILD_FAILED').failureCode, 'BUILD_FAILED');
    assert.equal(store.get(key)?.imageId, `sha256:${'b'.repeat(64)}`);
    assert.equal(store.get({ ...key, targetCommit: 'c'.repeat(40) }), null);
    assert.equal(store.get({ ...key, dockerfilePath: 'other/Dockerfile' }), null);
    assert.throws(() => store.ready(key, `sha256:${'d'.repeat(64)}`), /状态已变化/);
    assert.equal(store.begin(other).status, 'preparing');
    assert.equal(store.interruptPreparing(), 1);
    assert.equal(store.get(other)?.failureCode, 'PREPARATION_INTERRUPTED');
    assert.equal(store.get(key)?.status, 'ready');
    assert.equal((database.pragma('foreign_key_check') as unknown[]).length, 0);
  } finally {
    database.close();
  }
});
