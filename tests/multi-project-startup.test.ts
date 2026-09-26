import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { startProjectServer } from '../src/server/projects/main.js';
import { runUpgradeCli } from '../src/server/projects/upgrade-cli.js';

it('starts only after offline upgrade and serves the new console without legacy business routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-project-start-'));
  const databasePath = join(root, 'luowang.db');
  const webRoot = join(root, 'web');
  const environment = {
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: root,
    LUOWANG_DATABASE_PATH: databasePath,
    LUOWANG_WEB_ROOT: webRoot,
    LUOWANG_HOST: '127.0.0.1',
    LUOWANG_PORT: '0',
    LUOWANG_LOG_LEVEL: 'silent',
    LUOWANG_ADMIN_PASSWORD: 'startup-test-password-123',
    LUOWANG_MASTER_KEY: 'startup-test-master-key',
  };
  try {
    await assert.rejects(startProjectServer(environment), /已完成离线升级/);
    const legacy = new Database(databasePath);
    try {
      runMigrations(legacy);
    } finally {
      legacy.close();
    }
    await assert.rejects(startProjectServer(environment), /迁移不完整/);
    const backupDir = join(root, 'backup');
    await runUpgradeCli(['backup', backupDir], environment);
    await runUpgradeCli(['upgrade-empty', backupDir], environment);
    await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<html><body>PROJECT-CONSOLE</body></html>');
    const server = await startProjectServer(environment);
    try {
      const address = server.app.server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal((await (await fetch(`${base}/api/mode`)).json()).mode, 'multi-project');
      assert.match(await (await fetch(base)).text(), /PROJECT-CONSOLE/);
      assert.match(await (await fetch(`${base}/projects/deep-link`)).text(), /PROJECT-CONSOLE/);
      assert.equal((await fetch(`${base}/api/config`)).status, 404);
      assert.equal((await fetch(`${base}/api/projects`)).status, 401);
    } finally {
      await server.shutdown('test');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
