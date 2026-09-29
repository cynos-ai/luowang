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
};

export type ProjectSecret = 'gitToken' | 'testUsername' | 'testPassword' | 'testDataCleanupToken';

export type ProjectDetailResponse = {
  project: ProjectReference;
  configuration: ProjectConfiguration;
  secrets: Record<ProjectSecret, SecretMetadata>;
};
