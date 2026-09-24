import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { VerifiedGitHubRepositoryIdentity } from '../repository/github.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectConfiguration, ProjectConfigurationStore } from './configuration.js';
import type { ProjectRecord, ProjectStore } from './store.js';

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
  checkDeployment(project: ProjectRecord): Promise<ReadinessCheck>;
  checkEnvironment(project: ProjectRecord, config: ProjectConfiguration): Promise<ReadinessCheck>;
  checkImage(project: ProjectRecord, config: ProjectConfiguration): Promise<ReadinessCheck>;
}

export interface ProjectReadinessService {
  check(projectId: string): Promise<ProjectReadiness>;
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
      } catch {
        checks.push({ id: 'repository', status: 'failed', message: 'GitHub 仓库身份核验失败' });
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
      await safeExternalCheck('deployment', () => input.dependencies.checkDeployment(project)),
    );
    checks.push(
      config.baseUrl
        ? await safeExternalCheck('environment', () =>
            input.dependencies.checkEnvironment(project, config),
          )
        : { id: 'environment', status: 'not_configured', message: '请配置非生产测试环境 URL' },
    );
    checks.push(
      checks.find((item) => item.id === 'repository')?.status === 'ok'
        ? await safeExternalCheck('image', () => input.dependencies.checkImage(project, config))
        : { id: 'image', status: 'needs_recheck', message: '仓库身份核验后再检查项目镜像' },
    );
    return {
      projectId,
      checkedAt: now(),
      ready: checks.every((item) => item.status === 'ok'),
      checks,
    };
  }

  return {
    check,
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
          return {
            project: requireProject(projectId),
            readiness: {
              ...readiness,
              ready: false,
              checks: readiness.checks.map((item) => ({
                ...item,
                status: 'needs_recheck' as const,
                message: '检查期间配置或凭据已变化，请重检',
              })),
            },
          };
        }
        input.database
          .prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE project_id = ?")
          .run(now(), projectId);
        return { project: requireProject(projectId), readiness };
      })();
    },
  };
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
  } catch {
    return { id, status: 'failed', message: '依赖检查失败，请稍后重试' };
  }
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
  const images = database
    .prepare(
      `SELECT target_commit, dockerfile_path, status, image_id, failure_code
       FROM project_execution_images WHERE project_id = ? ORDER BY target_commit, dockerfile_path`,
    )
    .all(projectId);
  return createHash('sha256')
    .update(JSON.stringify([project, config, deployment, secretRows, images]))
    .digest('hex');
}
