import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/server/config.js';

describe('loadConfig', () => {
  it('bounds project concurrency and distinguishes missing from invalid startup values', () => {
    assert.equal(loadConfig({}).maxConcurrentProjects, 2);
    for (const value of ['1', '2', '8'])
      assert.equal(
        loadConfig({ LUOWANG_MAX_CONCURRENT_PROJECTS: value }).maxConcurrentProjects,
        Number(value),
      );
    for (const value of ['', '0', '9', '-1', '1.5', '02', 'Infinity', ' 2', '2x']) {
      assert.throws(() => loadConfig({ LUOWANG_MAX_CONCURRENT_PROJECTS: value }), ConfigError);
    }
  });
  it('uses secure local defaults and a configurable data directory', () => {
    const config = loadConfig({ LUOWANG_DATA_DIR: 'tmp/luowang-test', NODE_ENV: 'test' });

    assert.equal(config.environment, 'test');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3000);
    assert.match(config.databasePath, /luowang-test[\\/]luowang\.db$/);
    assert.match(config.repoDir, /luowang-test[\\/]repo$/);
    assert.match(config.reportDir, /luowang-test[\\/]report$/);
  });

  it('rejects invalid ports and environments', () => {
    assert.throws(
      () => loadConfig({ LUOWANG_PORT: '70000' }),
      (error: unknown) => error instanceof ConfigError,
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: 'staging' }),
      (error: unknown) => error instanceof ConfigError,
    );
  });
});
