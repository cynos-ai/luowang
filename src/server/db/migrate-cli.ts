import { loadConfig } from '../config.js';
import { openDatabase } from './client.js';
import { ensureSystemMetadata, runMigrations } from './migrate.js';
import { assertLegacySchema } from '../projects/schema-mode.js';

const config = loadConfig();
const database = openDatabase(config);

try {
  assertLegacySchema(database.sqlite);
  const result = runMigrations(database.sqlite);
  ensureSystemMetadata(database.sqlite, { appVersion: config.version });
  console.log(JSON.stringify({ applied: result.applied }));
} finally {
  database.close();
}
