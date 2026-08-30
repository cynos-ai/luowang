import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { RUN_ARTIFACT_NAMES, type AgentRole, type RunArtifactName } from './types.js';

const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;

export class RunWorkspaceError extends Error {
  readonly code:
    | 'RUN_ID_INVALID'
    | 'ARTIFACT_NOT_ALLOWED'
    | 'ARTIFACT_INVALID'
    | 'ARTIFACT_MISSING'
    | 'RUN_ALREADY_EXISTS'
    | 'RUN_ALREADY_COMPLETED'
    | 'RUN_NOT_FOUND';

  constructor(code: RunWorkspaceError['code'], message: string) {
    super(message);
    this.name = 'RunWorkspaceError';
    this.code = code;
  }
}

export interface RunArtifactWriter {
  writePlan(content: string): Promise<void>;
  writeExecution(content: string): Promise<void>;
  writeDraftReport(content: string): Promise<void>;
  writeReview(content: string): Promise<void>;
  writeReport(content: string): Promise<void>;
}

export interface RunArtifactReader {
  read(name: RunArtifactName): Promise<string>;
  exists(name: RunArtifactName): Promise<boolean>;
  list(): Promise<Record<string, string>>;
}

export interface RunEvidenceFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export class RunWorkspace implements RunArtifactReader {
  readonly runningDirectory: string;
  readonly completedDirectory: string;

  constructor(
    readonly runId: string,
    private readonly reportRoot: string,
    placement: 'running' | 'completed' = 'running',
  ) {
    assertRunId(runId);
    const root = resolve(reportRoot);
    this.runningDirectory = resolve(root, 'running', runId);
    this.completedDirectory = resolve(root, 'completed', runId);
    this.directory = placement === 'completed' ? this.completedDirectory : this.runningDirectory;
  }

  private readonly directory: string;

  get evidenceDirectory(): string {
    return resolve(this.directory, 'evidence');
  }

  async create(): Promise<void> {
    await mkdir(dirname(this.runningDirectory), { recursive: true });
    await mkdir(dirname(this.completedDirectory), { recursive: true });
    try {
      await lstat(this.runningDirectory);
      throw new RunWorkspaceError('RUN_ALREADY_EXISTS', `Run 目录已存在：${this.runId}`);
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await lstat(this.completedDirectory);
      throw new RunWorkspaceError('RUN_ALREADY_COMPLETED', `Run 已经完成：${this.runId}`);
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(this.runningDirectory, { recursive: false });
    await mkdir(this.evidenceDirectory, { recursive: false });
  }

  writer(role: AgentRole): RunArtifactWriter {
    const allowed = ROLE_ARTIFACTS[role];
    return {
      writePlan: (content) => this.writeForRole(role, 'plan.md', content, allowed),
      writeExecution: (content) => this.writeForRole(role, 'execution.md', content, allowed),
      writeDraftReport: (content) => this.writeForRole(role, 'draft-report.md', content, allowed),
      writeReview: (content) => this.writeForRole(role, 'review.md', content, allowed),
      writeReport: (content) => this.writeForRole(role, 'report.md', content, allowed),
    };
  }

  async read(name: RunArtifactName): Promise<string> {
    const path = this.artifactPath(name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `Run 工件不是普通文件：${name}`);
      }
      return await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RunWorkspaceError('ARTIFACT_MISSING', `Run 工件不存在：${name}`);
      }
      throw error;
    }
  }

  async exists(name: RunArtifactName): Promise<boolean> {
    try {
      await this.read(name);
      return true;
    } catch (error) {
      if (error instanceof RunWorkspaceError && error.code === 'ARTIFACT_MISSING') return false;
      throw error;
    }
  }

  async list(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const name of RUN_ARTIFACT_NAMES) {
      if (await this.exists(name)) files[name] = await this.read(name);
    }
    return files;
  }

  async assertComplete(): Promise<void> {
    for (const name of RUN_ARTIFACT_NAMES) {
      const content = await this.read(name);
      if (content.trim() === '') {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `Run 工件不能为空：${name}`);
      }
    }
  }

  async listEvidence(): Promise<RunEvidenceFile[]> {
    const files: RunEvidenceFile[] = [];
    await this.walkEvidence(this.evidenceDirectory, '', files);
    return files.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readEvidence(name: string): Promise<Buffer> {
    const path = this.evidencePath(name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `证据不是普通文件：${name}`);
      }
      if (info.size > MAX_EVIDENCE_BYTES) {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `证据超出大小限制：${name}`);
      }
      return await readFile(path);
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RunWorkspaceError('ARTIFACT_MISSING', `证据不存在：${name}`);
      }
      throw error;
    }
  }

  async removeEvidence(): Promise<void> {
    await rm(this.evidenceDirectory, { recursive: true, force: true });
  }

  async finalize(): Promise<void> {
    await this.assertComplete();
    try {
      await lstat(this.completedDirectory);
      throw new RunWorkspaceError('RUN_ALREADY_COMPLETED', `完成目录已存在：${this.runId}`);
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(this.runningDirectory, this.completedDirectory);
  }

  private async writeForRole(
    role: AgentRole,
    name: RunArtifactName,
    content: string,
    allowed: readonly RunArtifactName[],
  ): Promise<void> {
    if (!allowed.includes(name)) {
      throw new RunWorkspaceError('ARTIFACT_NOT_ALLOWED', `${role} 不能写入 ${name}`);
    }
    if (typeof content !== 'string' || content.trim() === '' || content.includes('\u0000')) {
      throw new RunWorkspaceError('ARTIFACT_INVALID', `${name} 必须是非空 Markdown 文本`);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) {
      throw new RunWorkspaceError('ARTIFACT_INVALID', `${name} 超出大小限制`);
    }
    const path = this.artifactPath(name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `拒绝覆盖非普通文件：${name}`);
      }
    } catch (error) {
      if (error instanceof RunWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  }

  private artifactPath(name: RunArtifactName): string {
    if (!RUN_ARTIFACT_NAMES.includes(name)) {
      throw new RunWorkspaceError('ARTIFACT_NOT_ALLOWED', `不支持的 Run 工件：${name}`);
    }
    const path = resolve(this.directory, name);
    const relativePath = relative(this.directory, path);
    if (isAbsolute(relativePath) || relativePath !== name) {
      throw new RunWorkspaceError('ARTIFACT_NOT_ALLOWED', `Run 工件路径越界：${name}`);
    }
    return path;
  }

  private evidencePath(name: string): string {
    assertEvidenceName(name);
    const path = resolve(this.evidenceDirectory, name);
    const relativePath = relative(this.evidenceDirectory, path);
    if (isAbsolute(relativePath) || relativePath !== name) {
      throw new RunWorkspaceError('ARTIFACT_NOT_ALLOWED', `证据路径越界：${name}`);
    }
    return path;
  }

  private async walkEvidence(
    directory: string,
    prefix: string,
    files: RunEvidenceFile[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertEvidenceName(name);
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new RunWorkspaceError('ARTIFACT_INVALID', `拒绝读取符号链接证据：${name}`);
      }
      if (info.isDirectory()) {
        await this.walkEvidence(path, name, files);
      } else if (info.isFile()) {
        if (info.size > MAX_EVIDENCE_BYTES) {
          throw new RunWorkspaceError('ARTIFACT_INVALID', `证据超出大小限制：${name}`);
        }
        files.push({ name, path, sizeBytes: info.size });
      }
    }
  }
}

export class RunWorkspaceStore {
  private readonly reportRoot: string;

  constructor(reportRoot: string) {
    this.reportRoot = resolve(reportRoot);
  }

  async create(runId: string): Promise<RunWorkspace> {
    const workspace = new RunWorkspace(runId, this.reportRoot);
    await workspace.create();
    return workspace;
  }

  open(runId: string, placement: 'running' | 'completed'): RunWorkspace {
    return new RunWorkspace(runId, this.reportRoot, placement);
  }

  async list(placement: 'running' | 'completed'): Promise<string[]> {
    const directory = resolve(this.reportRoot, placement);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  get root(): string {
    return this.reportRoot;
  }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunWorkspaceError('RUN_ID_INVALID', 'Run ID 必须是 26 位 Crockford Base32 ULID');
  }
}

export function assertEvidenceName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    name.split('/').some((part) => part.startsWith('.'))
  ) {
    throw new RunWorkspaceError('ARTIFACT_NOT_ALLOWED', '证据文件名无效');
  }
}

export function createRunId(now = Date.now(), random = cryptoRandomBytes(10)): string {
  const timestamp = encodeBase32(BigInt(now), 10);
  const entropy = encodeBase32(BigInt(`0x${random.toString('hex')}`), 16);
  return `${timestamp}${entropy}`;
}

const ROLE_ARTIFACTS: Record<AgentRole, readonly RunArtifactName[]> = {
  'main-a': ['plan.md'],
  runner: ['execution.md', 'draft-report.md'],
  reviewer: ['review.md'],
  'main-b': ['report.md'],
};

function encodeBase32(value: bigint, length: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let current = value;
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result = alphabet[Number(current & 31n)] + result;
    current >>= 5n;
  }
  return result;
}

function cryptoRandomBytes(size: number): Buffer {
  return randomBytes(size);
}
