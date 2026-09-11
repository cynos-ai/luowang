import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config.js';
import { createConfigurationStore } from '../configuration.js';
import { initializeDatabase } from '../db/migrate.js';
import { createPlaywrightMcpAdapter } from './playwright-mcp.js';
import { runBrowserPreflight } from './preflight.js';

const root = await mkdtemp(join(tmpdir(), 'luowang-readiness-'));
try {
  const config = loadConfig({ LUOWANG_DATA_DIR: root });
  const database = initializeDatabase(config);
  try {
    const configuration = createConfigurationStore(database.sqlite, config);
    configuration.updateHarness({ mcp: { enabled: true, browser: 'chromium' } });
    const result = await runBrowserPreflight(createPlaywrightMcpAdapter(configuration));
    console.log(JSON.stringify(result));
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    database.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
