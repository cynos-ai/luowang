import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: text('applied_at').notNull(),
});

export const systemMetadata = sqliteTable('system_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const adminCredentials = sqliteTable('admin_credentials', {
  id: integer('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const authSessions = sqliteTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const appConfig = sqliteTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const secretEntries = sqliteTable('secret_entries', {
  key: text('key').primaryKey(),
  nonce: text('nonce').notNull(),
  ciphertext: text('ciphertext').notNull(),
  authTag: text('auth_tag').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const connectivityCheckResults = sqliteTable('connectivity_check_results', {
  checkId: text('check_id').primaryKey(),
  status: text('status').notNull(),
  message: text('message').notNull(),
  checkedAt: text('checked_at').notNull(),
  latencyMs: integer('latency_ms'),
});

export const repositoryIndexState = sqliteTable('repository_index_state', {
  id: integer('id').primaryKey(),
  repository: text('repository').notNull(),
  scenarioBranch: text('scenario_branch').notNull(),
  commitSha: text('commit_sha'),
  syncedAt: text('synced_at'),
});

export const indexedScenarios = sqliteTable('indexed_scenarios', {
  path: text('path').primaryKey(),
  scenarioId: text('scenario_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull(),
  tagsJson: text('tags_json').notNull(),
  content: text('content').notNull(),
  commitSha: text('commit_sha').notNull(),
  indexedAt: text('indexed_at').notNull(),
});

export const indexedReports = sqliteTable('indexed_reports', {
  runId: text('run_id').primaryKey(),
  path: text('path').notNull().unique(),
  trigger: text('trigger').notNull(),
  baseCommit: text('base_commit'),
  targetCommit: text('target_commit').notNull(),
  includedCommitsJson: text('included_commits_json').notNull(),
  result: text('result').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
  scenarioResultsJson: text('scenario_results_json').notNull(),
  confirmedBugsJson: text('confirmed_bugs_json').notNull(),
  filesJson: text('files_json').notNull(),
  content: text('content').notNull(),
  commitSha: text('commit_sha').notNull(),
  indexedAt: text('indexed_at').notNull(),
});

export const repositoryIndexErrors = sqliteTable('repository_index_errors', {
  path: text('path').primaryKey(),
  message: text('message').notNull(),
  commitSha: text('commit_sha').notNull(),
  indexedAt: text('indexed_at').notNull(),
});

export const runStoreRuns = sqliteTable('run_store_runs', {
  runId: text('run_id').primaryKey(),
  status: text('status').notNull(),
  trigger: text('trigger').notNull(),
  request: text('request').notNull(),
  baseCommit: text('base_commit'),
  targetCommit: text('target_commit').notNull(),
  includedCommitsJson: text('included_commits_json').notNull(),
  result: text('result').notNull(),
  scenarioResultsJson: text('scenario_results_json').notNull(),
  confirmedBugsJson: text('confirmed_bugs_json').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
  completedDirectory: text('completed_directory').notNull(),
  reportPath: text('report_path').notNull(),
  reportStatus: text('report_status').notNull(),
  reportCommitSha: text('report_commit_sha'),
  archiveStatus: text('archive_status').notNull(),
  archiveError: text('archive_error'),
  progressed: integer('progressed').notNull(),
  progressedAt: text('progressed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runStoreArtifacts = sqliteTable('run_store_artifacts', {
  runId: text('run_id').notNull(),
  name: text('name').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runStoreIssues = sqliteTable('run_store_issues', {
  runId: text('run_id').notNull(),
  bugKey: text('bug_key').notNull(),
  title: text('title').notNull(),
  scenarioIdsJson: text('scenario_ids_json').notNull(),
  issueAction: text('issue_action').notNull(),
  requestedIssueUrl: text('requested_issue_url'),
  status: text('status').notNull(),
  issueNumber: integer('issue_number'),
  issueUrl: text('issue_url'),
  errorMessage: text('error_message'),
  attempts: integer('attempts').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runStoreProgress = sqliteTable('run_store_progress', {
  id: integer('id').primaryKey(),
  lastCompletedTarget: text('last_completed_target'),
  runId: text('run_id'),
  updatedAt: text('updated_at'),
});

export const testRequestQueue = sqliteTable('test_request_queue', {
  queueId: integer('queue_id').primaryKey({ autoIncrement: true }),
  requestId: text('request_id').notNull().unique(),
  trigger: text('trigger').notNull(),
  request: text('request').notNull(),
  targetRef: text('target_ref'),
  triggerSourcesJson: text('trigger_sources_json').notNull(),
  requestIdsJson: text('request_ids_json').notNull(),
  status: text('status').notNull(),
  runId: text('run_id'),
  claimedAt: text('claimed_at'),
  waitingArchiveAt: text('waiting_archive_at'),
  completedAt: text('completed_at'),
  errorMessage: text('error_message'),
  archiveStatus: text('archive_status'),
  progressed: integer('progressed'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const automationState = sqliteTable('automation_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const interruptedRunRecords = sqliteTable('interrupted_run_records', {
  runId: text('run_id').primaryKey(),
  trigger: text('trigger').notNull(),
  request: text('request').notNull(),
  baseCommit: text('base_commit'),
  targetCommit: text('target_commit'),
  includedCommitsJson: text('included_commits_json').notNull(),
  startedAt: text('started_at').notNull(),
  interruptedAt: text('interrupted_at').notNull(),
  runningDirectory: text('running_directory'),
  artifactNamesJson: text('artifact_names_json').notNull(),
  errorMessage: text('error_message').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
