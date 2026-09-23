import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { createAdminProfileStore } from '../src/server/security/admin-profile.js';

describe('single administrator profile', () => {
  it('migrates the display name without changing password or creating users', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(database);
      database
        .prepare(
          'INSERT INTO admin_credentials (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)',
        )
        .run('synthetic-hash', '2026-01-01', '2026-01-01');
      runMigrations(database, [projectIdentityMigration]);
      const store = createAdminProfileStore(database);
      assert.deepEqual(store.get(), { displayName: '管理员' });
      assert.deepEqual(store.updateDisplayName('  测试负责人  '), { displayName: '测试负责人' });
      assert.throws(() => store.updateDisplayName('   '), /显示名称/);
      assert.throws(() => store.updateDisplayName('bad\nname'), /显示名称/);
      assert.deepEqual(
        database.prepare('SELECT id, password_hash, display_name FROM admin_credentials').all(),
        [{ id: 1, password_hash: 'synthetic-hash', display_name: '测试负责人' }],
      );
    } finally {
      database.close();
    }
  });
});
