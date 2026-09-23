import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { GitRepository, GitTreeEntry } from '../repository/git-repository.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface ProjectImageSource {
  directory: string;
  dockerfilePath: string;
  targetCommit: string;
  cleanup(): Promise<void>;
}

/** Materialize only a verified commit tree, never the mutable repository checkout. */
export async function prepareProjectImageSource(input: {
  repository: GitRepository;
  projectId: string;
  targetCommit: string;
  dockerfilePath: string;
  storageRoot: string;
}): Promise<ProjectImageSource> {
  if (!PROJECT_ID.test(input.projectId) || !COMMIT_SHA.test(input.targetCommit)) {
    throw new Error('项目或镜像目标提交无效');
  }
  assertRelativeSourcePath(input.dockerfilePath);
  const targetCommit = await input.repository.resolveCommit(input.targetCommit);
  const tree = await input.repository.listTree(targetCommit);
  for (const entry of tree) assertBuildTreeEntry(entry);
  const dockerfile = tree.find((entry) => entry.path === input.dockerfilePath);
  if (!dockerfile || !isRegularTreeEntry(dockerfile)) {
    throw new Error('固定提交中不存在普通 Dockerfile');
  }
  await input.repository.readTextFileAtCommit(targetCommit, input.dockerfilePath);

  const root = resolve(input.storageRoot);
  const projectRoot = resolve(root, 'projects', input.projectId, 'image-sources');
  assertWithin(root, projectRoot);
  await mkdir(projectRoot, { recursive: true });
  const staging = await mkdtemp(join(projectRoot, 'source-'));
  const archive = join(staging, 'source.tar');
  const directory = join(staging, 'context');
  try {
    await mkdir(directory);
    await input.repository.archiveCommit(targetCommit, archive);
    const archiveInfo = await lstat(archive);
    if (!archiveInfo.isFile() || archiveInfo.size > MAX_ARCHIVE_BYTES) {
      throw new Error('镜像构建源码归档超出限制');
    }
    await execFileAsync('tar', ['-xf', archive, '-C', directory], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    await rm(archive);
    for (const entry of tree) {
      const path = resolve(directory, entry.path);
      assertWithin(directory, path);
      const info = await lstat(path).catch(() => {
        throw new Error('镜像构建源码与固定提交不一致');
      });
      if (entry.mode === '120000') {
        if (!info.isSymbolicLink()) throw new Error('镜像构建源码与固定提交不一致');
        const destination = await realpath(path).catch(() => {
          throw new Error('镜像构建源码包含无效符号链接');
        });
        assertWithin(directory, destination);
      } else if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('镜像构建源码与固定提交不一致');
      }
    }
    return {
      directory,
      dockerfilePath: input.dockerfilePath,
      targetCommit,
      cleanup: () => rm(staging, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function assertBuildTreeEntry(entry: GitTreeEntry): void {
  assertRelativeSourcePath(entry.path);
  if (!isRegularTreeEntry(entry) && !(entry.type === 'blob' && entry.mode === '120000')) {
    throw new Error('镜像构建源码包含不支持的 Git 文件类型');
  }
}

function isRegularTreeEntry(entry: GitTreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function assertRelativeSourcePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path === '' ||
    path.includes('\\') ||
    path.includes(':') ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path
      .split('/')
      .some(
        (part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git',
      ) ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error('镜像构建源码路径无效');
  }
}

function assertWithin(root: string, path: string): void {
  const remainder = relative(root, path);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error('镜像构建源码路径越界');
  }
}
