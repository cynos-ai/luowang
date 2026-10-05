import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ProjectImageStateStore, ProjectImageKey } from './image-state.js';

export type ExecutionImageKey = {
  executionLocationId: string;
  executionLocationRevision: number;
  projectId: string;
  targetCommit: string;
  buildDefinitionHash: string;
  platform: string;
};
export function createExecutionImageCache(
  database: Database.Database,
  now = () => new Date().toISOString(),
) {
  const get = (key: ExecutionImageKey) =>
    database
      .prepare(
        `SELECT status,image_id AS imageId,failure_code AS failureCode,updated_at AS updatedAt FROM execution_image_cache
    WHERE execution_location_id=? AND execution_location_revision=? AND project_id=? AND target_commit=? AND build_definition_hash=? AND platform=?`,
      )
      .get(
        key.executionLocationId,
        key.executionLocationRevision,
        key.projectId,
        key.targetCommit,
        key.buildDefinitionHash,
        key.platform,
      ) as
      | {
          status: 'preparing' | 'ready' | 'failed';
          imageId: string | null;
          failureCode: string | null;
          updatedAt: string;
        }
      | undefined;
  return {
    get,
    begin(key: ExecutionImageKey) {
      database
        .prepare(
          `INSERT INTO execution_image_cache(execution_location_id,execution_location_revision,project_id,target_commit,build_definition_hash,platform,image_id,status,failure_code,updated_at)
    VALUES(?,?,?,?,?,?,NULL,'preparing',NULL,?) ON CONFLICT(execution_location_id,execution_location_revision,project_id,target_commit,build_definition_hash,platform)
    DO UPDATE SET image_id=NULL,status='preparing',failure_code=NULL,updated_at=excluded.updated_at`,
        )
        .run(
          key.executionLocationId,
          key.executionLocationRevision,
          key.projectId,
          key.targetCommit,
          key.buildDefinitionHash,
          key.platform,
          now(),
        );
      return get(key)!;
    },
    ready(key: ExecutionImageKey, imageId: string) {
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('镜像 ID 无效');
      const result = database
        .prepare(
          `UPDATE execution_image_cache SET image_id=?,status='ready',failure_code=NULL,updated_at=? WHERE execution_location_id=? AND execution_location_revision=? AND project_id=? AND target_commit=? AND build_definition_hash=? AND platform=? AND status='preparing'`,
        )
        .run(
          imageId,
          now(),
          key.executionLocationId,
          key.executionLocationRevision,
          key.projectId,
          key.targetCommit,
          key.buildDefinitionHash,
          key.platform,
        );
      if (result.changes !== 1) throw new Error('镜像缓存状态已变化');
      return get(key)!;
    },
    fail(key: ExecutionImageKey, code: string) {
      database
        .prepare(
          `UPDATE execution_image_cache SET image_id=NULL,status='failed',failure_code=?,updated_at=? WHERE execution_location_id=? AND execution_location_revision=? AND project_id=? AND target_commit=? AND build_definition_hash=? AND platform=? AND status='preparing'`,
        )
        .run(
          code,
          now(),
          key.executionLocationId,
          key.executionLocationRevision,
          key.projectId,
          key.targetCommit,
          key.buildDefinitionHash,
          key.platform,
        );
      return get(key)!;
    },
  };
}

export function createLocationImageStateStore(
  database: Database.Database,
  input: { executionLocationId: string; executionLocationRevision: number; platform: string },
): ProjectImageStateStore {
  const cache = createExecutionImageCache(database);
  const mapped = (key: ProjectImageKey): ExecutionImageKey => ({
    ...input,
    projectId: key.projectId,
    targetCommit: key.targetCommit,
    buildDefinitionHash: createHash('sha256').update(key.dockerfilePath).digest('hex'),
  });
  const state = (key: ProjectImageKey) => {
    const row = cache.get(mapped(key));
    return row
      ? {
          ...key,
          status: row.status,
          imageId: row.imageId,
          failureCode: row.failureCode,
          updatedAt: row.updatedAt,
        }
      : null;
  };
  return {
    get: state,
    begin(key) {
      cache.begin(mapped(key));
      return state(key)!;
    },
    ready(key, imageId) {
      cache.ready(mapped(key), imageId);
      return state(key)!;
    },
    fail(key, code) {
      cache.fail(mapped(key), code);
      return state(key)!;
    },
    interruptPreparing() {
      return database
        .prepare(
          "UPDATE execution_image_cache SET status='failed',failure_code='PREPARATION_INTERRUPTED',image_id=NULL,updated_at=? WHERE status='preparing'",
        )
        .run(new Date().toISOString()).changes;
    },
  };
}
