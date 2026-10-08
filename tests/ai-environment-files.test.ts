import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { it } from 'vitest';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createConnectionResourceService } from '../src/server/projects/connection-resources.js';
import { decodeProjectFileContent } from '../src/server/projects/file-content.js';
import {
  readEnvironmentRecommendation,
  recordEnvironmentRecommendation,
} from '../src/server/projects/environment-recommendation.js';

function fixture() {
  const database = new Database(':memory:');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  migrateExecutionRuntime(database);
  const project = createProjectStore(database).createVerified({
    displayName: 'files',
    repository: { githubRepositoryId: '104', owner: 'example', name: 'files' },
  });
  const secrets = createScopedSecretStore(database, 'synthetic-master');
  return {
    database,
    project,
    secrets,
    resources: createConnectionResourceService({ database, secrets }),
  };
}

it('round trips binary data through the encrypted file owner, preserves purpose on edit and rolls back invalid conversions', () => {
  const { database, project, secrets, resources } = fixture();
  try {
    const bytes = Buffer.concat([Buffer.from([0, 255, 137]), Buffer.alloc(400_000, 1)]);
    const file = resources.createProjectFile(project.projectId, {
      path: 'test.sqlite',
      purpose: 'data',
      encodedContent: bytes.toString('base64'),
    });
    assert.deepEqual(
      decodeProjectFileContent(secrets.resource('project-file', file.id).get('content')!).bytes,
      bytes,
    );
    const metadata = resources.listProjectFiles(project.projectId)[0];
    assert.equal(metadata.byteSize, bytes.length);
    assert.equal(metadata.purpose, 'data');
    assert.equal('content' in metadata, false);
    assert.throws(() =>
      resources.updateProjectFile(project.projectId, file.id, { purpose: 'config' }),
    );
    assert.equal(resources.listProjectFiles(project.projectId)[0].revision, 1);
    const text = resources.createProjectFile(project.projectId, {
      path: '.env.test',
      content: 'SYNTHETIC=example',
    });
    resources.updateProjectFile(project.projectId, text.id, { purpose: 'data' });
    resources.updateProjectFile(project.projectId, text.id, { content: 'SELECT 42;' });
    const decoded = decodeProjectFileContent(
      secrets.resource('project-file', text.id).get('content')!,
    );
    assert.equal(decoded.purpose, 'data');
    assert.equal(decoded.bytes.toString(), 'SELECT 42;');
  } finally {
    database.close();
  }
});

it('keeps recommendations separate from saved definitions and hides reminders for an updated source or edited definition', () => {
  const { database, project } = fixture();
  try {
    const definition = {
      sourceCommit: 'a'.repeat(40),
      summary: 'saved',
      files: [{ path: '.luowang-generated/compose.yml', content: 'services: {}' }],
    };
    const before = JSON.stringify(definition);
    recordEnvironmentRecommendation(database, project.projectId, definition, {
      runId: 'r',
      targetCommit: 'b'.repeat(40),
      reason: '依赖增加数据库',
    });
    assert.equal(
      readEnvironmentRecommendation(database, project.projectId, definition)?.reason,
      '依赖增加数据库',
    );
    assert.equal(JSON.stringify(definition), before);
    assert.equal(
      readEnvironmentRecommendation(database, project.projectId, {
        ...definition,
        sourceCommit: 'b'.repeat(40),
      }),
      null,
    );
    assert.equal(
      readEnvironmentRecommendation(database, project.projectId, {
        ...definition,
        files: [{ ...definition.files[0], content: 'changed' }],
      }),
      null,
    );
  } finally {
    database.close();
  }
});
