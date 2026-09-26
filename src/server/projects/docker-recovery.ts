import type Database from 'better-sqlite3';

import { createDockerRuntime, type DockerRuntime } from './execution-container.js';
import { readInstanceId } from './instance-id.js';

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface DockerRecoveryResult {
  removedContainers: number;
  removedImages: number;
  retainedImages: number;
}

/** Called before queue recovery can claim a new Run. Only this database instance's resources qualify. */
export async function recoverProjectDockerResources(
  database: Database.Database,
  docker: DockerRuntime = createDockerRuntime(),
): Promise<DockerRecoveryResult> {
  const instanceId = readInstanceId(database);
  const projects = new Set(
    (database.prepare('SELECT project_id FROM projects').all() as { project_id: string }[]).map(
      (row) => row.project_id,
    ),
  );
  const containers = await command(docker, [
    'ps',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=luowang.instance-id=${instanceId}`,
  ]);
  let removedContainers = 0;
  for (const containerId of new Set(containers.trim().split(/\s+/).filter(Boolean))) {
    if (!CONTAINER_ID.test(containerId)) throw new Error('Docker 返回无效容器 ID');
    const details = JSON.parse(
      await command(docker, ['inspect', '--format', '{{json .}}', containerId]),
    ) as {
      Name?: string;
      Config?: { Labels?: Record<string, string> };
    };
    const labels = details.Config?.Labels;
    const runId = labels?.['luowang.run-id'];
    if (
      labels?.['luowang.instance-id'] !== instanceId ||
      !projects.has(labels?.['luowang.project-id'] ?? '') ||
      !runId ||
      !RUN_ID.test(runId) ||
      details.Name !== `/luowang-run-${runId.toLowerCase()}`
    ) {
      throw new Error('Docker 容器归属核验失败，停止恢复以避免误删');
    }
    await command(docker, ['rm', '--force', containerId]);
    removedContainers += 1;
  }

  // The state table and every pinned Run record are conservative references. Docker itself
  // refuses removal of an image still used by any container or another tag (no --force).
  const referenced = new Set(
    (
      database
        .prepare(
          'SELECT image_id FROM project_execution_images WHERE image_id IS NOT NULL UNION SELECT image_id FROM project_run_images',
        )
        .all() as { image_id: string }[]
    ).map((row) => row.image_id),
  );
  const images = await command(docker, [
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=luowang.instance-id=${instanceId}`,
  ]);
  let removedImages = 0;
  let retainedImages = 0;
  for (const imageId of new Set(images.trim().split(/\s+/).filter(Boolean))) {
    if (!IMAGE_ID.test(imageId)) throw new Error('Docker 返回无效镜像 ID');
    const details = JSON.parse(
      await command(docker, ['image', 'inspect', '--format', '{{json .}}', imageId]),
    ) as { Config?: { Labels?: Record<string, string> }; RepoTags?: string[] };
    const labels = details.Config?.Labels;
    if (
      labels?.['luowang.instance-id'] !== instanceId ||
      !projects.has(labels?.['luowang.project-id'] ?? '')
    ) {
      throw new Error('Docker 镜像归属核验失败，停止清理以避免误删');
    }
    if (referenced.has(imageId)) {
      retainedImages += 1;
      continue;
    }
    // Inherited Docker labels are not proof that a derived image belongs to LuoWang.
    // Only an exact tag created by our builder is eligible; dangling images stay untouched.
    const tag = `luowang-project-${labels['luowang.project-id']}:${labels['luowang.target-commit']}`;
    if (!details.RepoTags?.includes(tag)) {
      retainedImages += 1;
      continue;
    }
    const removed = await docker.run(['image', 'rm', imageId], { timeoutMs: 30_000 });
    if (removed.exitCode === 0) removedImages += 1;
    else retainedImages += 1;
  }
  return { removedContainers, removedImages, retainedImages };
}

async function command(docker: DockerRuntime, args: string[]): Promise<string> {
  const result = await docker.run(args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} 恢复操作失败`);
  return result.stdout.trim();
}
