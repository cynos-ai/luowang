import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { ensureSystemMetadata } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { createProjectApp } from './app.js';
import { assertProjectSchema } from './schema-mode.js';

/** Production entrypoint. Existing instances must complete the offline upgrade first. */
export async function startProjectServer(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig({
    ...environment,
    LUOWANG_WEB_ROOT: environment.LUOWANG_WEB_ROOT ?? defaultWebRoot(),
  });
  const logger = createLogger(config);
  if (config.databasePath === ':memory:' || !existsSync(config.databasePath)) {
    throw new Error('多项目服务需要已完成离线升级的文件数据库；请先运行 db:multi-project 升级命令');
  }
  const database = openDatabase(config);
  try {
    assertProjectSchema(database.sqlite);
    const app = await createProjectApp({ config, database, logger });
    try {
      const address = await app.listen({ host: config.host, port: config.port });
      ensureSystemMetadata(database.sqlite, { appVersion: config.version });
      logger.info({ address, version: config.version }, 'multi-project server listening');

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
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
      await app.close();
      throw error;
    }
  } catch (error) {
    database.close();
    logger.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'multi-project server startup failed',
    );
    throw error;
  }
}

function defaultWebRoot(): string {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const builtWebRoot = resolve(projectRoot, 'dist/web');
  return existsSync(builtWebRoot) ? builtWebRoot : resolve(projectRoot, 'public');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startProjectServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    console.error(
      /多项目数据库|离线升级/.test(message) ? message : '多项目服务启动失败；请检查服务日志',
    );
    process.exitCode = 1;
  });
}
