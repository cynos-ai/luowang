import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

export interface LegacyBackupInput {
  database: Database.Database;
  databasePath: string;
  repoDir: string;
  reportDir: string;
  backupDir: string;
}

export interface LegacyBackupManifest {
  format: 1;
  createdAt: string;
  databaseSha256: string;
  repository: BackupTreeDigest | null;
  reports: BackupTreeDigest | null;
}

interface BackupTreeDigest {
  entries: number;
  sha256: string;
}

/** Caller must stop the LuoWang service before backing up mutable work directories. */
export async function createLegacyBackup(input: LegacyBackupInput): Promise<LegacyBackupManifest> {
  const databasePath = resolve(input.databasePath);
  const repoDir = resolve(input.repoDir);
  const reportDir = resolve(input.reportDir);
  const backupDir = resolve(input.backupDir);
  if (within(backupDir, repoDir) || within(backupDir, reportDir)) {
    throw new Error('备份目标不能位于仓库或报告目录内');
  }
  if (
    input.database.name === ':memory:' ||
    resolve(input.database.name) !== databasePath ||
    backupDir === databasePath
  ) {
    throw new Error('备份路径或数据库身份无效');
  }
  await assertDirectoryOrMissing(repoDir);
  await assertDirectoryOrMissing(reportDir);
  await mkdir(dirname(backupDir), { recursive: true });
  const actualBackupDir = join(await realpath(dirname(backupDir)), basename(backupDir));
  const actualRepoDir = await actualPathOrNull(repoDir);
  const actualReportDir = await actualPathOrNull(reportDir);
  if (
    (actualRepoDir && within(actualBackupDir, actualRepoDir)) ||
    (actualReportDir && within(actualBackupDir, actualReportDir))
  ) {
    throw new Error('备份目标不能位于仓库或报告目录内');
  }
  await mkdir(backupDir);
  await writeFile(join(backupDir, 'INCOMPLETE'), '备份尚未完成，请勿用于恢复\n', { flag: 'wx' });

  const databaseCopy = join(backupDir, 'luowang.db');
  await input.database.backup(databaseCopy);
  const snapshot = new Database(databaseCopy, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('SQLite 备份完整性检查失败');
  } finally {
    snapshot.close();
  }
  const repository = await copyAndDigest(repoDir, join(backupDir, 'repo'));
  const reports = await copyAndDigest(reportDir, join(backupDir, 'report'));
  const manifest: LegacyBackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    databaseSha256: await fileHash(databaseCopy),
    repository,
    reports,
  };
  await writeFile(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  await verifyContents(backupDir, manifest);
  // Keep the marker until every backup artifact and manifest has been written.
  await unlink(join(backupDir, 'INCOMPLETE'));
  return manifest;
}

export async function verifyLegacyBackup(backupDir: string): Promise<LegacyBackupManifest> {
  const root = resolve(backupDir);
  if (await exists(join(root, 'INCOMPLETE'))) throw new Error('备份未完成');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as unknown;
  } catch {
    throw new Error('备份清单无效');
  }
  if (!isManifest(parsed)) throw new Error('备份清单无效');
  await verifyContents(root, parsed);
  return parsed;
}

async function verifyContents(root: string, manifest: LegacyBackupManifest): Promise<void> {
  const databaseCopy = join(root, 'luowang.db');
  if ((await fileHash(databaseCopy)) !== manifest.databaseSha256) {
    throw new Error('SQLite 备份摘要不匹配');
  }
  const database = new Database(databaseCopy, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite 备份完整性检查失败');
    }
  } finally {
    database.close();
  }
  for (const [name, expected] of [
    ['repo', manifest.repository],
    ['report', manifest.reports],
  ] as const) {
    const directory = join(root, name);
    const actual = (await exists(directory)) ? await digestTree(directory) : null;
    if (actual?.entries !== expected?.entries || actual?.sha256 !== expected?.sha256) {
      throw new Error('工作目录备份摘要不匹配');
    }
  }
}

async function copyAndDigest(
  source: string,
  destination: string,
): Promise<BackupTreeDigest | null> {
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true });
  return digestTree(destination);
}

async function digestTree(root: string): Promise<BackupTreeDigest> {
  if (!(await lstat(root)).isDirectory()) throw new Error('备份工作目录无效');
  const entries: string[] = [];
  await walk(root, '', entries);
  const hash = createHash('sha256');
  for (const entry of entries.sort()) hash.update(entry).update('\n');
  return { entries: entries.length, sha256: hash.digest('hex') };
}

async function walk(root: string, path: string, entries: string[]): Promise<void> {
  const directory = join(root, path);
  for (const name of await readdir(directory)) {
    const relativePath = path ? `${path}/${name}` : name;
    const absolutePath = join(directory, name);
    const info = await lstat(absolutePath);
    if (info.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      await walk(root, relativePath, entries);
    } else if (info.isSymbolicLink()) {
      entries.push(`link:${relativePath}:${await readlink(absolutePath)}`);
    } else if (info.isFile()) {
      entries.push(`file:${relativePath}:${info.size}:${await fileHash(absolutePath)}`);
    } else {
      throw new Error('备份目录包含不支持的文件类型');
    }
  }
}

async function fileHash(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error('备份文件无效');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertDirectoryOrMissing(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('备份源必须是普通目录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function actualPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isManifest(value: unknown): value is LegacyBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.format === 1 &&
    typeof item.createdAt === 'string' &&
    typeof item.databaseSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.databaseSha256) &&
    isTreeDigest(item.repository) &&
    isTreeDigest(item.reports)
  );
}

function isTreeDigest(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(item.entries) &&
    (item.entries as number) >= 0 &&
    typeof item.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.sha256)
  );
}

function within(candidate: string, root: string): boolean {
  const offset = relative(root, candidate);
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`));
}
