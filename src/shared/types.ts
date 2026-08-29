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

export type ThinkingLevel = 'low' | 'medium' | 'high';

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
  'ok' | 'failed' | 'timeout' | 'unreachable' | 'not_checked' | 'not_configured' | 'not_available';

export interface ConnectivityResult {
  status: ConnectivityStatus;
  message: string;
  checkedAt: string | null;
  latencyMs: number | null;
}

export interface ConnectivityCheck {
  id: string;
  label: string;
  available: boolean;
  result: ConnectivityResult;
}
