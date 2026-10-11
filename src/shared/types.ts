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
  providerSourceId?: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface ModelProviderSource {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  verifiedAt: string | null;
  models: ProviderModelInfo[];
}

export interface HarnessConfig {
  language: string;
  /** Legacy primary source fields retained for configuration compatibility. */
  provider: string;
  providerBaseUrl: string;
  modelProviders: ModelProviderSource[];
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
  | 'testDataCleanupToken'
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
  /** Provider default API base URL from the Pi catalog, when known. */
  baseUrl?: string;
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

export interface ScreenshotInspection {
  status: 'detected' | 'not_detected' | 'unknown';
  scope: 'page';
  sha256: string;
}

export function screenshotInspectionLabel(
  inspection: Pick<ScreenshotInspection, 'status'>,
): string {
  return inspection.status === 'detected'
    ? '页面含可见表单值'
    : inspection.status === 'not_detected'
      ? '范围内未检测到可见表单值'
      : '字段检测未完成';
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
  screenshotInspection?: ScreenshotInspection;
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
  telemetry?: RunTelemetry;
  stopRequestedAt?: string | null;
  stopReason?: 'user_requested' | null;
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

export interface ModelUsage {
  provider: string;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  sdkEstimatedCostUsd: number | null;
  completeness?: 'complete' | 'partial';
}

export interface SessionUsageRecord {
  thinking?: ThinkingLevel;
  settled?: boolean;
  sessionId: string;
  kind: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: ModelUsage | null;
}

export interface RunTelemetry {
  stages: Array<{ phase: RunPhase; startedAt: string; finishedAt: string | null }>;
  sessions: SessionUsageRecord[];
}

export interface RunActivity {
  at: string;
  message: string;
  kind: 'phase' | 'info' | 'warning';
  code?:
    'test_data_cleanup_completed' | 'test_data_cleanup_failed' | 'test_data_cleanup_record_failed';
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
  execution: RunExecutionView | null;
  scenarioResults: ScenarioResultSummary[];
  confirmedBugs: ConfirmedBugSummary[];
  issues: OperationsIssueLink[];
}

export interface RunExecutionView {
  locationId: string;
  locationRevision: number;
  serverName: string;
  configRevision: number;
  startType: 'single-container' | 'compose';
  imageId: string | null;
  scenarioPatchSha256: string | null;
  baseUrl: string | null;
  applicationService: string | null;
  commandService: string | null;
  cleanupState: 'planned' | 'created' | 'cleanup_pending' | 'unknown' | 'released';
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
  sourceRunId?: string | null;
  configRevision?: number | null;
  stopRequestedAt?: string | null;
  stopReason?: 'user_requested' | null;
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

export interface ConsoleProjectReference {
  projectId: string;
  displayName: string;
  repositoryOwner: string;
  repositoryName: string;
  status: 'active' | 'paused';
}

export type ConsoleCheckStatus =
  'ok' | 'degraded' | 'unavailable' | 'not_configured' | 'unknown' | 'not_checked';

export interface ConsoleReadinessCheck {
  id: string;
  label: string;
  status: ConsoleCheckStatus;
  message: string;
  checkedAt: string | null;
}

export interface ConsoleReadinessSnapshot {
  status: 'ready' | 'not_ready' | 'stale' | 'not_checked' | 'error';
  checkedAt: string | null;
  staleReason: string | null;
  checks: ConsoleReadinessCheck[];
}

export interface ConsoleRunReference {
  runId: string;
  status: RunLifecycleStatus;
  phase: RunPhase;
  result: RunResult | null;
  targetCommit: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkspaceActiveRun extends Omit<ConsoleRunReference, 'runId'> {
  telemetry?: RunTelemetry;
  stageStartedAt?: string | null;
  lastActivityAt?: string | null;
  queueId: number;
  runId: string | null;
  project: ConsoleProjectReference;
  role: 'main-a' | 'runner' | 'reviewer' | 'main-b' | null;
  stage: string;
  currentScenario: string | null;
  progress: {
    completed: number;
    total: number;
  } | null;
  updatedAt: string;
}

export interface WorkspaceQueueItem {
  projectPosition: number;
  waitingReason: string;
  queueId: number;
  requestId: string;
  project: ConsoleProjectReference;
  request: string;
  trigger: RunTrigger;
  status: 'queued' | 'running' | 'waiting_archive';
  createdAt: string;
}

export interface WorkspaceProjectSummary {
  project: ConsoleProjectReference;
  activity: 'running' | 'queued' | 'idle' | 'paused';
  projectQueuePosition: number | null;
  recentRun: ConsoleRunReference | null;
  readiness: ConsoleReadinessSnapshot;
  attentionCount: number;
  indexedCommit: string | null;
  lastIndexedAt: string | null;
  staleReason: string | null;
  readError: {
    code: string;
    message: string;
  } | null;
}

export type WorkspaceAttentionKind =
  | 'not_ready'
  | 'blocked_run'
  | 'cleanup_failed'
  | 'archive_failed'
  | 'index_error'
  | 'scenario_review'
  | 'background_error';

export type ConsoleTarget =
  | { kind: 'project-overview' | 'project-readiness'; projectId: string }
  | { kind: 'run'; projectId: string; runId: string }
  | { kind: 'scenario'; projectId: string; scenarioId: string }
  | { kind: 'system' };

export interface WorkspaceAttentionItem {
  diagnostic?: import('./run-diagnostics.js').RunDiagnostic;
  id: string;
  kind: WorkspaceAttentionKind;
  severity: 'warning' | 'error';
  title: string;
  detail: string;
  occurredAt: string | null;
  project: ConsoleProjectReference | null;
  target: ConsoleTarget;
}

export interface WorkspaceRecentRun extends ConsoleRunReference {
  project: ConsoleProjectReference;
}

export interface WorkspaceResponse {
  fetchedAt: string;
  activeRuns: WorkspaceActiveRun[];
  capacity: { occupied: number; limit: number };
  queue: WorkspaceQueueItem[];
  projects: WorkspaceProjectSummary[];
  recentRuns: WorkspaceRecentRun[];
  attention: WorkspaceAttentionItem[];
  partialErrors: Array<{
    projectId: string | null;
    code: string;
    message: string;
  }>;
}

export interface SystemDependencyStatus {
  id: 'provider' | 'browser' | 'oss';
  label: string;
  status: ConsoleCheckStatus;
  message: string;
  checkedAt: string | null;
  lastSucceededAt: string | null;
  settingsSection: 'models' | 'browser' | 'object-storage';
}

export interface SystemCheckResponse {
  /** Persisted snapshot after the check; unavailable capabilities keep their previous row. */
  check: SystemDependencyStatus;
  /** Live outcome of this check, including reasons that are not persisted. */
  result: ConnectivityResult;
}

export interface SystemStatusResponse {
  fetchedAt: string;
  service: {
    name: 'luowang';
    version: string;
    build: string | null;
  };
  database: DatabaseStatus;
  secretStore: 'available' | 'unavailable';
  scheduler: OperationsSchedulerStatus;
  executionCapacity: { occupied: number; limit: number };
  dependencies: SystemDependencyStatus[];
  recovery: {
    guideId: 'multi-project-recovery';
    available: boolean;
  };
}

export interface SystemResourcesResponse {
  fetchedAt: string;
  instanceId: string;
  projects: string[];
  containers: Array<{
    containerId: string;
    projectId: string;
    runId: string;
  }>;
  images: Array<{
    imageId: string;
    projectId: string;
    sizeBytes: number | null;
    disposition: 'referenced' | 'restart-candidate' | 'manual-review';
  }>;
  candidateImageBytes: number;
}
