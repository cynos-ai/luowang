export type ServiceStatus = 'ok' | 'degraded';

export type DatabaseStatus = 'ok' | 'error';

export interface HealthResponse {
  status: ServiceStatus;
  service: 'luowang';
  version: string;
  database: DatabaseStatus;
  timestamp: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentConfig {
  model: string;
  thinking: ThinkingLevel;
}

export interface HarnessConfig {
  language: string;
  provider: string;
  providerBaseUrl: string;
  agents: {
    main: AgentConfig;
    runner: AgentConfig;
    reviewer: AgentConfig;
  };
  local: {
    repoDir: string;
    reportDir: string;
    retentionDays: number;
  };
  mcp: {
    enabled: boolean;
    browser: 'chromium' | 'firefox' | 'webkit';
    headless: boolean;
    timeoutMs: number;
  };
  oss: {
    endpoint: string;
    region: string;
    bucket: string;
    publicBaseUrl: string;
    accessMode: 'public' | 'private';
    objectPrefix: string;
  };
}

export interface RepositoryConfig {
  repository: string;
  scenarioBranch: string;
  scenarioMode: ScenarioMode;
  scenarioLabels: string[];
  pollIntervalSeconds: number;
  cron: string;
  triggerOnCommit: boolean;
  environmentDescription: string;
  baseUrl: string;
  externalDatabase: string;
}

export type ScenarioMode = 'autonomous' | 'add-only' | 'review-all';

export interface SecretMetadata {
  configured: boolean;
  masked: string | null;
}

export type SecretKey =
  | 'providerApiKey'
  | 'gitToken'
  | 'testUsername'
  | 'testPassword'
  | 'ossAccessKeyId'
  | 'ossAccessKeySecret';

export type SecretMetadataMap = Record<SecretKey, SecretMetadata>;

export interface ConfigResponse {
  harness: HarnessConfig;
  repository: RepositoryConfig;
  secrets: SecretMetadataMap;
  secretStore: {
    available: boolean;
  };
}

export interface AuthStatusResponse {
  configured: boolean;
  authenticated: boolean;
}

export type ConnectivityStatus =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'unreachable'
  | 'unknown'
  | 'not_checked'
  | 'not_configured'
  | 'not_available';

export interface ConnectivityResult {
  status: ConnectivityStatus;
  message: string;
  checkedAt: string | null;
  latencyMs: number | null;
  code?:
    | 'AUTH_NOT_CONFIGURED'
    | 'AUTHENTICATION_FAILED'
    | 'PROVIDER_NOT_FOUND'
    | 'MODEL_NOT_FOUND'
    | 'VISION_UNSUPPORTED'
    | 'THINKING_UNSUPPORTED'
    | 'REQUEST_FAILED';
}

export interface ConnectivityCheck {
  id: string;
  label: string;
  available: boolean;
  result: ConnectivityResult;
}

export interface ProviderInfo {
  id: string;
  name: string;
}

export interface ProviderModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  thinkingLevels: ThinkingLevel[];
  available: boolean;
}

export type ScenarioStatus = 'draft' | 'approved' | 'deprecated';

export interface GitCommit {
  sha: string;
  authoredAt: string;
  subject: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface IndexedScenario {
  id: string;
  path: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  tags: string[];
  content: string;
  commitSha: string;
  indexedAt: string;
}

export type RunResult = 'passed' | 'failed' | 'blocked';

export interface ScenarioResultSummary {
  id: string;
  result: RunResult;
}

export interface EvidenceReference {
  id: string;
  filename: string;
  objectKey: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export interface ConfirmedBugSummary {
  key: string;
  title: string;
  scenarioIds: string[];
  issueAction: 'create' | 'link';
  issueUrl?: string;
}

export interface IndexedReport {
  runId: string;
  path: string;
  trigger: 'git' | 'schedule' | 'manual' | 'api';
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  result: RunResult;
  startedAt: string;
  finishedAt: string;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
  files: Record<string, string>;
  content: string;
  commitSha: string;
  indexedAt: string;
}

export interface IndexErrorItem {
  path: string;
  message: string;
}

export interface RepositoryStatusResponse {
  configured: boolean;
  availability: 'available' | 'unavailable' | 'not_configured';
  errorMessage: string | null;
  repository: string;
  scenarioBranch: string;
  localReady: boolean;
  remoteHead: string | null;
  indexedCommit: string | null;
  lastSyncedAt: string | null;
  indexErrors: IndexErrorItem[];
}

export interface RepositorySyncResponse {
  status: 'synced' | 'not_configured' | 'failed';
  commitSha: string | null;
  syncedAt: string | null;
  scenarios: number;
  reports: number;
  errors: IndexErrorItem[];
  message: string;
}

export interface RepositoryHistoryResponse {
  status: 'ok' | 'degraded' | 'not_configured';
  reports: IndexedReport[];
  issues: RepositoryIssue[];
  issuesAvailable: boolean;
  issuesMessage: string | null;
}

export interface RepositoryIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  createdAt: string;
  updatedAt: string;
}

export type RunTrigger = 'git' | 'schedule' | 'manual' | 'api';

export type RunLifecycleStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export type RunPhase =
  | 'preparing'
  | 'main-a'
  | 'runner'
  | 'reviewer'
  | 'main-b'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface RunSummary {
  runId: string;
  status: RunLifecycleStatus;
  phase: RunPhase;
  result: RunResult | null;
  trigger: RunTrigger;
  request: string;
  baseCommit: string | null;
  targetCommit: string | null;
  includedCommits: string[];
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  artifactNames: string[];
  evidence?: EvidenceReference[];
  scenarioMode?: ScenarioMode;
  initialization?: boolean;
  scenarioPrUrl?: string | null;
  currentScenario?: string | null;
  scenarioProgress?: {
    completed: number;
    total: number;
  };
  activities?: RunActivity[];
  blockingReasons?: string[];
  updatedAt?: string;
}

export interface RunDetail extends RunSummary {
  artifacts: Record<string, string>;
}

export interface RunActivity {
  at: string;
  message: string;
  kind: 'phase' | 'info' | 'warning';
}

export type StoredReportStatus = 'pending' | 'published' | 'not_applicable' | 'conflict' | 'failed';

export type StoredArchiveStatus = 'pending' | 'partial' | 'completed' | 'failed';

export type StoredScenarioStatus =
  'not_applicable' | 'pending' | 'published' | 'pull_request' | 'failed';

export type StoredIssueStatus = 'pending' | 'succeeded' | 'failed';

export interface OperationsIssueLink {
  bugKey: string;
  title: string;
  scenarioIds: string[];
  issueAction: 'create' | 'link';
  requestedIssueUrl: string | null;
  status: StoredIssueStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  errorMessage: string | null;
  attempts: number;
}

export interface OperationsArchiveView {
  reportStatus: StoredReportStatus;
  reportCommitSha: string | null;
  archiveStatus: StoredArchiveStatus;
  archiveError: string | null;
  progressed: boolean;
  progressedAt: string | null;
  scenarioStatus: StoredScenarioStatus;
  scenarioCommitSha: string | null;
  scenarioPrUrl: string | null;
  scenarioError: string | null;
}

export interface OperationsRunSummary extends RunSummary {
  archive: OperationsArchiveView | null;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
  issues: OperationsIssueLink[];
}

export interface OperationsRunDetail extends OperationsRunSummary {
  artifacts: Record<string, string>;
}

export interface ScenarioRunHistory {
  runId: string;
  result: RunResult;
  finishedAt: string;
  targetCommit: string;
}

export interface OperationsScenario extends IndexedScenario {
  history: ScenarioRunHistory[];
  pendingPullRequests: Array<{
    runId: string;
    url: string;
    targetCommit: string;
  }>;
}

export interface OperationsScenarioReview {
  runId: string;
  url: string;
  targetCommit: string;
  result: RunResult;
  createdAt: string;
  errorMessage: string | null;
}

export interface OperationsGitCommit extends GitCommit {
  includedRuns: Array<{
    runId: string;
    result: RunResult;
    targetCommit: string;
  }>;
  targetRuns: Array<{
    runId: string;
    result: RunResult;
    issueUrls: string[];
    scenarioPrUrl: string | null;
  }>;
}

export interface OperationsGitTreeResponse {
  branch: string;
  commit: string;
  entries: OperationsGitCommit[];
  stale: boolean;
  staleReason: string | null;
}

export interface OperationsCurrentRun {
  run: OperationsRunSummary;
  role: 'main-a' | 'runner' | 'reviewer' | 'main-b' | null;
  stage: string;
  currentScenario: string | null;
  progress: {
    completed: number;
    total: number;
  };
  activities: RunActivity[];
  blockingReasons: string[];
  files: string[];
  updatedAt: string;
}

export interface OperationsCurrentResponse {
  current: OperationsCurrentRun | null;
  fetchedAt: string;
}

export interface OperationsQueueItem {
  queueId: number;
  requestId: string;
  trigger: RunTrigger;
  triggerSources: RunTrigger[];
  requestIds: string[];
  request: string;
  targetRef: string | null;
  requestKind: 'automatic-head' | 'manual-current-head' | 'manual-merge-source';
  sourceRef: string | null;
  preparedMergeCommit: string | null;
  preparedMergeMode: 'existing-branch' | 'initial-create' | null;
  resolvedTargetCommit: string | null;
  status: 'queued' | 'running' | 'waiting_archive' | 'completed' | 'failed' | 'interrupted';
  runId: string | null;
  claimedAt: string | null;
  waitingArchiveAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  archiveStatus: StoredArchiveStatus | null;
  progressed: boolean | null;
  createdAt: string;
  updatedAt: string;
  initialization: boolean;
}

export interface OperationsSchedulerStatus {
  running: boolean;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastArchiveAt: string | null;
  nextArchiveAt: string | null;
  lastIndexerAt: string | null;
  nextIndexerAt: string | null;
  lastCleanupAt: string | null;
  nextCleanupAt: string | null;
  lastCronKey: string | null;
  lastError: string | null;
}

export interface OperationsDependencyHealth {
  id: string;
  label: string;
  status: 'ok' | 'degraded' | 'unavailable' | 'not_configured' | 'unknown';
  message: string;
  checkedAt: string | null;
  stale: boolean;
}

export interface OperationsDashboardResponse {
  fetchedAt: string;
  stale: boolean;
  staleReason: string | null;
  repository: RepositoryStatusResponse;
  branch: {
    name: string;
    head: string | null;
    indexedCommit: string | null;
    lastSyncedAt: string | null;
  };
  progress: {
    lastCompleted: OperationsRunSummary | null;
    lastCompletedTarget: string | null;
    latestTestableCommit: string | null;
    pendingCommits: string[];
    pendingCount: number;
  };
  activeRun: OperationsCurrentRun | null;
  queue: OperationsQueueItem[];
  workspace: {
    running: number;
    completed: number;
    pendingArchive: number;
  };
  automation: {
    scheduler: OperationsSchedulerStatus;
    lastArchiveError: string | null;
    pendingScenarioReviews: OperationsScenarioReview[];
  };
  dependencies: OperationsDependencyHealth[];
  recentRuns: OperationsRunSummary[];
}
