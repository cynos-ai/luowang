import { join } from 'node:path';

import type { ConfigurationStore } from '../configuration.js';
import type { SecretKey, SecretMetadataMap } from '../../shared/types.js';
import type { SecretStore } from '../security/secret-store.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';

const PROJECT_SECRET_KEYS = new Set<SecretKey>([
  'gitToken',
  'testUsername',
  'testPassword',
  'testDataCleanupToken',
]);

/** Read-only view of one project's runtime settings. Paths come from the deployment, not project input. */
export function createProjectRuntimeConfiguration(
  projectId: string,
  deployment: ConfigurationStore,
  projects: ProjectConfigurationStore,
  paths: { repoRoot: string; reportRoot: string },
): ConfigurationStore {
  // Fail at construction rather than allowing an unknown project to inherit deployment defaults.
  projects.get(projectId);
  return {
    getHarness() {
      const shared = deployment.getHarness();
      const project = projects.get(projectId);
      return {
        ...shared,
        language: project.language,
        local: {
          ...shared.local,
          repoDir: join(paths.repoRoot, 'projects', projectId, 'repo'),
          reportDir: join(paths.reportRoot, 'projects', projectId),
        },
      };
    },
    getRepository() {
      const {
        language: _language,
        executionDockerfile: _dockerfile,
        testDataCleanupUrl: _cleanupUrl,
        ...repository
      } = projects.get(projectId);
      void _language;
      void _dockerfile;
      void _cleanupUrl;
      // Repository identity is read from the immutable project row, never the old global key.
      return { ...repository, repository: projectRepositoryUrl(projectId, projects) };
    },
    updateHarness() {
      throw new Error('项目运行时配置只读');
    },
    updateRepository() {
      throw new Error('项目运行时配置只读');
    },
  };
}

function projectRepositoryUrl(projectId: string, projects: ProjectConfigurationStore): string {
  // ProjectConfigurationStore intentionally omits repository URL. Its own validated identity
  // is exposed by a separate accessor below.
  return projects.repositoryUrl(projectId);
}

/** Legacy SecretStore interface for runtime consumers; no mutation or cross-scope fallback. */
export function createProjectRuntimeSecretStore(
  projectId: string,
  scoped: ScopedSecretStore,
): SecretStore {
  const deployment = scoped.deployment();
  const project = scoped.project(projectId);
  const scope = (key: SecretKey) => (PROJECT_SECRET_KEYS.has(key) ? project : deployment);
  return {
    isAvailable: () => deployment.isAvailable() && project.isAvailable(),
    get: (key) => scope(key).get(key as never),
    has: (key) => scope(key).has(key as never),
    metadata: () => ({ ...deployment.metadata(), ...project.metadata() }) as SecretMetadataMap,
    set() {
      throw new Error('项目运行时 Secret 只读');
    },
    delete() {
      throw new Error('项目运行时 Secret 只读');
    },
  };
}
