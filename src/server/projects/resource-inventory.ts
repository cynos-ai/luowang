import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { loadConfig } from '../config.js';
import { assertProjectSchema } from './schema-mode.js';
import { createDockerRuntime, type DockerRuntime } from './execution-container.js';
import { readInstanceId } from './instance-id.js';

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ProjectResourceInventory {
  instanceId: string;
  projects: string[];
  containers: Array<{ containerId: string; projectId: string; runId: string }>;
  images: Array<{
    imageId: string;
    projectId: string;
    sizeBytes: number | null;
    disposition: 'referenced' | 'restart-candidate' | 'manual-review';
  }>;
  candidateImageBytes: number;
}

/** Read-only preview. A candidate is not a promise that Docker can reclaim its layers. */
export async function inspectProjectResources(
  database: Database.Database,
  docker: DockerRuntime = createDockerRuntime(),
): Promise<ProjectResourceInventory> {
  const instanceId = readInstanceId(database);
  const projects = (
    database.prepare('SELECT project_id FROM projects ORDER BY project_id').all() as Array<{
      project_id: string;
    }>
  ).map((row) => row.project_id);
  const owned = new Set(projects);
  const referenced = new Set(
    (
      database
        .prepare(
          'SELECT image_id FROM project_execution_images WHERE image_id IS NOT NULL UNION SELECT image_id FROM project_run_images',
        )
        .all() as Array<{ image_id: string }>
    ).map((row) => row.image_id),
  );
  const containers: ProjectResourceInventory['containers'] = [];
  const containerIds = await command(docker, [
    'ps',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=luowang.instance-id=${instanceId}`,
  ]);
  for (const containerId of ids(containerIds)) {
    if (!CONTAINER_ID.test(containerId)) throw new Error('Docker 返回无效容器 ID');
    const details = JSON.parse(
      await command(docker, ['inspect', '--format', '{{json .}}', containerId]),
    ) as { Name?: string; Config?: { Labels?: Record<string, string> } };
    const labels = details.Config?.Labels;
    const projectId = labels?.['luowang.project-id'] ?? '';
    const runId = labels?.['luowang.run-id'] ?? '';
    if (
      labels?.['luowang.instance-id'] !== instanceId ||
      !owned.has(projectId) ||
      !RUN_ID.test(runId) ||
      details.Name !== `/luowang-run-${runId.toLowerCase()}`
    ) {
      throw new Error('Docker 容器归属核验失败，不能生成清理预览');
    }
    containers.push({ containerId, projectId, runId });
  }
  const images: ProjectResourceInventory['images'] = [];
  const imageIds = await command(docker, [
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=luowang.instance-id=${instanceId}`,
  ]);
  for (const imageId of ids(imageIds)) {
    if (!IMAGE_ID.test(imageId)) throw new Error('Docker 返回无效镜像 ID');
    const details = JSON.parse(
      await command(docker, ['image', 'inspect', '--format', '{{json .}}', imageId]),
    ) as {
      Config?: { Labels?: Record<string, string> };
      RepoTags?: string[];
      Size?: number;
    };
    const labels = details.Config?.Labels;
    const projectId = labels?.['luowang.project-id'] ?? '';
    if (labels?.['luowang.instance-id'] !== instanceId || !owned.has(projectId)) {
      throw new Error('Docker 镜像归属核验失败，不能生成清理预览');
    }
    const tag = `luowang-project-${projectId}:${labels['luowang.target-commit']}`;
    const disposition = referenced.has(imageId)
      ? 'referenced'
      : details.RepoTags?.includes(tag)
        ? 'restart-candidate'
        : 'manual-review';
    images.push({
      imageId,
      projectId,
      sizeBytes:
        typeof details.Size === 'number' && Number.isSafeInteger(details.Size) && details.Size >= 0
          ? details.Size
          : null,
      disposition,
    });
  }
  return {
    instanceId,
    projects,
    containers,
    images,
    candidateImageBytes: images.reduce(
      (total, image) =>
        total + (image.disposition === 'restart-candidate' ? (image.sizeBytes ?? 0) : 0),
      0,
    ),
  };
}

function ids(output: string): string[] {
  return [...new Set(output.trim().split(/\s+/).filter(Boolean))];
}

async function command(docker: DockerRuntime, args: string[]): Promise<string> {
  const result = await docker.run(args, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Docker ${args[0]} 资源盘点失败`);
  return result.stdout.trim();
}

export async function runResourceInventoryCli(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectResourceInventory> {
  const path = loadConfig(environment).databasePath;
  if (path === ':memory:' || !existsSync(path)) throw new Error('资源盘点要求已存在的文件数据库');
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertProjectSchema(database);
    return await inspectProjectResources(database);
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runResourceInventoryCli()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : '资源盘点失败');
      process.exitCode = 1;
    });
}
