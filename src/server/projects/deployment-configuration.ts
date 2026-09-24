import type Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import {
  ConfigurationError,
  createConfigurationStore,
  type ConfigurationStore,
} from '../configuration.js';

const DEPLOYMENT_FIELDS = new Set(['provider', 'providerBaseUrl', 'agents', 'mcp', 'oss', 'local']);
const OSS_DESTINATION_FIELDS = [
  'endpoint',
  'region',
  'bucket',
  'publicBaseUrl',
  'accessMode',
  'objectPrefix',
] as const;

/** Deployment-only write boundary for v0.6.1. Project settings use ProjectConfigurationStore. */
export function createDeploymentConfigurationStore(
  database: Database.Database,
  paths: Pick<AppConfig, 'repoDir' | 'reportDir'>,
): ConfigurationStore {
  const legacy = createConfigurationStore(database, paths);
  const repositoryOnly = () => {
    throw new ConfigurationError('仓库配置必须通过项目入口访问');
  };
  return {
    getHarness: () => legacy.getHarness(),
    getRepository: repositoryOnly,
    updateRepository: repositoryOnly,
    updateHarness(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ConfigurationError('部署配置必须是对象');
      }
      const patch = input as Record<string, unknown>;
      for (const key of Object.keys(patch)) {
        if (!DEPLOYMENT_FIELDS.has(key)) throw new ConfigurationError(`字段不属于部署配置：${key}`);
      }
      if (patch.local !== undefined) {
        if (!patch.local || typeof patch.local !== 'object' || Array.isArray(patch.local)) {
          throw new ConfigurationError('local 必须是对象');
        }
        if (Object.keys(patch.local).some((key) => key !== 'retentionDays')) {
          throw new ConfigurationError('部署存储根目录只能通过启动配置修改');
        }
      }
      return database.transaction(() => {
        const before = legacy.getHarness();
        const after = legacy.updateHarness(input);
        const executionChange =
          before.provider !== after.provider ||
          before.providerBaseUrl !== after.providerBaseUrl ||
          JSON.stringify(before.agents) !== JSON.stringify(after.agents) ||
          JSON.stringify(before.mcp) !== JSON.stringify(after.mcp);
        const ossChange = OSS_DESTINATION_FIELDS.some(
          (field) => before.oss[field] !== after.oss[field],
        );
        if (executionChange || ossChange) {
          const running = database
            .prepare("SELECT count(*) AS count FROM test_request_queue WHERE status = 'running'")
            .get() as { count: number };
          if (running.count > 0) {
            throw new ConfigurationError(
              `全局仍有 ${running.count} 个运行中请求，不能修改部署执行配置`,
            );
          }
        }
        if (ossChange) {
          const references = database
            .prepare("SELECT 1 FROM run_store_runs WHERE evidence_json <> '[]' LIMIT 1")
            .get();
          if (references)
            throw new ConfigurationError('已有 Run 引用 OSS 证据，不能原位修改存储目的地');
        }
        return after;
      })();
    },
  };
}
