import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createProjectStore } from '../src/server/projects/store.js';

describe('project configuration store', () => {
  it('keeps two projects separate and never stores a mutable repository URL', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
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
      migrateLegacyRunOwnership(database, a.projectId);
      database
        .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
        .run(
          'repository',
          '{"repository":"https://github.com/example/a","baseUrl":"https://a.example"}',
          '2026-01-01',
        );
      migrateLegacyConfigurationOwnership(database, a.projectId);
      const config = createProjectConfigurationStore(database);
      assert.equal(config.get(a.projectId).baseUrl, 'https://a.example');
      assert.equal(config.get(b.projectId).baseUrl, '');
      assert.equal(config.get(a.projectId).executionDockerfile, '');
      config.update(b.projectId, {
        baseUrl: 'https://b.example',
        language: 'en-US',
        executionDockerfile: 'test/Dockerfile.luowang',
        testDataCleanupUrl: 'https://b.example/cleanup',
        triggerOnCommit: true,
        pollIntervalSeconds: 10,
      });
      assert.equal(config.get(a.projectId).baseUrl, 'https://a.example');
      assert.equal(config.get(b.projectId).baseUrl, 'https://b.example');
      assert.equal(config.get(b.projectId).pollIntervalSeconds, 300);
      assert.equal(config.get(b.projectId).language, 'en-US');
      assert.equal(config.get(b.projectId).executionDockerfile, 'test/Dockerfile.luowang');
      assert.equal(config.get(b.projectId).testDataCleanupUrl, 'https://b.example/cleanup');
      assert.equal(projects.get(b.projectId)?.configRevision, 2);
      assert.equal(projects.get(a.projectId)?.configRevision, 1);
      const stored = database
        .prepare('SELECT value FROM project_config WHERE project_id = ?')
        .get(b.projectId) as { value: string };
      assert.equal(Object.hasOwn(JSON.parse(stored.value), 'repository'), false);
      assert.throws(
        () => config.update(b.projectId, { repository: 'https://github.com/example/a' }),
        /不支持的字段/,
      );
      for (const path of ['../Dockerfile', '/Dockerfile', 'test//Dockerfile', 'test\\Dockerfile']) {
        assert.throws(() => config.update(b.projectId, { executionDockerfile: path }), /路径无效/);
      }
      for (const url of [
        'file:///tmp/cleanup',
        'https://user:pass@b.example/cleanup',
        'https://b.example/cleanup?token=x',
      ]) {
        assert.throws(
          () => config.update(b.projectId, { testDataCleanupUrl: url }),
          /清理地址无效/,
        );
      }
      assert.equal(config.get(b.projectId).executionDockerfile, 'test/Dockerfile.luowang');
      assert.throws(() => config.get('missing'), /项目不存在/);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  });
});
