import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '../configuration.js';
import { isManagedFilePath } from './managed-file-path.js';

export type GeneratedDefinition = {
  sourceCommit: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
};

export function normalizeGeneratedDefinition(value: unknown): GeneratedDefinition | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('生成配置无效');
  const source = value as Record<string, unknown>;
  if (
    typeof source.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(source.sourceCommit) ||
    typeof source.summary !== 'string' ||
    source.summary.length > 4096 ||
    !Array.isArray(source.files) ||
    source.files.length === 0 ||
    source.files.length > 16
  )
    throw new ConfigurationError('生成配置缺少固定提交或文件');
  const seen = new Set<string>();
  let size = 0;
  const files = source.files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || Array.isArray(file))
      throw new ConfigurationError('生成文件无效');
    const entry = file as Record<string, unknown>;
    if (
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('.luowang-generated/') ||
      !isManagedFilePath(entry.path) ||
      seen.has(entry.path) ||
      typeof entry.content !== 'string' ||
      entry.content.includes('\0') ||
      (size += Buffer.byteLength(entry.content, 'utf8')) > 512 * 1024
    )
      throw new ConfigurationError('生成文件路径、内容或大小无效');
    seen.add(entry.path);
    return { path: entry.path, content: entry.content };
  });
  return { sourceCommit: source.sourceCommit.toLowerCase(), summary: source.summary, files };
}

export function generatedDefinitionHash(definition: GeneratedDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify([...definition.files].sort((a, b) => a.path.localeCompare(b.path))))
    .digest('hex');
}

/** Write only into a fresh, verified commit export, never the repository checkout. */
export async function materializeGeneratedDefinition(
  directory: string,
  definition: GeneratedDefinition | null,
): Promise<void> {
  if (!definition) return;
  for (const file of definition.files) {
    const target = join(directory, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
  }
}
