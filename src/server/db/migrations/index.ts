import { foundationMigration } from './0000-foundation.js';
import { secureConsoleMigration } from './0001-secure-console.js';

export type { Migration } from './0000-foundation.js';

export const migrations = [foundationMigration, secureConsoleMigration];
