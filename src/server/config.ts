import { join, resolve } from 'node:path';

import type { LevelWithSilent } from 'pino';

const DEFAULT_DATA_DIR = '/data';
const DEFAULT_VERSION = '0.1.0';
const LOG_LEVELS = new Set<LevelWithSilent>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export interface AppConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  repoDir: string;
  reportDir: string;
  webRoot: string;
  logLevel: LevelWithSilent;
  version: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readEnvironment(value: string | undefined): AppConfig['environment'] {
  const environment = value ?? 'development';
  if (environment === 'development' || environment === 'test' || environment === 'production') {
    return environment;
  }
  throw new ConfigError('NODE_ENV must be development, test, or production');
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return 3000;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('LUOWANG_PORT must be an integer between 0 and 65535');
  }
  return port;
}

function readLogLevel(value: string | undefined): LevelWithSilent {
  const level = value ?? 'info';
  if (!LOG_LEVELS.has(level as LevelWithSilent)) {
    throw new ConfigError('LUOWANG_LOG_LEVEL is not a supported log level');
  }
  return level as LevelWithSilent;
}

function readPath(value: string | undefined, fallback: string): string {
  if (value === ':memory:') {
    return value;
  }
  return resolve(value && value.trim() !== '' ? value : fallback);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = readPath(environment.LUOWANG_DATA_DIR ?? environment.DATA_DIR, DEFAULT_DATA_DIR);
  const databasePath = readPath(
    environment.LUOWANG_DATABASE_PATH ?? environment.DATABASE_PATH,
    join(dataDir, 'luowang.db'),
  );
  const repoDir = readPath(environment.LUOWANG_REPO_DIR, join(dataDir, 'repo'));
  const reportDir = readPath(environment.LUOWANG_REPORT_DIR, join(dataDir, 'report'));
  const webRoot = readPath(environment.LUOWANG_WEB_ROOT, resolve(process.cwd(), 'dist/web'));

  return {
    environment: readEnvironment(environment.NODE_ENV),
    host: environment.LUOWANG_HOST ?? environment.HOST ?? '127.0.0.1',
    port: readPort(environment.LUOWANG_PORT ?? environment.PORT),
    dataDir,
    databasePath,
    repoDir,
    reportDir,
    webRoot,
    logLevel: readLogLevel(environment.LUOWANG_LOG_LEVEL ?? environment.LOG_LEVEL),
    version: environment.LUOWANG_VERSION ?? DEFAULT_VERSION,
  };
}
