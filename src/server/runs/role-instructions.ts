import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VERSION } from '../config.js';
import type { AgentSessionKind, RoleInstructionVersion } from './types.js';

const FORMAT_VERSION = '1';
const MAX_INSTRUCTION_BYTES = 256 * 1024;

const RESOURCE_FILES = {
  common: 'common.md',
  'main-planning': 'main-planning.md',
  'runner-execution': 'runner-execution.md',
  'reviewer-audit': 'reviewer-audit.md',
  'main-finalization': 'main-finalization.md',
  'scenario-initialization': 'scenario-initialization.md',
} as const;

type RoleInstructionId = keyof typeof RESOURCE_FILES;

const SESSION_RESOURCE_IDS: Record<AgentSessionKind, readonly RoleInstructionId[]> = {
  'main-planning': ['common', 'main-planning'],
  'runner-execution': ['common', 'runner-execution'],
  'reviewer-audit': ['common', 'reviewer-audit'],
  'main-finalization': ['common', 'main-finalization'],
};

export interface LoadedRoleInstructions {
  content: string;
  versions: RoleInstructionVersion[];
}

export interface RoleInstructionLoader {
  load(kind: AgentSessionKind, initialization: boolean): Promise<LoadedRoleInstructions>;
}

export interface RoleInstructionLoaderOptions {
  resourceDirectory?: string;
  applicationVersion?: string;
}

export class RoleInstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleInstructionError';
  }
}

export function createRoleInstructionLoader(
  options: RoleInstructionLoaderOptions = {},
): RoleInstructionLoader {
  const resourceDirectory = options.resourceDirectory ?? defaultResourceDirectory();
  const applicationVersion = normalizedApplicationVersion(options.applicationVersion);
  return {
    async load(kind, initialization) {
      const ids = [
        ...SESSION_RESOURCE_IDS[kind],
        ...(initialization && (kind === 'main-planning' || kind === 'main-finalization')
          ? (['scenario-initialization'] as const)
          : []),
      ];
      const resources = await Promise.all(
        ids.map((id) => loadResource(resourceDirectory, id, applicationVersion)),
      );
      return {
        content: resources.map((resource) => resource.content).join('\n\n'),
        versions: resources.map(({ id, formatVersion, applicationVersion, sha256 }) => ({
          id,
          formatVersion,
          applicationVersion,
          sha256,
        })),
      };
    },
  };
}

async function loadResource(
  resourceDirectory: string,
  id: RoleInstructionId,
  applicationVersion: string,
): Promise<RoleInstructionVersion & { content: string }> {
  const filename = RESOURCE_FILES[id];
  const path = resolve(resourceDirectory, filename);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_INSTRUCTION_BYTES) {
      throw new Error('invalid resource');
    }
    const content = await readFile(path, 'utf8');
    if (content.trim() === '') throw new Error('empty resource');
    const expectedMarker = `luowang-role-id: ${id}; format-version: ${FORMAT_VERSION}`;
    if (!content.includes(expectedMarker)) throw new Error('invalid marker');
    return {
      id,
      formatVersion: FORMAT_VERSION,
      applicationVersion,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      content: content.trim(),
    };
  } catch {
    throw new RoleInstructionError(`内置角色指令缺失、为空或格式错误：${id}`);
  }
}

function defaultResourceDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(moduleDirectory, '../../..');
  const compiled = basename(resolve(moduleDirectory, '../..')) === 'dist';
  return compiled
    ? resolve(projectRoot, 'dist/resources/agent-roles')
    : resolve(projectRoot, 'resources/agent-roles');
}

function normalizedApplicationVersion(value: string | undefined): string {
  const version = value ?? process.env.LUOWANG_VERSION ?? DEFAULT_VERSION;
  return version.trim() === '' ? DEFAULT_VERSION : version.trim();
}
