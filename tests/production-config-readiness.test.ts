import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { describe, it } from 'vitest';
import { createConfigurationStore } from '../src/server/configuration.js';
import { buildSessionInput } from '../src/server/runs/agent-session.js';
import type { AgentRole, AgentSessionKind } from '../src/server/runs/types.js';

describe('production stage configuration', () => {
  it('defaults three agents to low/off/low without overwriting stored settings', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
      const paths = { repoDir: '/tmp/repo', reportDir: '/tmp/reports' };
      const store = createConfigurationStore(db, paths);
      assert.deepEqual(Object.keys(store.getHarness().agents), ['main', 'runner', 'reviewer']);
      assert.deepEqual(
        Object.values(store.getHarness().agents).map((a) => a.thinking),
        ['low', 'off', 'low'],
      );
      store.updateHarness({
        agents: {
          main: { model: 'existing-main', thinking: 'medium' },
          runner: { model: 'existing-runner', thinking: 'high' },
          reviewer: { model: 'existing-reviewer', thinking: 'off' },
        },
      });
      const before = db.prepare('SELECT value FROM app_config').get();
      const reopened = createConfigurationStore(db, paths).getHarness();
      assert.deepEqual(
        Object.values(reopened.agents).map((a) => a.thinking),
        ['medium', 'high', 'off'],
      );
      assert.deepEqual(db.prepare('SELECT value FROM app_config').get(), before);
    } finally {
      db.close();
    }
  });

  it('passes product-owned stage thinking to Sessions without mutating model configuration', () => {
    const config = Object.freeze({ model: 'configured-model', thinking: 'medium' as const });
    const stages: [AgentRole, AgentSessionKind][] = [
      ['main-a', 'main-planning'],
      ['runner', 'runner-execution'],
      ['reviewer', 'reviewer-audit'],
      ['main-b', 'main-finalization'],
    ];
    const inputs = stages.map(([role, stage]) =>
      buildSessionInput(role, stage, config, '/tmp', [], 'rules', 'task', []),
    );
    assert.deepEqual(
      inputs.map((i) => i.config.thinking),
      ['low', 'off', 'low', 'off'],
    );
    assert.ok(inputs.every((i) => i.config.model === config.model && i.config !== config));
    assert.equal(config.thinking, 'medium');
  });
});
