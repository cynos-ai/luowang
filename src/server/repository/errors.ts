export type RepositoryErrorCode =
  | 'REPOSITORY_NOT_CONFIGURED'
  | 'REPOSITORY_INVALID'
  | 'GIT_COMMAND_FAILED'
  | 'SCENARIO_BRANCH_NOT_FOUND'
  | 'SCENARIO_BRANCH_INITIAL_REF_REQUIRED'
  | 'SCENARIO_BRANCH_REMOTE_CHANGED'
  | 'SCENARIO_BRANCH_HISTORY_BROKEN'
  | 'MERGE_CONFIRMATION_REQUIRED'
  | 'MERGE_CONFLICT'
  | 'MERGE_REQUEST_STATE_INVALID'
  | 'PUSH_REJECTED'
  | 'REPORT_CONFLICT'
  | 'REPORT_PUBLISH_CONFLICT'
  | 'SCENARIO_PATCH_INVALID'
  | 'SCENARIO_PUBLISH_CONFLICT'
  | 'SCENARIO_PR_CREATE_FAILED'
  | 'ISSUE_URL_INVALID'
  | 'ISSUE_NOT_FOUND'
  | 'ISSUE_CREATE_FAILED'
  | 'TARGET_INVALID'
  | 'TARGET_UNREADABLE'
  | 'INDEX_UNAVAILABLE';

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly statusCode: number;

  constructor(code: RepositoryErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class GitCommandError extends RepositoryError {
  readonly command: string[];
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(command: string[], stderr: string, exitCode: number | null, message?: string) {
    super('GIT_COMMAND_FAILED', message ?? 'Git 操作失败', 502);
    this.name = 'GitCommandError';
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}
