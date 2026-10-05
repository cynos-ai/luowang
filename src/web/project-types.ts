import type { RepositoryConfig, SecretMetadata } from '../shared/types';

export type ProjectReference = {
  projectId: string;
  displayName: string;
  repositoryOwner: string;
  repositoryName: string;
  status: 'active' | 'paused';
  configRevision: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ProjectConfiguration = Omit<RepositoryConfig, 'repository'> & {
  language: string;
  testDataCleanupUrl: string;
  executionDockerfile: string;
  runtimeMode: 'managed' | 'external' | 'repository-only';
  startType: 'single-container' | 'compose';
  runtime: {
    workingDirectory: string;
    prepareCommand: string[];
    startCommand: string[];
    servicePort: number | null;
    healthPath: string;
    healthTimeoutSeconds: number;
    composeFile: string;
    composeServices: string[];
    applicationService: string;
    commandService: string;
  };
};

export type ProjectSecret = 'gitToken' | 'testUsername' | 'testPassword' | 'testDataCleanupToken';

export type ProjectDetailResponse = {
  project: ProjectReference;
  configuration: ProjectConfiguration;
  secrets: Record<ProjectSecret, SecretMetadata>;
  resources: ProjectResourceBindings;
  managedFiles: ProjectManagedFile[];
};

export type GithubCredential = {
  id: string;
  name: string;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionServer = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private-key';
  credentialConfigured: boolean;
  passphraseConfigured: boolean;
  revision: number;
  capacity: number;
  hostFingerprint: string | null;
  fingerprintConfirmedAt: string | null;
  healthStatus: 'unverified' | 'ready' | 'unavailable' | 'changed';
  capabilities: Record<string, unknown> | null;
  checkedAt: string | null;
  remoteExecutionEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionResourcesResponse = {
  githubCredentials: GithubCredential[];
  executionServers: ExecutionServer[];
};

export type ProjectResourceBindings = {
  githubCredentialId: string | null;
  executionServerId: string | null;
};

export type ProjectManagedFile = {
  id: string;
  path: string;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  serviceName: string | null;
  runtimeInjectionEnabled: boolean;
};
