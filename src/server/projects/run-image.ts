import type Database from 'better-sqlite3';

import { normalizeExecutionDockerfile } from './configuration.js';

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface ProjectRunImage {
  runId: string;
  projectId: string;
  targetCommit: string;
  dockerfilePath: string;
  imageId: string;
  recordedAt: string;
}

export function createProjectRunImageStore(
  database: Database.Database,
  projectId: string,
  now: () => string = () => new Date().toISOString(),
): {
  get(runId: string): ProjectRunImage | null;
  record(input: Omit<ProjectRunImage, 'projectId' | 'recordedAt'>): ProjectRunImage;
} {
  if (!database.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
    throw new Error('项目不存在');
  }
  const get = (runId: string): ProjectRunImage | null => {
    const row = database
      .prepare('SELECT * FROM project_run_images WHERE run_id = ? AND project_id = ?')
      .get(runId, projectId) as ImageRow | undefined;
    return row ? fromRow(row) : null;
  };
  return {
    get,
    record(input) {
      if (
        !RUN_ID.test(input.runId) ||
        !COMMIT.test(input.targetCommit) ||
        !IMAGE_ID.test(input.imageId)
      ) {
        throw new Error('Run 镜像记录无效');
      }
      const dockerfilePath = normalizeExecutionDockerfile(input.dockerfilePath);
      return database.transaction(() => {
        const ready = database
          .prepare(
            `SELECT image_id FROM project_execution_images
             WHERE project_id = ? AND target_commit = ? AND dockerfile_path = ? AND status = 'ready'`,
          )
          .get(projectId, input.targetCommit, dockerfilePath) as { image_id: string } | undefined;
        if (ready?.image_id !== input.imageId) throw new Error('Run 镜像与已准备项目镜像不一致');
        const owner = database
          .prepare('SELECT project_id FROM project_run_images WHERE run_id = ?')
          .get(input.runId) as { project_id: string } | undefined;
        if (owner && owner.project_id !== projectId) throw new Error('Run 镜像归属其他项目');
        database
          .prepare(
            `INSERT INTO project_run_images
               (run_id, project_id, target_commit, dockerfile_path, image_id, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO NOTHING`,
          )
          .run(input.runId, projectId, input.targetCommit, dockerfilePath, input.imageId, now());
        const recorded = get(input.runId)!;
        if (
          recorded.targetCommit !== input.targetCommit ||
          recorded.dockerfilePath !== dockerfilePath ||
          recorded.imageId !== input.imageId
        ) {
          throw new Error('Run 镜像记录不能改写');
        }
        return recorded;
      })();
    },
  };
}

interface ImageRow {
  run_id: string;
  project_id: string;
  target_commit: string;
  dockerfile_path: string;
  image_id: string;
  recorded_at: string;
}

function fromRow(row: ImageRow): ProjectRunImage {
  return {
    runId: row.run_id,
    projectId: row.project_id,
    targetCommit: row.target_commit,
    dockerfilePath: row.dockerfile_path,
    imageId: row.image_id,
    recordedAt: row.recorded_at,
  };
}
