import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { ConfigurationError } from '../configuration.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import { isManagedFilePath } from './managed-file-path.js';
import { invalidateProjectReadiness } from './readiness.js';

export type GithubCredential = {
  id: string;
  name: string;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionServer = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private-key';
  credentialConfigured: boolean;
  passphraseConfigured: boolean;
  revision: number;
  capacity: number;
  hostFingerprint: string | null;
  fingerprintConfirmedAt: string | null;
  healthStatus: 'unverified' | 'ready' | 'unavailable' | 'changed';
  capabilities: Record<string, unknown> | null;
  checkedAt: string | null;
  remoteExecutionEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectResourceBindings = {
  githubCredentialId: string | null;
  executionServerId: string | null;
};

export type ProjectManagedFile = {
  id: string;
  path: string;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  serviceName: string | null;
  runtimeInjectionEnabled: boolean;
};

export interface ConnectionResourceService {
  list(): { githubCredentials: GithubCredential[]; executionServers: ExecutionServer[] };
  createGithubCredential(input: { name: unknown; token: unknown }): GithubCredential;
  updateGithubCredential(id: string, input: { name?: unknown; token?: unknown }): GithubCredential;
  deleteGithubCredential(id: string): void;
  githubToken(id: string): string;
  createExecutionServer(input: Record<string, unknown>): ExecutionServer;
  updateExecutionServer(id: string, input: Record<string, unknown>): ExecutionServer;
  deleteExecutionServer(id: string): void;
  confirmExecutionServerFingerprint(id: string, fingerprint: unknown): ExecutionServer;
  recordExecutionServerCheck(
    id: string,
    input: { fingerprint: unknown; capabilities: unknown },
  ): ExecutionServer;
  executionServerConnection(
    id: string,
  ): ExecutionServer & { password?: string; privateKey?: string; privateKeyPassphrase?: string };
  bindings(projectId: string): ProjectResourceBindings;
  bindProject(projectId: string, patch: Partial<ProjectResourceBindings>): ProjectResourceBindings;
  listProjectFiles(projectId: string): ProjectManagedFile[];
  createProjectFile(
    projectId: string,
    input: { path: unknown; content: unknown; serviceName?: unknown },
  ): ProjectManagedFile;
  updateProjectFile(
    projectId: string,
    fileId: string,
    input: { path?: unknown; content?: unknown; serviceName?: unknown },
  ): ProjectManagedFile;
  deleteProjectFile(projectId: string, fileId: string): void;
}

export function createConnectionResourceService(input: {
  database: Database.Database;
  secrets: ScopedSecretStore;
  now?: () => string;
  id?: () => string;
}): ConnectionResourceService {
  const now = input.now ?? (() => new Date().toISOString());
  const id = input.id ?? randomUUID;

  function requireGithubCredential(credentialId: string): GithubCredential {
    const row = input.database
      .prepare('SELECT * FROM github_credentials WHERE credential_id = ?')
      .get(credentialId) as GithubCredentialRow | undefined;
    if (!row) throw new ConfigurationError('GitHub Token 不存在');
    return githubCredential(row, input.secrets);
  }

  function requireExecutionServer(serverId: string): ExecutionServer {
    const row = input.database
      .prepare('SELECT * FROM execution_servers WHERE server_id = ?')
      .get(serverId) as ExecutionServerRow | undefined;
    if (!row) throw new ConfigurationError('执行服务器不存在');
    return executionServer(row, input.secrets);
  }

  function assertResourceMutable(kind: 'github' | 'server', resourceId: string): void {
    const column = kind === 'github' ? 'github_credential_id' : 'execution_server_id';
    const pending = input.database
      .prepare(
        `SELECT count(*) AS count FROM test_request_queue queue
         JOIN project_resource_bindings binding ON binding.project_id = queue.project_id
         WHERE binding.${column} = ?
           AND queue.status IN ('queued', 'running', 'waiting_archive')`,
      )
      .get(resourceId) as { count: number };
    if (pending.count > 0) {
      throw new ConfigurationError(`该连接资源被 ${pending.count} 个待处理请求使用，暂时不能修改`);
    }
    if (
      kind === 'server' &&
      input.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_ledger'",
        )
        .get()
    ) {
      const unresolved = input.database
        .prepare(
          "SELECT count(*) AS count FROM execution_resource_ledger WHERE execution_location_id = ? AND state <> 'released'",
        )
        .get(`server:${resourceId}`) as { count: number };
      if (unresolved.count > 0)
        throw new ConfigurationError(`该服务器仍有 ${unresolved.count} 项执行资源尚未核清`);
    }
  }

  function requireProjectFile(projectId: string, fileId: string): ProjectManagedFile {
    const row = input.database
      .prepare('SELECT * FROM project_managed_files WHERE project_id = ? AND file_id = ?')
      .get(projectId, fileId) as ProjectFileRow | undefined;
    if (!row) throw new ConfigurationError('项目配置文件不存在');
    return projectFile(row, input.secrets);
  }

  function projectBindings(projectId: string): ProjectResourceBindings {
    requireProject(input.database, projectId);
    const row = input.database
      .prepare(
        `SELECT github_credential_id, execution_server_id
         FROM project_resource_bindings WHERE project_id = ?`,
      )
      .get(projectId) as BindingRow | undefined;
    return {
      githubCredentialId: row?.github_credential_id ?? null,
      executionServerId: row?.execution_server_id ?? null,
    };
  }

  return {
    list() {
      const githubCredentials = (
        input.database
          .prepare('SELECT * FROM github_credentials ORDER BY name')
          .all() as GithubCredentialRow[]
      ).map((row) => githubCredential(row, input.secrets));
      const executionServers = (
        input.database
          .prepare('SELECT * FROM execution_servers ORDER BY name')
          .all() as ExecutionServerRow[]
      ).map((row) => executionServer(row, input.secrets));
      return { githubCredentials, executionServers };
    },

    createGithubCredential(value) {
      const credentialId = id();
      const name = resourceName(value.name, 'Token 名称');
      const token = requiredSecret(value.token, 'GitHub Token');
      const timestamp = now();
      try {
        input.database.transaction(() => {
          input.database
            .prepare(
              `INSERT INTO github_credentials
                 (credential_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
            )
            .run(credentialId, name, timestamp, timestamp);
          input.secrets.resource('github-credential', credentialId).set('token', token);
        })();
      } catch (error) {
        throw normalizeUniqueError(error, 'Token 名称已存在');
      }
      return requireGithubCredential(credentialId);
    },

    updateGithubCredential(credentialId, value) {
      requireGithubCredential(credentialId);
      if (value.name === undefined && value.token === undefined) {
        throw new ConfigurationError('没有需要更新的 Token 内容');
      }
      assertResourceMutable('github', credentialId);
      const timestamp = now();
      try {
        input.database.transaction(() => {
          if (value.name !== undefined) {
            input.database
              .prepare(
                'UPDATE github_credentials SET name = ?, updated_at = ? WHERE credential_id = ?',
              )
              .run(resourceName(value.name, 'Token 名称'), timestamp, credentialId);
          }
          if (value.token !== undefined) {
            input.secrets
              .resource('github-credential', credentialId)
              .set('token', requiredSecret(value.token, 'GitHub Token'));
            input.database
              .prepare('UPDATE github_credentials SET updated_at = ? WHERE credential_id = ?')
              .run(timestamp, credentialId);
          }
        })();
      } catch (error) {
        throw normalizeUniqueError(error, 'Token 名称已存在');
      }
      return requireGithubCredential(credentialId);
    },

    deleteGithubCredential(credentialId) {
      requireGithubCredential(credentialId);
      const reference = input.database
        .prepare(
          'SELECT count(*) AS count FROM project_resource_bindings WHERE github_credential_id = ?',
        )
        .get(credentialId) as { count: number };
      if (reference.count > 0) {
        throw new ConfigurationError(`仍有 ${reference.count} 个项目使用该 GitHub Token`);
      }
      input.database.transaction(() => {
        const store = input.secrets.resource('github-credential', credentialId);
        store.delete('token');
        input.database
          .prepare('DELETE FROM github_credentials WHERE credential_id = ?')
          .run(credentialId);
      })();
    },

    githubToken(credentialId) {
      requireGithubCredential(credentialId);
      const token = input.secrets.resource('github-credential', credentialId).get('token');
      if (!token) throw new ConfigurationError('GitHub Token 尚未配置');
      return token;
    },

    createExecutionServer(value) {
      const serverId = id();
      const normalized = normalizeServer(value, null);
      const timestamp = now();
      try {
        input.database.transaction(() => {
          input.database
            .prepare(
              `INSERT INTO execution_servers
                 (server_id, name, host, port, username, auth_type, capacity, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              serverId,
              normalized.name,
              normalized.host,
              normalized.port,
              normalized.username,
              normalized.authType,
              normalized.capacity,
              timestamp,
              timestamp,
            );
          writeServerSecrets(input.secrets, serverId, normalized, true);
        })();
      } catch (error) {
        throw normalizeUniqueError(error, '服务器名称已存在');
      }
      return requireExecutionServer(serverId);
    },

    updateExecutionServer(serverId, value) {
      const current = requireExecutionServer(serverId);
      assertResourceMutable('server', serverId);
      const normalized = normalizeServer(value, current);
      const timestamp = now();
      try {
        input.database.transaction(() => {
          input.database
            .prepare(
              `UPDATE execution_servers SET name = ?, host = ?, port = ?, username = ?,
                 auth_type = ?, capacity = ?, revision = revision + 1, health_status = 'unverified',
                 capabilities_json = NULL, checked_at = NULL, updated_at = ? WHERE server_id = ?`,
            )
            .run(
              normalized.name,
              normalized.host,
              normalized.port,
              normalized.username,
              normalized.authType,
              normalized.capacity,
              timestamp,
              serverId,
            );
          writeServerSecrets(input.secrets, serverId, normalized, false);
          const projects = input.database
            .prepare(
              'SELECT project_id FROM project_resource_bindings WHERE execution_server_id = ?',
            )
            .all(serverId) as Array<{ project_id: string }>;
          for (const project of projects) {
            invalidateProjectReadiness(input.database, project.project_id);
          }
        })();
      } catch (error) {
        throw normalizeUniqueError(error, '服务器名称已存在');
      }
      return requireExecutionServer(serverId);
    },

    confirmExecutionServerFingerprint(serverId, value) {
      requireExecutionServer(serverId);
      assertResourceMutable('server', serverId);
      const fingerprint = sshFingerprint(value);
      input.database
        .prepare(
          `UPDATE execution_servers SET host_fingerprint = ?, fingerprint_confirmed_at = ?,
        health_status = 'unverified', revision = revision + 1, updated_at = ? WHERE server_id = ?`,
        )
        .run(fingerprint, now(), now(), serverId);
      return requireExecutionServer(serverId);
    },

    recordExecutionServerCheck(serverId, value) {
      const current = requireExecutionServer(serverId);
      const fingerprint = sshFingerprint(value.fingerprint);
      const capabilities = executionCapabilities(value.capabilities);
      const status = !current.hostFingerprint
        ? 'unverified'
        : current.hostFingerprint === fingerprint
          ? 'ready'
          : 'changed';
      const timestamp = now();
      input.database
        .prepare(
          `UPDATE execution_servers SET health_status = ?, capabilities_json = ?, checked_at = ?, updated_at = ? WHERE server_id = ?`,
        )
        .run(status, JSON.stringify(capabilities), timestamp, timestamp, serverId);
      return requireExecutionServer(serverId);
    },

    executionServerConnection(serverId) {
      const server = requireExecutionServer(serverId);
      const store = input.secrets.resource('execution-server', serverId);
      return {
        ...server,
        password: store.get('password'),
        privateKey: store.get('privateKey'),
        privateKeyPassphrase: store.get('privateKeyPassphrase'),
      };
    },

    deleteExecutionServer(serverId) {
      requireExecutionServer(serverId);
      const reference = input.database
        .prepare(
          'SELECT count(*) AS count FROM project_resource_bindings WHERE execution_server_id = ?',
        )
        .get(serverId) as { count: number };
      if (reference.count > 0) {
        throw new ConfigurationError(`仍有 ${reference.count} 个项目使用该执行服务器`);
      }
      input.database.transaction(() => {
        const store = input.secrets.resource('execution-server', serverId);
        for (const key of ['password', 'privateKey', 'privateKeyPassphrase'] as const) {
          store.delete(key);
        }
        input.database.prepare('DELETE FROM execution_servers WHERE server_id = ?').run(serverId);
      })();
    },

    bindings(projectId) {
      return projectBindings(projectId);
    },

    bindProject(projectId, patch) {
      requireProject(input.database, projectId);
      const keys = Object.keys(patch);
      if (
        keys.length === 0 ||
        keys.some((key) => !['githubCredentialId', 'executionServerId'].includes(key))
      ) {
        throw new ConfigurationError('项目连接资源字段无效');
      }
      assertProjectIdle(input.database, projectId);
      const current = projectBindings(projectId);
      const next = { ...current, ...patch };
      if (next.githubCredentialId) requireGithubCredential(next.githubCredentialId);
      if (next.executionServerId) requireExecutionServer(next.executionServerId);
      input.database
        .prepare(
          `INSERT INTO project_resource_bindings
             (project_id, github_credential_id, execution_server_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             github_credential_id = excluded.github_credential_id,
             execution_server_id = excluded.execution_server_id,
             updated_at = excluded.updated_at`,
        )
        .run(projectId, next.githubCredentialId, next.executionServerId, now());
      return next;
    },

    listProjectFiles(projectId) {
      requireProject(input.database, projectId);
      return (
        input.database
          .prepare('SELECT * FROM project_managed_files WHERE project_id = ? ORDER BY path')
          .all(projectId) as ProjectFileRow[]
      ).map((row) => projectFile(row, input.secrets));
    },

    createProjectFile(projectId, value) {
      requireProject(input.database, projectId);
      assertProjectIdle(input.database, projectId);
      const fileId = id();
      const path = managedFilePath(value.path);
      const content = managedFileContent(value.content);
      const serviceName = managedFileService(value.serviceName);
      assertManagedFileService(input.database, projectId, serviceName);
      const timestamp = now();
      try {
        input.database.transaction(() => {
          input.database
            .prepare(
              `INSERT INTO project_managed_files
                 (file_id, project_id, path, service_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(fileId, projectId, path, serviceName, timestamp, timestamp);
          input.secrets.resource('project-file', fileId).set('content', content);
        })();
      } catch (error) {
        throw normalizeUniqueError(error, '该项目已存在同路径配置文件');
      }
      return requireProjectFile(projectId, fileId);
    },

    updateProjectFile(projectId, fileId, value) {
      const current = requireProjectFile(projectId, fileId);
      assertProjectIdle(input.database, projectId);
      if (
        value.path === undefined &&
        value.content === undefined &&
        value.serviceName === undefined
      ) {
        throw new ConfigurationError('没有需要更新的配置文件内容');
      }
      const path = value.path === undefined ? current.path : managedFilePath(value.path);
      const serviceName =
        value.serviceName === undefined
          ? current.serviceName
          : managedFileService(value.serviceName);
      assertManagedFileService(input.database, projectId, serviceName);
      const timestamp = now();
      try {
        input.database.transaction(() => {
          input.database
            .prepare(
              'UPDATE project_managed_files SET path = ?, service_name = ?, revision = revision + 1, updated_at = ? WHERE project_id = ? AND file_id = ?',
            )
            .run(path, serviceName, timestamp, projectId, fileId);
          if (value.content !== undefined) {
            input.secrets
              .resource('project-file', fileId)
              .set('content', managedFileContent(value.content));
          }
        })();
      } catch (error) {
        throw normalizeUniqueError(error, '该项目已存在同路径配置文件');
      }
      return requireProjectFile(projectId, fileId);
    },

    deleteProjectFile(projectId, fileId) {
      requireProjectFile(projectId, fileId);
      assertProjectIdle(input.database, projectId);
      input.database.transaction(() => {
        input.secrets.resource('project-file', fileId).delete('content');
        input.database
          .prepare('DELETE FROM project_managed_files WHERE project_id = ? AND file_id = ?')
          .run(projectId, fileId);
      })();
    },
  };
}

type GithubCredentialRow = {
  credential_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};
type ExecutionServerRow = {
  server_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private-key';
  revision: number;
  capacity: number;
  host_fingerprint: string | null;
  fingerprint_confirmed_at: string | null;
  health_status: ExecutionServer['healthStatus'];
  capabilities_json: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
};
type BindingRow = {
  github_credential_id: string | null;
  execution_server_id: string | null;
};
type ProjectFileRow = {
  file_id: string;
  project_id: string;
  path: string;
  revision: number;
  service_name: string | null;
  created_at: string;
  updated_at: string;
};

function githubCredential(row: GithubCredentialRow, secrets: ScopedSecretStore): GithubCredential {
  return {
    id: row.credential_id,
    name: row.name,
    configured: secrets.resource('github-credential', row.credential_id).has('token'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function executionServer(row: ExecutionServerRow, secrets: ScopedSecretStore): ExecutionServer {
  const store = secrets.resource('execution-server', row.server_id);
  return {
    id: row.server_id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    credentialConfigured: store.has(row.auth_type === 'password' ? 'password' : 'privateKey'),
    passphraseConfigured: store.has('privateKeyPassphrase'),
    revision: row.revision,
    capacity: row.capacity,
    hostFingerprint: row.host_fingerprint,
    fingerprintConfirmedAt: row.fingerprint_confirmed_at,
    healthStatus: row.health_status,
    capabilities: row.capabilities_json
      ? (JSON.parse(row.capabilities_json) as Record<string, unknown>)
      : null,
    checkedAt: row.checked_at,
    remoteExecutionEnabled: row.health_status === 'ready' && Boolean(row.host_fingerprint),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectFile(row: ProjectFileRow, secrets: ScopedSecretStore): ProjectManagedFile {
  return {
    id: row.file_id,
    path: row.path,
    configured: secrets.resource('project-file', row.file_id).has('content'),
    revision: row.revision,
    serviceName: row.service_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeInjectionEnabled: true,
  };
}

function normalizeServer(value: Record<string, unknown>, current: ExecutionServer | null) {
  const allowed = new Set([
    'name',
    'host',
    'port',
    'username',
    'authType',
    'password',
    'privateKey',
    'privateKeyPassphrase',
    'capacity',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ConfigurationError('服务器配置包含未知字段');
  }
  const name =
    value.name === undefined && current ? current.name : resourceName(value.name, '服务器名称');
  const host = value.host === undefined && current ? current.host : serverHost(value.host);
  const port = value.port === undefined && current ? current.port : serverPort(value.port);
  const username =
    value.username === undefined && current ? current.username : serverUsername(value.username);
  const authType =
    value.authType === undefined && current ? current.authType : serverAuthType(value.authType);
  return {
    name,
    host,
    port,
    username,
    authType,
    password: optionalSecret(value.password, '服务器密码'),
    privateKey: optionalSecret(value.privateKey, 'SSH 私钥'),
    privateKeyPassphrase: optionalSecret(value.privateKeyPassphrase, '私钥口令'),
    authChanged: Boolean(current && current.authType !== authType),
    capacity: serverCapacity(value.capacity === undefined ? current?.capacity : value.capacity),
  };
}

function serverCapacity(value: unknown): number {
  const capacity = value ?? 1;
  if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > 64)
    throw new ConfigurationError('服务器容量必须是 1–64 的整数');
  return capacity as number;
}

function sshFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{20,100}={0,2}$/.test(value))
    throw new ConfigurationError('SSH 主机指纹无效');
  return value;
}

function executionCapabilities(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('服务器能力检查结果无效');
  const encoded = JSON.stringify(value);
  if (encoded.length > 32_768) throw new ConfigurationError('服务器能力检查结果过大');
  return value as Record<string, unknown>;
}

function managedFileService(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value))
    throw new ConfigurationError('配置文件目标服务无效');
  return value;
}

function assertManagedFileService(
  database: Database.Database,
  projectId: string,
  serviceName: string | null,
): void {
  if (serviceName === null) return;
  const row = database
    .prepare('SELECT value FROM project_config WHERE project_id = ?')
    .get(projectId) as { value: string } | undefined;
  try {
    const config = JSON.parse(row?.value ?? '{}') as {
      startType?: unknown;
      runtime?: { composeServices?: unknown };
    };
    if (
      config.startType !== 'compose' ||
      !Array.isArray(config.runtime?.composeServices) ||
      !config.runtime.composeServices.includes(serviceName)
    ) {
      throw new Error();
    }
  } catch {
    throw new ConfigurationError('配置文件目标服务不在项目启用的 Compose 服务中');
  }
}

function writeServerSecrets(
  secrets: ScopedSecretStore,
  serverId: string,
  value: ReturnType<typeof normalizeServer>,
  creating: boolean,
): void {
  const store = secrets.resource('execution-server', serverId);
  if (value.authType === 'password') {
    if (!value.password && (creating || value.authChanged || !store.has('password'))) {
      throw new ConfigurationError('密码认证需要服务器密码');
    }
    if (value.password) store.set('password', value.password);
    store.delete('privateKey');
    store.delete('privateKeyPassphrase');
  } else {
    if (!value.privateKey && (creating || value.authChanged || !store.has('privateKey'))) {
      throw new ConfigurationError('密钥认证需要 SSH 私钥');
    }
    if (value.privateKey) store.set('privateKey', value.privateKey);
    if (value.privateKeyPassphrase) store.set('privateKeyPassphrase', value.privateKeyPassphrase);
    store.delete('password');
  }
}

function resourceName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ConfigurationError(`${label}无效`);
  const name = value.trim();
  if (!name || name.length > 80 || hasControlCharacter(name)) {
    throw new ConfigurationError(`${label}无效`);
  }
  return name;
}

function requiredSecret(value: unknown, label: string): string {
  const secret = optionalSecret(value, label);
  if (!secret) throw new ConfigurationError(`${label}不能为空`);
  return secret;
}

function optionalSecret(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 64 * 1024) {
    throw new ConfigurationError(`${label}无效`);
  }
  return value;
}

function serverHost(value: unknown): string {
  if (typeof value !== 'string') throw new ConfigurationError('服务器地址无效');
  const host = value.trim();
  if (!host || host.length > 255 || /[\s/@?#]/u.test(host) || hasControlCharacter(host)) {
    throw new ConfigurationError('服务器地址无效');
  }
  return host;
}

function serverPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('SSH 端口必须在 1–65535 之间');
  }
  return port;
}

function serverUsername(value: unknown): string {
  if (typeof value !== 'string') throw new ConfigurationError('服务器用户无效');
  const username = value.trim();
  if (!username || username.length > 128 || /\s/u.test(username) || hasControlCharacter(username)) {
    throw new ConfigurationError('服务器用户无效');
  }
  return username;
}

function serverAuthType(value: unknown): 'password' | 'private-key' {
  if (value !== 'password' && value !== 'private-key') {
    throw new ConfigurationError('服务器认证方式无效');
  }
  return value;
}

function managedFilePath(value: unknown): string {
  if (typeof value !== 'string') throw new ConfigurationError('配置文件路径无效');
  const path = value.trim();
  if (!isManagedFilePath(path)) {
    throw new ConfigurationError('配置文件必须是项目内相对路径');
  }
  return path;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function managedFileContent(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 256 * 1024) {
    throw new ConfigurationError('配置文件内容无效或超过 256 KiB');
  }
  return value;
}

function requireProject(database: Database.Database, projectId: string): void {
  if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
    throw new ConfigurationError('项目不存在');
  }
}

function assertProjectIdle(database: Database.Database, projectId: string): void {
  const pending = database
    .prepare(
      `SELECT count(*) AS count FROM test_request_queue
       WHERE project_id = ? AND status IN ('queued', 'running', 'waiting_archive')`,
    )
    .get(projectId) as { count: number };
  if (pending.count > 0) {
    throw new ConfigurationError(`项目仍有 ${pending.count} 个待处理请求，不能切换连接资源`);
  }
  if (
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_ledger'",
      )
      .get()
  ) {
    const unresolved = database
      .prepare(
        "SELECT count(*) AS count FROM execution_resource_ledger WHERE project_id = ? AND state <> 'released'",
      )
      .get(projectId) as { count: number };
    if (unresolved.count > 0)
      throw new ConfigurationError(
        `项目仍有 ${unresolved.count} 项执行资源尚未核清，不能切换连接资源`,
      );
  }
}

function normalizeUniqueError(error: unknown, message: string): Error {
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    return new ConfigurationError(message);
  }
  return error instanceof Error ? error : new Error(message);
}
