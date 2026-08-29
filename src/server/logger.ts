import pino, { type Logger } from 'pino';

import type { AppConfig } from './config.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'masterKey',
  '*.masterKey',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.secrets',
  'body.password',
  'body.currentPassword',
  'body.newPassword',
  'body.secrets',
  '*.accessKeyId',
  '*.accessKeySecret',
];

export function createLogger(config: Pick<AppConfig, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'luowang' },
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
  });
}
