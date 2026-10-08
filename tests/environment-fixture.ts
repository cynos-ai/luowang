import Database from 'better-sqlite3';
import { runMigrations, ensureSystemMetadata } from '../src/server/db/migrate.js';
import { projectIdentityMigration } from '../src/server/db/migrations/0009-project-identity.js';
import { migrateLegacyRunOwnership } from '../src/server/db/migrations/0011-project-run-ownership.js';
import { migrateLegacyConfigurationOwnership } from '../src/server/db/migrations/0012-project-configuration-ownership.js';
import { migrateProjectQueueContext } from '../src/server/db/migrations/0014-project-queue-context.js';
import { migrateProjectImageState } from '../src/server/db/migrations/0015-project-image-state.js';
import { migrateExecutionRuntime } from '../src/server/db/migrations/0022-execution-runtime.js';
import { createProjectStore } from '../src/server/projects/store.js';
import { createProjectConfigurationStore } from '../src/server/projects/configuration.js';
import { createDeploymentConfigurationStore } from '../src/server/projects/deployment-configuration.js';
import { createConnectionResourceService } from '../src/server/projects/connection-resources.js';
import { createScopedSecretStore } from '../src/server/security/scoped-secret-store.js';

export function environmentFixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys=ON');
  runMigrations(database);
  ensureSystemMetadata(database, { appVersion: 'fixture' });
  runMigrations(database, [projectIdentityMigration]);
  migrateLegacyRunOwnership(database, null);
  migrateLegacyConfigurationOwnership(database, null);
  migrateProjectQueueContext(database);
  migrateProjectImageState(database);
  migrateExecutionRuntime(database);
  const projects = createProjectStore(database);
  const project = projects.createVerified({
    displayName: 'fixture',
    repository: { githubRepositoryId: '111', owner: 'example', name: 'environment' },
  });
  const secrets = createScopedSecretStore(database, 'synthetic-test-key');
  const configuration = createProjectConfigurationStore(database);
  const deployment = createDeploymentConfigurationStore(database, {
    repoDir: '/repo',
    reportDir: '/reports',
  });
  const resources = createConnectionResourceService({ database, secrets });
  const commit = 'a'.repeat(40);
  configuration.update(project.projectId, {
    runtimeMode: 'managed',
    startType: 'compose',
    runtime: {
      servicePort: 8080,
      composeFile: '.luowang-generated/compose.yml',
      composeServices: ['app', 'tools'],
      applicationService: 'app',
      commandService: 'tools',
    },
  });
  return { database, projects, project, secrets, configuration, deployment, resources, commit };
}
