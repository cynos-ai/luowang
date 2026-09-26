import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createProjectTestRequestQueue } from '../src/server/automation/queue.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { createGuardedScopedSecretStore } from '../src/server/projects/guarded-secrets.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

describe('multi-project configuration write guards', () => {
  it('holds active task credentials and running deployment settings without blocking other projects', () => {
    const database = setup();
    try {
      const projects = createProjectStore(database);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      createProjectConfigurationStore(database).update(a.projectId, {
        baseUrl: 'https://a.example',
      });
      const secrets = createGuardedScopedSecretStore(
        database,
        createScopedSecretStore(database, 'test-master'),
      );
      const deployment = createDeploymentConfigurationStore(database, {
        repoDir: '/repos',
        reportDir: '/reports',
      });
      secrets.project(a.projectId).set('testPassword', 'old-a');
      secrets.project(b.projectId).set('testPassword', 'old-b');
      database.prepare("UPDATE projects SET status = 'active'").run();
      const queueA = createProjectTestRequestQueue(database, a.projectId);
      const pendingA = queueA.enqueue({ trigger: 'manual', request: 'test A' });
      assert.throws(() => secrets.project(a.projectId).set('testPassword', 'new-a'), /待处理请求/);
      assert.throws(() => secrets.project(a.projectId).delete('testPassword'), /待处理请求/);
      assert.throws(
        () => secrets.project(a.projectId).set('testDataCleanupToken', 'cleanup-a'),
        /待处理请求/,
      );
      secrets.project(a.projectId).set('gitToken', 'rotated-git-a');
      secrets.project(b.projectId).set('testPassword', 'new-b');
      assert.equal(secrets.project(a.projectId).get('testPassword'), 'old-a');
      assert.equal(secrets.project(b.projectId).get('testPassword'), 'new-b');
      deployment.updateHarness({ provider: 'before-run' });
      secrets.deployment().set('providerApiKey', 'first-key');
      assert.equal(queueA.claimNext()?.queueId, pendingA.queueId);
      assert.throws(() => deployment.updateHarness({ provider: 'during-run' }), /运行中请求/);
      assert.throws(() => deployment.updateHarness({ mcp: { browser: 'webkit' } }), /运行中请求/);
      assert.equal(deployment.getHarness().provider, 'before-run');
      assert.equal(deployment.getHarness().mcp.browser, 'chromium');
      assert.throws(() => secrets.deployment().set('providerApiKey', 'second-key'), /运行中请求/);
      secrets.deployment().set('ossAccessKeyId', 'rotated-oss');
      deployment.updateHarness({ local: { retentionDays: 3 } });
      assert.equal(deployment.getHarness().local.retentionDays, 3);
      assert.throws(() => deployment.updateHarness({ language: 'en-US' }), /不属于部署配置/);
      assert.throws(() => deployment.updateHarness({ local: { repoDir: '/other' } }), /存储根目录/);
      queueA.fail(pendingA.queueId, 'synthetic');
      secrets.project(a.projectId).set('testPassword', 'new-a');
      secrets.deployment().set('providerApiKey', 'second-key');
      assert.equal(secrets.project(a.projectId).get('testPassword'), 'new-a');
      database
        .prepare("UPDATE test_request_queue SET status = 'waiting_archive' WHERE queue_id = ?")
        .run(pendingA.queueId);
      assert.throws(() => secrets.project(a.projectId).delete('testPassword'), /待处理请求/);
    } finally {
      database.close();
    }
  });

  it('preserves OSS destination when a historical Run references evidence', () => {
    const database = setup();
    try {
      const project = createProjectStore(database).createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const deployment = createDeploymentConfigurationStore(database, {
        repoDir: '/repos',
        reportDir: '/reports',
      });
      deployment.updateHarness({ oss: { bucket: 'first' } });
      database
        .prepare(
          `INSERT INTO run_store_runs
           (run_id, project_id, status, trigger, request, target_commit,
            included_commits_json, result, scenario_results_json, confirmed_bugs_json,
            started_at, finished_at, completed_directory, report_path, report_status,
            archive_status, evidence_json, created_at, updated_at)
           VALUES (?, ?, 'completed', 'manual', 'test', ?, '[]', 'passed', '[]', '[]',
                   ?, ?, '/reports/a', 'report.md', 'completed', 'completed', ?, ?, ?)`,
        )
        .run(
          'run-a',
          project.projectId,
          'a'.repeat(40),
          '2026-01-01',
          '2026-01-01',
          '[{"url":"https://oss.example/evidence"}]',
          '2026-01-01',
          '2026-01-01',
        );
      assert.throws(
        () => deployment.updateHarness({ oss: { bucket: 'second' } }),
        /已有 Run 引用 OSS 证据/,
      );
      assert.equal(deployment.getHarness().oss.bucket, 'first');
      deployment.updateHarness({ provider: 'allowed' });
      assert.equal(deployment.getHarness().provider, 'allowed');
    } finally {
      database.close();
    }
  });
});

function setup(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  return database;
}
