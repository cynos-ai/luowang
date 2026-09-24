import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../src/server/db/migrations/0016-project-run-image.js';
import { createProjectImageStateStore } from '../src/server/projects/image-state.js';
import { createProjectRunImageStore } from '../src/server/projects/run-image.js';
import { createProjectStore } from '../src/server/projects/store.js';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const COMMIT = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;

it('records only a started Run container image matching the prepared project image', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  try {
    runMigrations(database);
    runMigrations(database, [projectIdentityMigration]);
    migrateProjectImageState(database);
    migrateProjectRunImage(database);
    migrateProjectRunImage(database);
    const projects = createProjectStore(database);
    const a = projects.createVerified({
      displayName: 'A',
      repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
    });
    const b = projects.createVerified({
      displayName: 'B',
      repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
    });
    const images = createProjectImageStateStore(database);
    const key = { projectId: a.projectId, targetCommit: COMMIT, dockerfilePath: 'Dockerfile' };
    images.begin(key);
    images.ready(key, IMAGE);
    const storeA = createProjectRunImageStore(database, a.projectId, () => '2026-01-01T00:00:00Z');
    const storeB = createProjectRunImageStore(database, b.projectId);
    const input = {
      runId: RUN,
      targetCommit: COMMIT,
      dockerfilePath: 'Dockerfile',
      imageId: IMAGE,
    };
    assert.equal(storeA.record(input).imageId, IMAGE);
    assert.equal(storeA.record(input).recordedAt, '2026-01-01T00:00:00Z');
    assert.equal(storeB.get(RUN), null);
    assert.throws(() => storeB.record(input), /已准备项目镜像不一致/);
    const keyB = { ...key, projectId: b.projectId };
    images.begin(keyB);
    images.ready(keyB, IMAGE);
    assert.throws(() => storeB.record(input), /归属其他项目/);
    assert.throws(
      () => storeA.record({ ...input, imageId: `sha256:${'c'.repeat(64)}` }),
      /已准备项目镜像不一致/,
    );
    assert.throws(
      () => storeA.record({ ...input, targetCommit: 'c'.repeat(40) }),
      /已准备项目镜像不一致/,
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});
