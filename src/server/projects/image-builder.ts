import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ProjectImageSource } from './image-source.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface ProjectImageBuild {
  projectId: string;
  targetCommit: string;
  imageId: string;
  tag: string;
}

export interface DockerCommand {
  run(args: string[], options: { cwd: string; timeoutMs: number }): Promise<void>;
}

/** Only this controlled adapter invokes Docker; callers pass a verified fixed-commit source. */
export function createDockerCommand(): DockerCommand {
  return {
    async run(args, options) {
      await execFileAsync('docker', args, {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: process.env.HOME,
          DOCKER_HOST: process.env.DOCKER_HOST,
        },
      });
    },
  };
}

/** Build a reusable project image and return its immutable local content ID. */
export async function buildProjectImage(
  input: { projectId: string; instanceId: string; source: ProjectImageSource },
  docker: DockerCommand = createDockerCommand(),
): Promise<ProjectImageBuild> {
  if (
    !PROJECT_ID.test(input.projectId) ||
    !PROJECT_ID.test(input.instanceId) ||
    !COMMIT_SHA.test(input.source.targetCommit) ||
    !input.source.dockerfilePath
  ) {
    throw new Error('项目镜像构建身份无效');
  }
  const directory = resolve(input.source.directory);
  const dockerfile = resolve(directory, input.source.dockerfilePath);
  assertWithin(directory, dockerfile);
  const imageIdPath = resolve(dirname(directory), 'image-id.txt');
  const tag = `luowang-project-${input.projectId}:${input.source.targetCommit}`;
  try {
    await docker.run(
      [
        'build',
        '--file',
        dockerfile,
        '--iidfile',
        imageIdPath,
        '--tag',
        tag,
        '--label',
        `luowang.project-id=${input.projectId}`,
        '--label',
        `luowang.instance-id=${input.instanceId}`,
        '--label',
        `luowang.target-commit=${input.source.targetCommit}`,
        '--label',
        `luowang.build-definition=${input.source.buildDefinition ?? input.source.dockerfilePath}`,
        directory,
      ],
      { cwd: directory, timeoutMs: 15 * 60 * 1000 },
    );
    const imageId = (await readFile(imageIdPath, 'utf8')).trim();
    if (!IMAGE_ID.test(imageId)) throw new Error('Docker 未返回有效镜像 ID');
    return { projectId: input.projectId, targetCommit: input.source.targetCommit, imageId, tag };
  } finally {
    await rm(imageIdPath, { force: true });
  }
}

function assertWithin(root: string, path: string): void {
  const remainder = relative(root, path);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error('项目 Dockerfile 路径越界');
  }
}
