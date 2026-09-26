import { strict as assert } from 'node:assert';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import {
  createRunRecoveryStore,
  createProjectRunRecoveryStore,
} from '../src/server/automation/recovery.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import {
  createProjectRuntimeConfiguration,
  createProjectRuntimeSecretStore,
} from '../src/server/projects/runtime-access.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';
import type { RunSummary } from '../src/shared/types.js';

describe('project runtime access', () => {
  it('reads project-specific configuration and secrets without legacy fallback or writes', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      runMigrations(db, [projectIdentityMigration]);
      const projects = createProjectStore(db);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      migrateLegacyRunOwnership(db, null);
      const deployment = createConfigurationStore(db, { repoDir: '/repos', reportDir: '/reports' });
      deployment.updateHarness({ provider: 'deepseek', language: 'legacy' });
      deployment.updateRepository({
        repository: 'https://github.com/example/a',
        baseUrl: 'https://legacy.example',
      });
      migrateLegacyConfigurationOwnership(db, a.projectId);
      deployment.updateRepository({
        repository: 'https://github.com/legacy/repo',
        baseUrl: 'https://legacy.example',
      });
      const config = createProjectConfigurationStore(db);
      config.update(a.projectId, { language: 'en-US', baseUrl: 'https://a.example' });
      config.update(b.projectId, { language: 'zh-CN', baseUrl: 'https://b.example' });
      const runtimeA = createProjectRuntimeConfiguration(a.projectId, deployment, config, {
        repoRoot: '/repos',
        reportRoot: '/reports',
      });
      const runtimeB = createProjectRuntimeConfiguration(b.projectId, deployment, config, {
        repoRoot: '/repos',
        reportRoot: '/reports',
      });
      assert.equal(runtimeA.getHarness().provider, 'deepseek');
      assert.equal(runtimeA.getHarness().language, 'en-US');
      assert.equal(runtimeB.getHarness().language, 'zh-CN');
      assert.equal(
        runtimeA.getHarness().local.repoDir,
        join('/repos', 'projects', a.projectId, 'repo'),
      );
      assert.equal(
        runtimeB.getHarness().local.reportDir,
        join('/reports', 'projects', b.projectId),
      );
      assert.equal(runtimeA.getRepository().repository, 'https://github.com/example/a');
      assert.equal(runtimeB.getRepository().baseUrl, 'https://b.example');
      assert.throws(() => runtimeA.updateRepository({ baseUrl: 'x' }), /只读/);
      assert.throws(
        () =>
          createProjectRuntimeConfiguration('missing', deployment, config, {
            repoRoot: '/repos',
            reportRoot: '/reports',
          }),
        /项目不存在/,
      );

      createSecretStore(db, 'synthetic-key').set('gitToken', 'legacy-token');
      const scoped = createScopedSecretStore(db, 'synthetic-key');
      scoped.deployment().set('providerApiKey', 'shared-provider');
      scoped.project(a.projectId).set('gitToken', 'token-a');
      scoped.project(b.projectId).set('gitToken', 'token-b');
      const secretsA = createProjectRuntimeSecretStore(a.projectId, scoped);
      const secretsB = createProjectRuntimeSecretStore(b.projectId, scoped);
      assert.equal(secretsA.get('gitToken'), 'token-a');
      assert.equal(secretsB.get('gitToken'), 'token-b');
      assert.equal(secretsA.get('providerApiKey'), 'shared-provider');
      assert.equal(secretsA.get('testPassword'), undefined);
      assert.equal(secretsA.metadata().gitToken.configured, true);
      assert.throws(() => secretsA.set('gitToken', 'wrong'), /只读/);
    } finally {
      db.close();
    }
  });

  it('keeps interrupted Run reads, updates, and deletes within the owner project', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      runMigrations(db, [projectIdentityMigration]);
      const projects = createProjectStore(db);
      const a = projects.createVerified({
        displayName: 'A',
        repository: { githubRepositoryId: '101', owner: 'example', name: 'a' },
      });
      const b = projects.createVerified({
        displayName: 'B',
        repository: { githubRepositoryId: '102', owner: 'example', name: 'b' },
      });
      migrateLegacyRunOwnership(db, null);
      const recoveryA = createProjectRunRecoveryStore(db, a.projectId);
      const recoveryB = createProjectRunRecoveryStore(db, b.projectId);
      recoveryA.record(interrupted('RUN-A'));
      recoveryB.record(interrupted('RUN-B'));
      assert.deepEqual(
        recoveryA.list().map((run) => run.runId),
        ['RUN-A'],
      );
      assert.equal(recoveryB.get('RUN-A'), null);
      assert.throws(() => recoveryB.record(interrupted('RUN-A')), /归属其他项目/);
      recoveryB.remove('RUN-A');
      assert.equal(recoveryA.get('RUN-A')?.runId, 'RUN-A');
      recoveryA.remove('RUN-A');
      assert.equal(recoveryA.get('RUN-A'), null);
      assert.equal(createRunRecoveryStore(db).get('RUN-B')?.runId, 'RUN-B');
    } finally {
      db.close();
    }
  });
});

function interrupted(runId: string): RunSummary {
  return {
    runId,
    status: 'interrupted',
    phase: 'interrupted',
    result: null,
    trigger: 'manual',
    request: '',
    baseCommit: null,
    targetCommit: null,
    includedCommits: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    errorMessage: 'interrupted',
    artifactNames: [],
  };
}
