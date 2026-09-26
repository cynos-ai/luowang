import type Database from 'better-sqlite3';

const VERSION = '0017_project_report_index_identity';

/** External repositories may contain the same historical report Run ID. Offline only. */
export function migrateProjectReportIndexIdentity(database: Database.Database): boolean {
  if (database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(VERSION))
    return false;
  if (
    !database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0010_project_index_ownership'")
      .get()
  ) {
    throw new Error('项目索引归属迁移尚未完成');
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE indexed_reports_v0617 (
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        run_id TEXT NOT NULL,
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
        PRIMARY KEY (project_id, run_id),
        UNIQUE (project_id, path)
      );
      INSERT INTO indexed_reports_v0617
        (project_id, run_id, path, trigger, base_commit, target_commit,
         included_commits_json, result, started_at, finished_at, scenario_results_json,
         confirmed_bugs_json, files_json, content, commit_sha, indexed_at)
      SELECT project_id, run_id, path, trigger, base_commit, target_commit,
             included_commits_json, result, started_at, finished_at, scenario_results_json,
             confirmed_bugs_json, files_json, content, commit_sha, indexed_at
      FROM indexed_reports;
      DROP TABLE indexed_reports;
      ALTER TABLE indexed_reports_v0617 RENAME TO indexed_reports;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(VERSION, new Date().toISOString());
  })();
  return true;
}
