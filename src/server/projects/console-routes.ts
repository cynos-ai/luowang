import type { FastifyInstance } from 'fastify';

import { AppError } from '../errors.js';
import { SESSION_COOKIE_NAME, type AuthService } from '../security/auth.js';
import type { ProjectConsoleService } from './console-service.js';

const SYSTEM_CHECK_IDS = new Set(['provider', 'browser', 'oss']);
type SystemCheckId = 'provider' | 'browser' | 'oss';

export async function registerProjectConsoleRoutes(
  app: FastifyInstance,
  options: { auth: AuthService; console: ProjectConsoleService },
): Promise<void> {
  await app.register(async (routes) => {
    routes.addHook('preHandler', async (request) => {
      if (!options.auth.authenticate(request.cookies[SESSION_COOKIE_NAME])) {
        throw new AppError('UNAUTHORIZED', '需要管理员认证', 401);
      }
    });

    routes.get('/api/workspace', async () => options.console.workspace());
    routes.get('/api/system/status', async () => options.console.systemStatus());
    routes.get('/api/system/resources', async () => {
      try {
        return await options.console.resources();
      } catch {
        throw new AppError('RESOURCE_INVENTORY_FAILED', '执行资源盘点失败', 503);
      }
    });
    routes.post<{ Params: { checkId: string } }>('/api/system/checks/:checkId', async (request) => {
      if (!SYSTEM_CHECK_IDS.has(request.params.checkId)) {
        throw new AppError('SYSTEM_CHECK_INVALID', '系统检查类型无效', 400);
      }
      return {
        check: await options.console.runSystemCheck(request.params.checkId as SystemCheckId),
      };
    });
  });
}
