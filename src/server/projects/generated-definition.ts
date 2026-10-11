import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigurationError } from '../configuration.js';
import { isManagedFilePath } from './managed-file-path.js';
import type { PreparationPlan } from '../../shared/project-preparation.js';

export type GeneratedDefinition = {
  sourceCommit: string;
  summary: string;
  files: Array<{ path: string; content: string }>;
  preparation: PreparationPlan;
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
  const preparation = normalizePreparation(source.preparation);
  return {
    sourceCommit: source.sourceCommit.toLowerCase(),
    summary: source.summary,
    files,
    preparation,
  };
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

function normalizePreparation(value: unknown): PreparationPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('测试准备方案无效');
  const source = value as Record<string, unknown>;
  const text = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 2000)
      throw new ConfigurationError('测试准备说明必须为 1–2000 字');
    return v.trim();
  };
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 16) throw new ConfigurationError('测试准备事项无效');
    return v.map(text);
  };
  const account = source.account as Record<string, unknown> | null;
  if (!account || !['none', 'provided', 'generated'].includes(String(account.mode)))
    throw new ConfigurationError('测试账号策略无效');
  return {
    scope: text(source.scope),
    data: text(source.data),
    account: {
      mode: account.mode as PreparationPlan['account']['mode'],
      description: text(account.description),
    },
    externalServices: text(source.externalServices),
    decisions: list(source.decisions),
    evidence: list(source.evidence),
  };
}
