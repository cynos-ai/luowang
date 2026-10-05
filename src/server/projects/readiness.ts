import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import { GitCommandError } from '../repository/errors.js';

import type { VerifiedGitHubRepositoryIdentity } from '../repository/github.js';
import { describeGitHubRepositoryFailure } from '../repository/github.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfiguration, ProjectConfigurationStore } from './configuration.js';
import type { ProjectRecord, ProjectStore } from './store.js';
import { activateCutoverProject } from './cutover-activation.js';

export type ReadinessStatus = 'ok' | 'not_configured' | 'failed' | 'needs_recheck';
export interface ReadinessCheck {
  id: 'repository' | 'deployment' | 'environment' | 'image' | 'credentials';
  status: ReadinessStatus;
  message: string;
}

export interface ProjectReadiness {
  projectId: string;
  checkedAt: string;
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface ProjectReadinessDependencies {
  verifyRepository(
    project: ProjectRecord,
    token: string,
  ): Promise<VerifiedGitHubRepositoryIdentity>;
  checkDeployment(project: ProjectRecord, config: ProjectConfiguration): Promise<ReadinessCheck>;
  checkEnvironment(project: ProjectRecord, config: ProjectConfiguration): Promise<ReadinessCheck>;
  checkImage(project: ProjectRecord, config: ProjectConfiguration): Promise<ReadinessCheck>;
}

export interface ProjectReadinessService {
  check(projectId: string): Promise<ProjectReadiness>;
  latest(projectId: string): ProjectReadiness | null;
  pause(projectId: string): ProjectRecord;
  resume(projectId: string): Promise<{ project: ProjectRecord; readiness: ProjectReadiness }>;
}

/** External checks are required dependencies: absence never means ready. */
export function createProjectReadinessService(input: {
  database: Database.Database;
  projects: ProjectStore;
  configuration: ProjectConfigurationStore;
  secrets: ScopedSecretStore;
  dependencies: ProjectReadinessDependencies;
  now?: () => string;
}): ProjectReadinessService {
  const now = input.now ?? (() => new Date().toISOString());
  const requireProject = (projectId: string) => {
    const project = input.projects.get(projectId);
    if (!project) throw new Error('项目不存在');
    return project;
  };
  const projectSecrets = (projectId: string) => input.secrets.project(projectId);

  async function check(projectId: string): Promise<ProjectReadiness> {
    const project = requireProject(projectId);
    const config = input.configuration.get(projectId);
    const secrets = projectSecrets(projectId);
    const checks: ReadinessCheck[] = [];
    let token: string | undefined;
    let tokenUnreadable = false;
    try {
      token = secrets.get('gitToken');
    } catch {
      tokenUnreadable = true;
    }
    if (tokenUnreadable) {
      checks.push({ id: 'repository', status: 'failed', message: '项目 GitHub Token 无法读取' });
    } else if (!token) {
      checks.push({
        id: 'repository',
        status: 'not_configured',
        message: '请配置项目 GitHub Token',
      });
    } else {
      try {
        const identity = await input.dependencies.verifyRepository(project, token);
        const matches =
          identity.githubRepositoryId === project.githubRepositoryId &&
          identity.owner.toLowerCase() === project.repositoryOwner.toLowerCase() &&
          identity.name.toLowerCase() === project.repositoryName.toLowerCase();
        checks.push({
          id: 'repository',
          status: matches ? 'ok' : 'failed',
          message: matches ? '仓库身份已核验' : 'GitHub 仓库身份与项目绑定不一致',
        });
      } catch (error) {
        checks.push({
          id: 'repository',
          status: 'failed',
          message: describeGitHubRepositoryFailure(error),
        });
      }
    }
    const username = secrets.has('testUsername');
    const password = secrets.has('testPassword');
    const cleanup = secrets.has('testDataCleanupToken');
    const credentialsReady =
      username === password && Boolean(config.testDataCleanupUrl) === cleanup;
    checks.push({
      id: 'credentials',
      status: credentialsReady ? 'ok' : 'not_configured',
      message: credentialsReady ? '测试与清理凭据配置一致' : '测试账号或清理地址与凭据未成对配置',
    });
    checks.push(
      await safeExternalCheck('deployment', () =>
        input.dependencies.checkDeployment(project, config),
      ),
    );
    checks.push(
      config.runtimeMode === 'external' && config.baseUrl
        ? await safeExternalCheck('environment', () =>
            input.dependencies.checkEnvironment(project, config),
          )
        : config.runtimeMode === 'external'
          ? { id: 'environment', status: 'not_configured', message: '请配置非生产测试环境 URL' }
          : config.runtimeMode === 'repository-only'
            ? { id: 'environment', status: 'ok', message: '仅仓库测试不需要应用地址' }
            : managedRuntimeReady(config)
              ? { id: 'environment', status: 'ok', message: '应用将在 Run 中启动并生成临时地址' }
              : { id: 'environment', status: 'not_configured', message: '请完成项目启动配置' },
    );
    checks.push(
      checks.find((item) => item.id === 'repository')?.status === 'ok'
        ? await safeExternalCheck('image', () => input.dependencies.checkImage(project, config))
        : { id: 'image', status: 'needs_recheck', message: '仓库身份核验后再检查项目镜像' },
    );
    const readiness = {
      projectId,
      checkedAt: now(),
      ready: checks.every((item) => item.status === 'ok'),
      checks,
    };
    persistProjectReadiness(input.database, readiness);
    return readiness;
  }

  return {
    check,
    latest(projectId) {
      requireProject(projectId);
      return readProjectReadiness(input.database, projectId);
    },
    pause(projectId) {
      return input.database.transaction(() => {
        requireProject(projectId);
        input.database
          .prepare("UPDATE projects SET status = 'paused', updated_at = ? WHERE project_id = ?")
          .run(now(), projectId);
        return requireProject(projectId);
      })();
    },
    async resume(projectId) {
      const before = readinessInputFingerprint(input.database, projectId);
      const readiness = await check(projectId);
      if (!readiness.ready) return { project: requireProject(projectId), readiness };
      return input.database.transaction(() => {
        if (readinessInputFingerprint(input.database, projectId) !== before) {
          const changed = {
            ...readiness,
            ready: false,
            checks: readiness.checks.map((item) => ({
              ...item,
              status: 'needs_recheck' as const,
              message: '检查期间配置或凭据已变化，请重检',
            })),
          };
          persistProjectReadiness(input.database, changed);
          return { project: requireProject(projectId), readiness: changed };
        }
        input.database
          .prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE project_id = ?")
          .run(now(), projectId);
        activateCutoverProject(input.database, projectId, now());
        return { project: requireProject(projectId), readiness };
      })();
    },
  };
}

function managedRuntimeReady(config: ProjectConfiguration): boolean {
  return config.startType === 'single-container'
    ? config.runtime.startCommand.length > 0 && config.runtime.servicePort !== null
    : config.runtime.composeServices.length > 0 &&
        Boolean(config.runtime.applicationService) &&
        Boolean(config.runtime.commandService) &&
        config.runtime.servicePort !== null;
}

async function safeExternalCheck(
  id: ReadinessCheck['id'],
  run: () => Promise<ReadinessCheck>,
): Promise<ReadinessCheck> {
  try {
    const check = await run();
    if (
      check.id !== id ||
      !['ok', 'not_configured', 'failed', 'needs_recheck'].includes(check.status)
    ) {
      return { id, status: 'failed', message: '依赖检查结果无效' };
    }
    return check;
  } catch (error) {
    if (error instanceof GitCommandError && error.timedOut) {
      return { id, status: 'failed', message: 'Git 远程检查超时，请检查仓库网络后重新检查' };
    }
    return { id, status: 'failed', message: '依赖检查失败，请稍后重试' };
  }
}

const READINESS_CHECK_IDS: ReadinessCheck['id'][] = [
  'repository',
  'credentials',
  'deployment',
  'environment',
  'image',
];

export function invalidateProjectReadiness(
  database: Database.Database,
  projectId: string,
  checkIds: readonly ReadinessCheck['id'][] = READINESS_CHECK_IDS,
): void {
  if (checkIds.length === 0) return;
  const unique = [...new Set(checkIds)];
  database
    .prepare(
      `DELETE FROM project_connectivity_check_results
       WHERE project_id = ? AND check_id IN (${unique.map(() => '?').join(', ')})`,
    )
    .run(projectId, ...unique);
}

export function invalidateAllProjectReadiness(
  database: Database.Database,
  checkIds: readonly ReadinessCheck['id'][] = READINESS_CHECK_IDS,
): void {
  if (checkIds.length === 0) return;
  const unique = [...new Set(checkIds)];
  database
    .prepare(
      `DELETE FROM project_connectivity_check_results
       WHERE check_id IN (${unique.map(() => '?').join(', ')})`,
    )
    .run(...unique);
}

function persistProjectReadiness(database: Database.Database, readiness: ProjectReadiness): void {
  database.transaction(() => {
    invalidateProjectReadiness(database, readiness.projectId);
    const insert = database.prepare(
      `INSERT INTO project_connectivity_check_results
         (project_id, check_id, status, message, checked_at, latency_ms)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const check of readiness.checks) {
      insert.run(readiness.projectId, check.id, check.status, check.message, readiness.checkedAt);
    }
  })();
}

function readProjectReadiness(
  database: Database.Database,
  projectId: string,
): ProjectReadiness | null {
  const rows = database
    .prepare(
      `SELECT check_id, status, message, checked_at
       FROM project_connectivity_check_results
       WHERE project_id = ? ORDER BY check_id`,
    )
    .all(projectId) as Array<{
    check_id: string;
    status: string;
    message: string;
    checked_at: string;
  }>;
  if (rows.length === 0) return null;
  const checks: ReadinessCheck[] = [];
  for (const row of rows) {
    if (
      !READINESS_CHECK_IDS.includes(row.check_id as ReadinessCheck['id']) ||
      !['ok', 'not_configured', 'failed', 'needs_recheck'].includes(row.status)
    )
      continue;
    checks.push({
      id: row.check_id as ReadinessCheck['id'],
      status: row.status as ReadinessStatus,
      message: row.message,
    });
  }
  if (checks.length === 0) return null;
  return {
    projectId,
    checkedAt: rows
      .map((row) => row.checked_at)
      .sort()
      .at(-1)!,
    ready:
      checks.length === READINESS_CHECK_IDS.length &&
      checks.every((check) => check.status === 'ok'),
    checks,
  };
}

function readinessInputFingerprint(database: Database.Database, projectId: string): string {
  const project = database
    .prepare(
      'SELECT github_repository_id, repository_owner, repository_name, config_revision, status FROM projects WHERE project_id = ?',
    )
    .get(projectId);
  if (!project) throw new Error('项目不存在');
  const config = database
    .prepare('SELECT value FROM project_config WHERE project_id = ?')
    .get(projectId);
  const deployment = database.prepare("SELECT value FROM app_config WHERE key = 'harness'").get();
  const secretRows = database
    .prepare(
      `SELECT key, nonce, ciphertext, auth_tag FROM secret_entries
       WHERE key LIKE 'deployment:%' OR key LIKE ? ORDER BY key`,
    )
    .all(`project:${projectId}:%`);
  const executionSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_image_cache'")
    .get();
  const images = executionSchema
    ? database
        .prepare(
          `SELECT execution_location_id, execution_location_revision, target_commit,
                  build_definition_hash, platform, status, image_id, failure_code
           FROM execution_image_cache WHERE project_id = ?
           ORDER BY execution_location_id, execution_location_revision, target_commit,
                    build_definition_hash, platform`,
        )
        .all(projectId)
    : database
        .prepare(
          `SELECT target_commit, dockerfile_path, status, image_id, failure_code
           FROM project_execution_images WHERE project_id = ? ORDER BY target_commit, dockerfile_path`,
        )
        .all(projectId);
  const binding = executionSchema
    ? database
        .prepare(`SELECT execution_server_id FROM project_resource_bindings WHERE project_id = ?`)
        .get(projectId)
    : null;
  const server = executionSchema
    ? database
        .prepare(
          `SELECT server_id, revision, capacity, health_status, host_fingerprint
           FROM execution_servers
           WHERE server_id = (SELECT execution_server_id FROM project_resource_bindings WHERE project_id = ?)`,
        )
        .get(projectId)
    : null;
  return createHash('sha256')
    .update(JSON.stringify([project, config, deployment, secretRows, binding, server, images]))
    .digest('hex');
}
