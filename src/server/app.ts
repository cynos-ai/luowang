import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Logger } from 'pino';

import type { HealthResponse } from '../shared/types.js';
import type { AppConfig } from './config.js';
import type { DatabaseContext } from './db/client.js';
import { AppError, toErrorResponse } from './errors.js';
import { createLogger } from './logger.js';

export interface AppOptions {
  config: AppConfig;
  database: DatabaseContext;
  logger?: Logger;
}

function makeHealth(config: AppConfig, database: DatabaseContext): HealthResponse {
  const databaseIsHealthy = database.isHealthy();
  return {
    status: databaseIsHealthy ? 'ok' : 'degraded',
    service: 'luowang',
    version: config.version,
    database: databaseIsHealthy ? 'ok' : 'error',
    timestamp: new Date().toISOString(),
  };
}

export async function createApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger ?? createLogger(options.config),
    requestIdHeader: 'x-request-id',
  });
  const staticRoot = options.config.webRoot;

  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: 'index.html',
    });
  }

  app.get('/health', async (request, reply) => {
    const health = makeHealth(options.config, options.database);
    reply.header('x-request-id', request.id);
    return reply.status(health.status === 'ok' ? 200 : 503).send(health);
  });

  app.get('/api/status', async (request, reply) => {
    reply.header('x-request-id', request.id);
    return reply.send(makeHealth(options.config, options.database));
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/') && existsSync(staticRoot)) {
      return reply.sendFile('index.html');
    }

    reply.header('x-request-id', request.id);
    return reply.status(404).send(toErrorResponse('NOT_FOUND', 'Resource not found', request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const possibleError = error as { statusCode?: unknown; name?: unknown; message?: unknown };
    const statusCode =
      error instanceof AppError
        ? error.statusCode
        : typeof possibleError.statusCode === 'number'
          ? possibleError.statusCode
          : 500;
    const code =
      error instanceof AppError
        ? error.code
        : statusCode === 400
          ? 'BAD_REQUEST'
          : 'INTERNAL_ERROR';
    const message =
      error instanceof AppError || statusCode < 500
        ? typeof possibleError.message === 'string'
          ? possibleError.message
          : 'Request failed'
        : 'Internal server error';

    request.log.error(
      {
        requestId: request.id,
        errorCode: code,
        errorName: typeof possibleError.name === 'string' ? possibleError.name : 'UnknownError',
        statusCode,
      },
      'request failed',
    );
    reply.header('x-request-id', request.id);
    return reply.status(statusCode).send(toErrorResponse(code, message, request.id));
  });

  app.addHook('onClose', async () => {
    options.database.close();
  });

  return app;
}
