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
  scenarioMode: 'autonomous' | 'add-only' | 'pr-required';
  scenarioLabels: string[];
  pollIntervalSeconds: number;
  cron: string;
  triggerOnCommit: boolean;
  environmentDescription: string;
  baseUrl: string;
}

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
    | 'THINKING_UNSUPPORTED'
    | 'REQUEST_FAILED';
}

export interface ConnectivityCheck {
  id: string;
  label: string;
  available: boolean;
  result: ConnectivityResult;
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
}

export interface RunDetail extends RunSummary {
  artifacts: Record<string, string>;
}
