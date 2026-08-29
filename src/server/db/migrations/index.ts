import { foundationMigration } from './0000-foundation.js';

export type { Migration } from './0000-foundation.js';

export const migrations = [foundationMigration];
