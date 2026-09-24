import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { ensureSystemMetadata, runMigrations } from '../../dist/server/db/migrate.js';
import { projectIdentityMigration } from '../../dist/server/db/migrations/0009-project-identity.js';
import { migrateProjectImageState } from '../../dist/server/db/migrations/0015-project-image-state.js';
import { migrateProjectRunImage } from '../../dist/server/db/migrations/0016-project-run-image.js';
import { startProjectCommandSession } from '../../dist/server/projects/execution-container.js';
import { ensureProjectImage } from '../../dist/server/projects/image-preparation.js';
import { createProjectImageStateStore } from '../../dist/server/projects/image-state.js';
import { prepareProjectRunSource } from '../../dist/server/projects/run-source.js';
import { createProjectStore } from '../../dist/server/projects/store.js';
import { GitRepository } from '../../dist/server/repository/git-repository.js';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'luowang-two-toolchains-'));
const database = new Database(':memory:');
const instanceId = randomUUID();
const imageIds = new Set();
const containerIds = new Set();
const scenarioPath = 'docs/scenario-testing/scenarios/CHECK-001.md';

async function command(file, args, cwd = root) {
  return (await exec(file, args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function makeProject(label, dockerfile, sourceFile, sourceText, githubId) {
  const directory = join(root, `repo-${label}`);
  await command('git', ['init', '-b', 'main', directory]);
  await command('git', ['config', 'user.name', 'LuoWang Smoke'], directory);
  await command('git', ['config', 'user.email', 'luowang@example.test'], directory);
  await mkdir(join(directory, 'docs/scenario-testing/scenarios'), { recursive: true });
  await writeFile(join(directory, 'Dockerfile.luowang'), dockerfile);
  await writeFile(join(directory, sourceFile), sourceText);
  await writeFile(join(directory, scenarioPath), scenario('before'));
  await command('git', ['add', '.'], directory);
  await command('git', ['commit', '-m', 'initial'], directory);
  const targetCommit = await command('git', ['rev-parse', 'HEAD'], directory);
  await writeFile(join(directory, scenarioPath), scenario('after'));
  const patch = `${await command('git', ['diff', '--', scenarioPath], directory)}\n`;
  const projectId = createProjectStore(database).createVerified({
    displayName: label,
    repository: { githubRepositoryId: githubId, owner: 'cynos-ai', name: `smoke-${label}` },
  }).projectId;
  return {
    projectId,
    directory,
    repository: new GitRepository({ directory, remoteUrl: directory }),
    targetCommit,
    patch,
  };
}

async function prepareImage(project, targetCommit = project.targetCommit) {
  const result = await ensureProjectImage({
    repository: project.repository,
    projectId: project.projectId,
    instanceId,
    targetCommit,
    dockerfilePath: 'Dockerfile.luowang',
    storageRoot: root,
    state: createProjectImageStateStore(database),
  });
  imageIds.add(result.imageId);
  return result;
}

async function executeRun(project, imageId, runId, commandText, expected) {
  const source = await prepareProjectRunSource({
    repository: project.repository,
    projectId: project.projectId,
    runId,
    targetCommit: project.targetCommit,
    scenarioPatch: project.patch,
    storageRoot: root,
  });
  try {
    const session = await startProjectCommandSession({
      projectId: project.projectId,
      instanceId,
      runId,
      targetCommit: project.targetCommit,
      imageId,
      repositoryDirectory: project.directory,
      sourceRoot: root,
      runSource: source,
    });
    containerIds.add(session.containerId);
    try {
      const result = await session.run(commandText, {
        cwd: project.directory,
        runId,
        targetCommit: project.targetCommit,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), expected);
      assert.deepEqual(result.environmentKeys, ['LUOWANG_RUN_ID', 'LUOWANG_TARGET_COMMIT']);
    } finally {
      await session.close();
      containerIds.delete(session.containerId);
    }
  } finally {
    await source.cleanup();
  }
}

function scenario(description) {
  return `---\nid: CHECK-001\nname: Check\ndescription: ${description}\nstatus: approved\ntags: []\n---\n\nCheck.\n`;
}

try {
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'smoke', id: () => instanceId });
  runMigrations(database, [projectIdentityMigration]);
  migrateProjectImageState(database);
  migrateProjectRunImage(database);

  const node = await makeProject(
    'node',
    'FROM docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c\nWORKDIR /workspace\n',
    'read.js',
    "process.stdout.write('node:' + require('node:fs').readFileSync('docs/scenario-testing/scenarios/CHECK-001.md', 'utf8').match(/description: (.*)/)[1]);\n",
    '101',
  );
  const python = await makeProject(
    'python',
    'FROM docker.m.daocloud.io/library/python:3.13-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0\nWORKDIR /workspace\n',
    'read.py',
    "from pathlib import Path\ntext = Path('docs/scenario-testing/scenarios/CHECK-001.md').read_text()\nprint('python:' + next(line.removeprefix('description: ') for line in text.splitlines() if line.startswith('description: ')))\n",
    '102',
  );

  const nodeImage = await prepareImage(node);
  const pythonImage = await prepareImage(python);
  assert.equal(nodeImage.reused, false);
  assert.equal(pythonImage.reused, false);
  assert.notEqual(nodeImage.imageId, pythonImage.imageId);
  assert.equal((await prepareImage(node)).reused, true);
  assert.equal((await prepareImage(python)).reused, true);

  await executeRun(
    node,
    nodeImage.imageId,
    '01K00000000000000000000011',
    'node read.js',
    'node:after',
  );
  await executeRun(
    python,
    pythonImage.imageId,
    '01K00000000000000000000012',
    'python3 read.py',
    'python:after',
  );
  assert.equal(
    await command('docker', [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=luowang.instance-id=${instanceId}`,
    ]),
    '',
  );

  await command('git', ['add', '.'], node.directory);
  await command('git', ['commit', '-m', 'next target'], node.directory);
  const newCommit = await command('git', ['rev-parse', 'HEAD'], node.directory);
  const rebuilt = await prepareImage(node, newCommit);
  assert.equal(rebuilt.reused, false);
  assert.notEqual(rebuilt.imageId, nodeImage.imageId);
  assert.equal((await prepareImage(node, newCommit)).reused, true);

  await writeFile(join(node.directory, 'Dockerfile.luowang'), 'INVALID DOCKERFILE\n');
  await command('git', ['add', 'Dockerfile.luowang'], node.directory);
  await command('git', ['commit', '-m', 'broken image'], node.directory);
  const brokenCommit = await command('git', ['rev-parse', 'HEAD'], node.directory);
  await assert.rejects(() => prepareImage(node, brokenCommit), /BUILD_FAILED/);
  assert.equal((await prepareImage(python)).reused, true);
  console.log(
    JSON.stringify({
      status: 'passed',
      nodeProject: node.projectId,
      pythonProject: python.projectId,
      nodeCommit: node.targetCommit,
      pythonCommit: python.targetCommit,
      rebuiltCommit: newCommit,
      nodeImage: nodeImage.imageId,
      pythonImage: pythonImage.imageId,
      rebuiltImage: rebuilt.imageId,
    }),
  );
} finally {
  for (const containerId of containerIds) {
    await command('docker', ['rm', '--force', containerId]).catch(() => undefined);
  }
  for (const imageId of imageIds) {
    await command('docker', ['image', 'rm', '--force', imageId]).catch(() => undefined);
  }
  database.close();
  await rm(root, { recursive: true, force: true });
}
