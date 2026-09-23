import type Database from 'better-sqlite3';

const VERSION = '0010_project_index_ownership';
const OWNER_KEY = 'legacy_index_owner_project_id';

/** Staged offline migration; never call this from normal service startup. */
export function migrateLegacyIndexOwnership(
  database: Database.Database,
  legacyProjectId: string,
): boolean {
  const applied = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
    .get(VERSION);
  if (applied) {
    const owner = database
      .prepare('SELECT value FROM system_metadata WHERE key = ?')
      .get(OWNER_KEY) as { value: string } | undefined;
    if (owner?.value !== legacyProjectId) throw new Error('旧索引迁移归属与已有记录不一致');
    return false;
  }
  const project = database
    .prepare('SELECT 1 FROM projects WHERE project_id = ?')
    .get(legacyProjectId);
  if (!project) throw new Error('旧索引迁移的项目不存在');

  database.transaction(() => {
    database.exec(`
      CREATE TABLE repository_index_state_v061 (
        project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(project_id),
        repository TEXT NOT NULL,
        scenario_branch TEXT NOT NULL,
        commit_sha TEXT,
        synced_at TEXT
      );

      CREATE TABLE indexed_scenarios_v061 (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        path TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        content TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path),
        UNIQUE (project_id, scenario_id)
      );

      CREATE TABLE indexed_reports_v061 (
        run_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        path TEXT NOT NULL,
        trigger TEXT NOT NULL,
        base_commit TEXT,
        target_commit TEXT NOT NULL,
        included_commits_json TEXT NOT NULL,
        result TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        scenario_results_json TEXT NOT NULL,
        confirmed_bugs_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        content TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE (project_id, path)
      );

      CREATE TABLE repository_index_errors_v061 (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        path TEXT NOT NULL,
        message TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, path)
      );
    `);
    database
      .prepare(
        `INSERT INTO repository_index_state_v061
           (project_id, repository, scenario_branch, commit_sha, synced_at)
         SELECT ?, repository, scenario_branch, commit_sha, synced_at
         FROM repository_index_state`,
      )
      .run(legacyProjectId);
    database
      .prepare(
        `INSERT INTO indexed_scenarios_v061
           (project_id, path, scenario_id, name, description, status, tags_json,
            content, commit_sha, indexed_at)
         SELECT ?, path, scenario_id, name, description, status, tags_json,
                content, commit_sha, indexed_at
         FROM indexed_scenarios`,
      )
      .run(legacyProjectId);
    database
      .prepare(
        `INSERT INTO indexed_reports_v061
           (run_id, project_id, path, trigger, base_commit, target_commit,
            included_commits_json, result, started_at, finished_at,
            scenario_results_json, confirmed_bugs_json, files_json,
            content, commit_sha, indexed_at)
         SELECT run_id, ?, path, trigger, base_commit, target_commit,
                included_commits_json, result, started_at, finished_at,
                scenario_results_json, confirmed_bugs_json, files_json,
                content, commit_sha, indexed_at
         FROM indexed_reports`,
      )
      .run(legacyProjectId);
    database
      .prepare(
        `INSERT INTO repository_index_errors_v061
           (project_id, path, message, commit_sha, indexed_at)
         SELECT ?, path, message, commit_sha, indexed_at
         FROM repository_index_errors`,
      )
      .run(legacyProjectId);

    database.exec(`
      DROP TABLE repository_index_state;
      DROP TABLE indexed_scenarios;
      DROP TABLE indexed_reports;
      DROP TABLE repository_index_errors;
      ALTER TABLE repository_index_state_v061 RENAME TO repository_index_state;
      ALTER TABLE indexed_scenarios_v061 RENAME TO indexed_scenarios;
      ALTER TABLE indexed_reports_v061 RENAME TO indexed_reports;
      ALTER TABLE repository_index_errors_v061 RENAME TO repository_index_errors;
    `);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO system_metadata (key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(OWNER_KEY, legacyProjectId, now, now);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, now);
  })();
  return true;
}
