import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { GitRepository } from '../repository/git-repository.js';
import {
  SCENARIO_DIRECTORY,
  ScenarioPatchError,
  validateScenarioContents,
  validateScenarioPatchText,
} from '../repository/scenario-patch.js';

import { prepareProjectCommitTree } from './image-source.js';

const execFileAsync = promisify(execFile);
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ProjectRunSource {
  directory: string;
  projectId: string;
  runId: string;
  targetCommit: string;
  scenarioPatchSha256: string | null;
  cleanup(): Promise<void>;
}

/** Materialize the exact commit plus the validated scenario patch for one Run. */
export async function prepareProjectRunSource(input: {
  repository: GitRepository;
  projectId: string;
  runId: string;
  targetCommit: string;
  scenarioPatch?: string;
  storageRoot: string;
}): Promise<ProjectRunSource> {
  if (!RUN_ID.test(input.runId)) throw new Error('Run ID 无效');
  const source = await prepareProjectCommitTree({
    repository: input.repository,
    projectId: input.projectId,
    targetCommit: input.targetCommit,
    storageRoot: input.storageRoot,
    sourceKind: 'run-sources',
  });
  try {
    let scenarioPatchSha256: string | null = null;
    if (input.scenarioPatch !== undefined) {
      const metadata = validateScenarioPatchText(input.scenarioPatch);
      if (!input.scenarioPatch.endsWith('\n')) {
        throw new ScenarioPatchError('patch 缺少末尾换行');
      }
      const before = await readScenarioFiles(source.directory);
      const patchPath = join(dirname(source.directory), 'changes.patch');
      await writeFile(patchPath, input.scenarioPatch, { mode: 0o600, flag: 'wx' });
      try {
        await execFileAsync(
          'git',
          ['apply', '--check', '--recount', '--whitespace=nowarn', patchPath],
          { cwd: source.directory, windowsHide: true, maxBuffer: 64 * 1024 },
        );
        await execFileAsync('git', ['apply', '--recount', '--whitespace=nowarn', patchPath], {
          cwd: source.directory,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new ScenarioPatchError('patch 无法应用到固定提交的 Run 源码');
      }
      const after = await readScenarioFiles(source.directory);
      validateScenarioContents(after, before, metadata.changes);
      scenarioPatchSha256 = createHash('sha256').update(input.scenarioPatch).digest('hex');
    }
    return {
      directory: source.directory,
      projectId: input.projectId,
      runId: input.runId,
      targetCommit: source.targetCommit,
      scenarioPatchSha256,
      cleanup: source.cleanup,
    };
  } catch (error) {
    await source.cleanup();
    throw error;
  }
}

async function readScenarioFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const scenarioRoot = resolve(root, SCENARIO_DIRECTORY);
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const remainder = relative(scenarioRoot, path);
      if (remainder === '..' || remainder.startsWith(`..${sep}`)) {
        throw new ScenarioPatchError('场景目录越界');
      }
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ScenarioPatchError('场景目录包含符号链接');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && entry.name.endsWith('.md')) {
        const name = join(SCENARIO_DIRECTORY, remainder).replaceAll('\\', '/');
        files.set(name, await readFile(path, 'utf8'));
      }
    }
  };
  await walk(scenarioRoot);
  return files;
}
