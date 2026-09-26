import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { ensureSystemMetadata, runMigrations } from '../../dist/server/db/migrate.js';
import { projectIdentityMigration } from '../../dist/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../../dist/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../../dist/server/db/migrations/0016-project-run-image.js';
import { recoverProjectDockerResources } from '../../dist/server/projects/docker-recovery.js';
import { inspectProjectResources } from '../../dist/server/projects/resource-inventory.js';
import { createProjectStore } from '../../dist/server/projects/store.js';

const exec = promisify(execFile);
const runId = '01K00000000000000000000099';
const targetCommit = 'e'.repeat(40);
const instanceId = randomUUID();
const database = new Database(':memory:');
const directory = await mkdtemp(join(tmpdir(), 'luowang-docker-recovery-'));
let imageId;
let containerId;

async function docker(...args) {
  return (await exec('docker', args, { timeout: 120_000 })).stdout.trim();
}

try {
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'smoke', id: () => instanceId });
  runMigrations(database, [projectIdentityMigration]);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);
  const { projectId } = createProjectStore(database).createVerified({
    displayName: 'Docker recovery smoke',
    repository: { githubRepositoryId: String(Date.now()), owner: 'cynos-ai', name: 'smoke' },
  });
  const tag = `luowang-project-${projectId}:${targetCommit}`;
  await writeFile(join(directory, 'Dockerfile'), 'FROM scratch\n');
  const iidfile = join(directory, 'image-id.txt');
  await docker(
    'build',
    '--tag',
    tag,
    '--iidfile',
    iidfile,
    '--label',
    `luowang.instance-id=${instanceId}`,
    '--label',
    `luowang.project-id=${projectId}`,
    '--label',
    `luowang.target-commit=${targetCommit}`,
    directory,
  );
  imageId = await docker('image', 'inspect', '--format', '{{.Id}}', tag);
  containerId = await docker(
    'create',
    '--name',
    `luowang-run-${runId.toLowerCase()}`,
    '--label',
    `luowang.instance-id=${instanceId}`,
    '--label',
    `luowang.project-id=${projectId}`,
    '--label',
    `luowang.run-id=${runId}`,
    imageId,
    'true',
  );

  const preview = await inspectProjectResources(database);
  assert.deepEqual(preview.containers, [{ containerId, projectId, runId }]);
  assert.deepEqual(
    preview.images.map(({ imageId: id, disposition }) => [id, disposition]),
    [[imageId, 'restart-candidate']],
  );

  assert.deepEqual(await recoverProjectDockerResources(database), {
    removedContainers: 1,
    removedImages: 1,
    retainedImages: 0,
  });
  assert.equal(await docker('ps', '--all', '--quiet', '--filter', `id=${containerId}`), '');
  assert.equal(await docker('image', 'ls', '--quiet', tag), '');
  console.log('Docker recovery smoke passed');
} finally {
  if (containerId) await docker('rm', '--force', containerId).catch(() => undefined);
  if (imageId) await docker('image', 'rm', imageId).catch(() => undefined);
  database.close();
  await rm(directory, { recursive: true, force: true });
}
