import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { createConfigurationStore } from '../src/server/configuration.js';
import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';
import { createProjectOssAdapter } from '../src/server/storage/oss.js';

describe('project-bound OSS', () => {
  it('names new objects per project and rejects another project or legacy key', async () => {
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
      const configuration = createConfigurationStore(database, {
        repoDir: '/tmp/repo',
        reportDir: '/tmp/reports',
      });
      configuration.updateHarness({
        oss: {
          endpoint: 'https://oss.example.test',
          region: 'test-region',
          bucket: 'test-bucket',
          publicBaseUrl: '',
          accessMode: 'private',
          objectPrefix: 'shared',
        },
      });
      const secrets = createScopedSecretStore(database, 'synthetic-master');
      secrets.deployment().set('ossAccessKeyId', 'access-id');
      secrets.deployment().set('ossAccessKeySecret', 'access-secret');
      const uploaded: string[] = [];
      const options = {
        clientFactory: () => ({
          send: async (command: unknown) => {
            const key = (command as { input: { Key: string } }).input.Key;
            uploaded.push(key);
            return {};
          },
        }),
      };
      const ossA = createProjectOssAdapter(database, a.projectId, configuration, secrets, options);
      const ossB = createProjectOssAdapter(database, b.projectId, configuration, secrets, options);
      const runId = '01K00000000000000000000001';
      const keyA = ossA.objectKey(runId, 'screenshot.png');
      const keyB = ossB.objectKey(runId, 'screenshot.png');
      assert.equal(keyA, `shared/projects/${a.projectId}/runs/${runId}/screenshot.png`);
      assert.equal(keyB, `shared/projects/${b.projectId}/runs/${runId}/screenshot.png`);
      await ossA.putObject(keyA, Buffer.from('A'), 'image/png');
      await ossB.putObject(keyB, Buffer.from('B'), 'image/png');
      assert.deepEqual(uploaded, [keyA, keyB]);
      assert.throws(() => ossB.stableUrlForKey(keyA), /当前项目/);
      await assert.rejects(() => ossB.getObject(keyA), /当前项目/);
      await assert.rejects(() => ossB.deleteObject(keyA), /当前项目/);
      assert.throws(() => ossA.stableUrlForKey(`shared/${runId}/screenshot.png`), /当前项目/);
      assert.throws(
        () => createProjectOssAdapter(database, '../outside', configuration, secrets, options),
        /项目不存在/,
      );
    } finally {
      database.close();
    }
  });
});
