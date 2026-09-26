import { strict as assert } from 'node:assert';

import Database from 'better-sqlite3';
import { describe, it } from 'vitest';

import { runMigrations } from '../src/server/db/migrate.js';
import { inspectLegacyProject } from '../src/server/projects/legacy-preflight.js';

describe('legacy project ownership preflight', () => {
  it('keeps an empty instance empty', () => {
    const database = makeDatabase();
    try {
      const result = inspectLegacyProject(database);
      assert.equal(result.status, 'empty');
      assert.equal(result.configuredRepository, null);
      assert.equal(result.requiresHistoryOwnershipReview, false);
      assert.deepEqual(result.blockers, []);
    } finally {
      database.close();
    }
  });

  it('accepts matching current signals only as ready for external identity verification', () => {
    const database = makeDatabase();
    try {
      setRepository(database, 'https://github.com/Cynos-AI/Sample.git');
      database
        .prepare(
          `INSERT INTO repository_index_state
             (id, repository, scenario_branch, commit_sha, synced_at)
           VALUES (1, ?, 'scenario-testing', NULL, NULL)`,
        )
        .run('https://github.com/cynos-ai/sample');
      database
        .prepare('INSERT INTO automation_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('git-poller.repository', 'https://github.com/CYNOS-AI/SAMPLE.GIT', '2026-01-01');
      const result = inspectLegacyProject(database);
      assert.equal(result.status, 'ready_for_verification');
      assert.deepEqual(result.configuredRepository, { owner: 'Cynos-AI', name: 'Sample' });
      assert.equal(result.requiresHistoryOwnershipReview, false);
    } finally {
      database.close();
    }
  });

  it('blocks a changed indexed repository and unproven historical progress', () => {
    const database = makeDatabase();
    try {
      setRepository(database, 'https://github.com/cynos-ai/current');
      database
        .prepare(
          `INSERT INTO repository_index_state
             (id, repository, scenario_branch, commit_sha, synced_at)
           VALUES (1, ?, 'scenario-testing', NULL, NULL)`,
        )
        .run('https://github.com/cynos-ai/old');
      database
        .prepare(
          'INSERT INTO run_store_progress (id, last_completed_target, run_id, updated_at) VALUES (1, ?, NULL, ?)',
        )
        .run('a'.repeat(40), '2026-01-01');
      const result = inspectLegacyProject(database);
      assert.equal(result.status, 'blocked');
      assert.equal(result.requiresHistoryOwnershipReview, true);
      assert.ok(result.blockers.some((reason) => reason.includes('索引仓库与当前配置不一致')));
      assert.ok(result.blockers.some((reason) => reason.includes('无法证明全部历史')));
    } finally {
      database.close();
    }
  });

  it('blocks indexed data without a configured owner', () => {
    const database = makeDatabase();
    try {
      database
        .prepare(
          `INSERT INTO indexed_scenarios
             (path, scenario_id, name, description, status, tags_json, content, commit_sha, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'docs/scenario-testing/scenarios/A.md',
          'A',
          'A',
          '',
          'approved',
          '[]',
          'old',
          'a'.repeat(40),
          '2026-01-01',
        );
      const result = inspectLegacyProject(database);
      assert.equal(result.status, 'blocked');
      assert.ok(result.blockers.some((reason) => reason.includes('仓库身份未配置')));
    } finally {
      database.close();
    }
  });
});

function makeDatabase(): Database.Database {
  const database = new Database(':memory:');
  runMigrations(database);
  return database;
}

function setRepository(database: Database.Database, repository: string): void {
  database
    .prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)')
    .run('repository', JSON.stringify({ repository }), '2026-01-01');
}
