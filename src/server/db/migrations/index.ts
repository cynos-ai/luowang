import { foundationMigration } from './0000-foundation.js';
import { secureConsoleMigration } from './0001-secure-console.js';
import { repositoryIndexMigration } from './0002-repository-index.js';
import { runArchiveMigration } from './0003-run-archive.js';
import { automationRecoveryMigration } from './0004-automation-recovery.js';
import { scenarioLifecycleMigration } from './0005-scenario-lifecycle.js';

export type { Migration } from './0000-foundation.js';

export const migrations = [
  foundationMigration,
  secureConsoleMigration,
  repositoryIndexMigration,
  runArchiveMigration,
  automationRecoveryMigration,
  scenarioLifecycleMigration,
];
