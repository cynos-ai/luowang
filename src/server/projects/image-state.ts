import type Database from 'better-sqlite3';

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface ProjectImageKey {
  projectId: string;
  targetCommit: string;
  dockerfilePath: string;
}

export interface ProjectImageState extends ProjectImageKey {
  status: 'preparing' | 'ready' | 'failed';
  imageId: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface ProjectImageStateStore {
  get(key: ProjectImageKey): ProjectImageState | null;
  begin(key: ProjectImageKey): ProjectImageState;
  ready(key: ProjectImageKey, imageId: string): ProjectImageState;
  fail(key: ProjectImageKey, failureCode: string): ProjectImageState;
  interruptPreparing(): number;
}

export function createProjectImageStateStore(
  database: Database.Database,
  now: () => string = () => new Date().toISOString(),
): ProjectImageStateStore {
  const get = (key: ProjectImageKey): ProjectImageState | null => {
    validateKey(key);
    const row = database
      .prepare(
        `SELECT project_id, target_commit, dockerfile_path, status, image_id, failure_code, updated_at
         FROM project_execution_images
         WHERE project_id = ? AND target_commit = ? AND dockerfile_path = ?`,
      )
      .get(key.projectId, key.targetCommit, key.dockerfilePath) as ImageRow | undefined;
    return row ? fromRow(row) : null;
  };
  return {
    get,
    begin(key) {
      validateKey(key);
      return database.transaction(() => {
        if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(key.projectId)) {
          throw new Error('项目不存在');
        }
        const previous = get(key);
        if (previous?.status === 'preparing') throw new Error('项目镜像正在准备');
        database
          .prepare(
            `INSERT INTO project_execution_images
               (project_id, target_commit, dockerfile_path, status, image_id, failure_code, updated_at)
             VALUES (?, ?, ?, 'preparing', NULL, NULL, ?)
             ON CONFLICT(project_id, target_commit, dockerfile_path)
             DO UPDATE SET status = 'preparing', image_id = NULL, failure_code = NULL,
                           updated_at = excluded.updated_at`,
          )
          .run(key.projectId, key.targetCommit, key.dockerfilePath, now());
        return get(key)!;
      })();
    },
    ready(key, imageId) {
      validateKey(key);
      if (!IMAGE_ID.test(imageId)) throw new Error('项目镜像 ID 无效');
      const changed = database
        .prepare(
          `UPDATE project_execution_images
           SET status = 'ready', image_id = ?, failure_code = NULL, updated_at = ?
           WHERE project_id = ? AND target_commit = ? AND dockerfile_path = ?
             AND status = 'preparing'`,
        )
        .run(imageId, now(), key.projectId, key.targetCommit, key.dockerfilePath);
      if (changed.changes !== 1) throw new Error('项目镜像准备状态已变化');
      return get(key)!;
    },
    fail(key, failureCode) {
      validateKey(key);
      if (!/^[A-Z_]{2,64}$/.test(failureCode)) throw new Error('项目镜像失败代码无效');
      const changed = database
        .prepare(
          `UPDATE project_execution_images
           SET status = 'failed', image_id = NULL, failure_code = ?, updated_at = ?
           WHERE project_id = ? AND target_commit = ? AND dockerfile_path = ?
             AND status = 'preparing'`,
        )
        .run(failureCode, now(), key.projectId, key.targetCommit, key.dockerfilePath);
      if (changed.changes !== 1) throw new Error('项目镜像准备状态已变化');
      return get(key)!;
    },
    interruptPreparing() {
      return database
        .prepare(
          `UPDATE project_execution_images
           SET status = 'failed', image_id = NULL, failure_code = 'PREPARATION_INTERRUPTED',
               updated_at = ?
           WHERE status = 'preparing'`,
        )
        .run(now()).changes;
    },
  };
}

interface ImageRow {
  project_id: string;
  target_commit: string;
  dockerfile_path: string;
  status: ProjectImageState['status'];
  image_id: string | null;
  failure_code: string | null;
  updated_at: string;
}

function fromRow(row: ImageRow): ProjectImageState {
  return {
    projectId: row.project_id,
    targetCommit: row.target_commit,
    dockerfilePath: row.dockerfile_path,
    status: row.status,
    imageId: row.image_id,
    failureCode: row.failure_code,
    updatedAt: row.updated_at,
  };
}

function validateKey(key: ProjectImageKey): void {
  if (
    !PROJECT_ID.test(key.projectId) ||
    !COMMIT_SHA.test(key.targetCommit) ||
    key.dockerfilePath.includes('\\') ||
    key.dockerfilePath.includes(':') ||
    key.dockerfilePath.startsWith('/') ||
    key.dockerfilePath.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('项目镜像状态键无效');
  }
}
