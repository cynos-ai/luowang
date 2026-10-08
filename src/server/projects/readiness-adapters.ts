import type Database from 'better-sqlite3';
import type { ConnectivityResult } from '../../shared/types.js';

import type { ConfigurationStore } from '../configuration.js';
import { GitHubClient } from '../repository/github.js';
import { createProjectRepositoryService } from '../repository/service.js';
import { createProviderAdapter } from '../runs/provider.js';
import { createPlaywrightMcpAdapter } from '../browser/playwright-mcp.js';
import { createOssAdapter } from '../storage/oss.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfigurationStore } from './configuration.js';
import type { ProjectConfiguration } from './configuration.js';
import { BUILTIN_IMAGE_DEFINITION } from './image-source.js';
import { inspectProjectImage } from './image-preparation.js';
import { createLocationImageStateStore } from './execution-image-cache.js';
import { createProjectRuntimeSecretStore } from './runtime-access.js';
import type { ProjectReadinessDependencies, ReadinessCheck } from './readiness.js';
import type { ProjectRecord } from './store.js';
import { checkEnvironmentAccess } from '../runs/capabilities.js';
import { resolveProjectExecutionLocation } from './execution-location.js';
import { createLocalExecutionAdapter } from './execution-adapter.js';
import { createProjectExecutionAdapter } from './execution-target.js';
import { createDockerRuntimeFromAdapter } from './execution-container.js';

/** Live, side-effect-free readiness checks. Image construction is a separate explicit operation. */
export function createLiveProjectReadinessAdapters(input: {
  database: Database.Database;
  deployment: ConfigurationStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  repoRoot: string;
  fetch?: typeof fetch;
  inspectImage?: typeof inspectProjectImage;
  executionAdapter?: typeof createProjectExecutionAdapter;
  github?: (
    project: ProjectRecord,
    token: string,
  ) => Pick<GitHubClient, 'verifyIdentity' | 'readRepository'>;
  checkProvider?: (projectId: string) => Promise<boolean>;
  checkBrowser?: () => Promise<boolean>;
  checkOss?: (projectId: string) => Promise<boolean>;
  checkExecution?: (input: { locationId: string; compose: boolean }) => Promise<boolean>;
  branchHead?: (projectId: string, branch: string) => Promise<string | null>;
}): ProjectReadinessDependencies {
  const github =
    input.github ??
    ((project: ProjectRecord, token: string) =>
      new GitHubClient({
        repositoryUrl: input.configuration.repositoryUrl(project.projectId),
        tokenProvider: () => token,
      }));
  const request = input.fetch ?? fetch;
  const inspect = input.inspectImage ?? inspectProjectImage;
  const branchHead =
    input.branchHead ??
    (async (projectId: string, branch: string) => {
      const service = createProjectRepositoryService(
        input.database,
        projectId,
        input.configuration,
        input.secrets,
        input.repoRoot,
      );
      return (await service.getRepository()).remoteBranchHead(branch);
    });
  return {
    verifyRepository: (project, token) => github(project, token).verifyIdentity(),
    async checkDeployment(project, config) {
      const id = project.projectId;
      const location = resolveProjectExecutionLocation(input.database, id);
      if (location.kind === 'ssh' && location.healthStatus !== 'ready')
        return failed('deployment', '执行服务器尚未完成 SSH、Docker 与 Compose 检查');
      const executionReady = input.checkExecution
        ? await input.checkExecution({
            locationId: location.id,
            compose: config.runtimeMode === 'managed' && config.startType === 'compose',
          })
        : location.kind === 'ssh'
          ? true
          : await checkLocalExecution(
              location.id,
              config.runtimeMode === 'managed' && config.startType === 'compose',
            );
      if (!executionReady)
        return failed(
          'deployment',
          config.startType === 'compose'
            ? '本机 Docker Engine 或 Compose v2 不可用'
            : '本机 Docker Engine 不可用',
        );
      const runtimeSecrets = createProjectRuntimeSecretStore(id, input.secrets);
      if (input.checkProvider) {
        if (!(await input.checkProvider(id)))
          return failed('deployment', '模型 Provider 或角色模型检查失败');
      } else {
        const provider = await createProviderAdapter(
          input.deployment,
          runtimeSecrets,
        ).checkConnectivity();
        if (provider.status !== 'ok') {
          return {
            id: 'deployment',
            status: provider.status === 'not_configured' ? 'not_configured' : 'failed',
            message: providerReadinessFailure(provider),
          };
        }
      }
      const browser =
        config.runtimeMode === 'repository-only'
          ? true
          : input.checkBrowser
            ? await input.checkBrowser()
            : await (async () => {
                const adapter = createPlaywrightMcpAdapter(input.deployment);
                return adapter.isEnabled() && (await adapter.checkConnectivity()).status === 'ok';
              })();
      if (!browser) return failed('deployment', '浏览器执行能力检查失败');
      const oss = input.checkOss
        ? await input.checkOss(id)
        : await (async () => {
            const adapter = createOssAdapter(input.deployment, runtimeSecrets);
            return adapter.isConfigured() && (await adapter.checkConnectivity()).status === 'ok';
          })();
      return oss
        ? ok('deployment', '模型、浏览器和 OSS 已检查')
        : failed('deployment', 'OSS 检查失败');
    },
    async checkEnvironment(_project, config) {
      const result = await checkEnvironmentAccess(config.baseUrl, request);
      if (result.status === 'reachable') return ok('environment', '测试环境可访问');
      return failed(
        'environment',
        result.reason === 'invalid_url'
          ? '测试环境 URL 无效'
          : result.reason === 'server_error'
            ? '测试环境返回服务错误'
            : '测试环境不可达或检查超时',
      );
    },
    async checkImage(project, config) {
      const token = input.secrets.project(project.projectId).get('gitToken');
      if (!token)
        return { id: 'image', status: 'not_configured', message: '请先配置项目 GitHub Token' };
      const commit = await resolveProjectImageCommit(
        project.projectId,
        config,
        github(project, token),
        branchHead,
      );
      if (!commit) return failed('image', '无法确定项目固定提交');
      const key = {
        projectId: project.projectId,
        targetCommit: commit,
        dockerfilePath: config.executionDockerfile || BUILTIN_IMAGE_DEFINITION,
      };
      const location = resolveProjectExecutionLocation(input.database, project.projectId);
      const platform =
        location.kind === 'local'
          ? `${process.platform}/${process.arch}`
          : readExecutionServerPlatform(input.database, location.serverId!);
      const images = createLocationImageStateStore(input.database, {
        executionLocationId: location.id,
        executionLocationRevision: location.revision,
        platform,
      });
      const state = images.get(key);
      if (state?.status !== 'ready' || !state.imageId) {
        return { id: 'image', status: 'not_configured', message: '当前提交的项目镜像尚未准备' };
      }
      const adapter = input.inspectImage
        ? null
        : await (input.executionAdapter ?? createProjectExecutionAdapter)({
            database: input.database,
            secrets: input.secrets,
            locationId: location.id,
            revision: location.revision,
          });
      let valid: boolean;
      try {
        valid = await inspect(
          { ...key, imageId: state.imageId },
          adapter ? createDockerRuntimeFromAdapter(adapter) : undefined,
        );
      } finally {
        await adapter?.close();
      }
      return valid
        ? ok('image', `项目镜像已核验：${commit.slice(0, 12)}`)
        : failed('image', '项目镜像已丢失或标签不匹配，请重建');
    },
  };
}

async function checkLocalExecution(locationId: string, compose: boolean): Promise<boolean> {
  const adapter = createLocalExecutionAdapter(locationId);
  try {
    const docker = await adapter.execute('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeoutMs: 15_000,
    });
    if (docker.code !== 0) return false;
    if (!compose) return true;
    const plugin = await adapter.execute('docker', ['compose', 'version', '--short'], {
      timeoutMs: 15_000,
    });
    return plugin.code === 0;
  } finally {
    await adapter.close();
  }
}

function readExecutionServerPlatform(database: Database.Database, serverId: string): string {
  const row = database
    .prepare('SELECT capabilities_json FROM execution_servers WHERE server_id = ?')
    .get(serverId) as { capabilities_json: string | null } | undefined;
  try {
    const parsed = JSON.parse(row?.capabilities_json ?? '{}') as { platform?: unknown };
    return typeof parsed.platform === 'string' && parsed.platform
      ? parsed.platform
      : 'linux/unknown';
  } catch {
    return 'linux/unknown';
  }
}

export function providerReadinessFailure(
  result: Pick<ConnectivityResult, 'status' | 'code'>,
): string {
  if (result.code === 'AUTH_NOT_CONFIGURED') return '请配置部署级模型 Provider API Key';
  if (result.code === 'AUTHENTICATION_FAILED')
    return '模型 Provider 认证失败，请检查部署级 API Key';
  if (result.code === 'MODEL_NOT_FOUND' || result.code === 'PROVIDER_NOT_FOUND')
    return '模型 Provider 或角色模型不存在，请检查部署级配置';
  if (result.code === 'VISION_UNSUPPORTED') return 'Reviewer 模型不支持图像输入';
  if (result.code === 'THINKING_UNSUPPORTED') return '角色模型不支持当前推理等级';
  if (result.status === 'timeout') return '模型 Provider 检查超时，请检查网络或网关';
  return '模型 Provider 请求失败，请检查部署级连通性';
}

/** Before the first scenario branch exists, build from the verified repository's default branch. */
export async function resolveProjectImageCommit(
  projectId: string,
  config: ProjectConfiguration,
  github: Pick<GitHubClient, 'readRepository'>,
  branchHead: (projectId: string, branch: string) => Promise<string | null>,
): Promise<string | null> {
  const repository = await github.readRepository();
  const commit =
    (await branchHead(projectId, config.scenarioBranch)) ??
    (await branchHead(projectId, repository.defaultBranch));
  return commit && /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}

function ok(id: ReadinessCheck['id'], message: string): ReadinessCheck {
  return { id, status: 'ok', message };
}

function failed(id: ReadinessCheck['id'], message: string): ReadinessCheck {
  return { id, status: 'failed', message };
}
