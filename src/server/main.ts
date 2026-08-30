import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { initializeDatabase } from './db/migrate.js';
import { createLogger } from './logger.js';

export async function startServer(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig({
    ...environment,
    LUOWANG_WEB_ROOT: environment.LUOWANG_WEB_ROOT ?? defaultWebRoot(),
  });
  const logger = createLogger(config);
  const database = initializeDatabase(config);

  try {
    const app = await createApp({ config, database, logger });
    const address = await app.listen({ host: config.host, port: config.port });
    logger.info({ address, version: config.version }, 'server listening');

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, 'shutdown requested');
      try {
        await app.close();
        logger.info({ signal }, 'shutdown complete');
      } catch (error) {
        logger.error(
          { signal, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'shutdown failed',
        );
        process.exitCode = 1;
      }
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    return { app, config, database, shutdown };
  } catch (error) {
    database.close();
    logger.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'server startup failed',
    );
    throw error;
  }
}

function defaultWebRoot(): string {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const builtWebRoot = resolve(projectRoot, 'dist/web');
  return existsSync(builtWebRoot) ? builtWebRoot : resolve(projectRoot, 'public');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(() => {
    process.exitCode = 1;
  });
}
