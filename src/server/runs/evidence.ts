import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { EvidenceReference } from '../../shared/types.js';
import { createTextResult } from './agent-session.js';
import { redactSensitiveText } from './test-data.js';
import type { CommandRunResult } from './command-runner.js';
import type { OssAdapter } from '../storage/oss.js';
import { contentTypeFor } from '../storage/oss.js';
import { RunWorkspace, type RunEvidenceFile } from './workspace.js';

const MAX_REVIEW_IMAGE_BYTES = 16 * 1024 * 1024;

export interface EvidenceUploadResult {
  references: EvidenceReference[];
  failures: EvidenceUploadFailure[];
}

export interface EvidenceUploadFailure {
  filename: string;
  message: string;
}

export interface EvidenceCleanupResult {
  deleted: string[];
  failures: EvidenceUploadFailure[];
}

export interface RunEvidenceStore {
  list(): Promise<RunEvidenceFile[]>;
  upload(filename: string): Promise<EvidenceReference>;
  uploadAll(): Promise<EvidenceUploadResult>;
  read(filename: string): Promise<EvidenceReadResult>;
  readUploaded?(filename: string): Promise<EvidenceReadResult>;
  cleanupLocal(): Promise<void>;
  cleanupUploaded(): Promise<EvidenceCleanupResult>;
  readFailureCount?: () => number;
  recordReadFailure?: () => void;
  reviewReadCount?: () => number;
  recordReviewRead?: () => void;
  captureCommand(
    command: string,
    targetCommit: string,
    result: CommandRunResult | { error: string },
    secrets: readonly string[],
  ): Promise<string>;
  commandEvidenceIds(): string[];
  readCommandEvidence(filename: string): Promise<string>;
}

export interface EvidenceReadResult {
  filename: string;
  body: Buffer;
  contentType: string;
  source: 'oss' | 'local';
  url: string | null;
}

export function createRunEvidenceStore(
  workspace: RunWorkspace,
  oss?: OssAdapter,
): RunEvidenceStore {
  return new DefaultRunEvidenceStore(workspace, oss);
}

class DefaultRunEvidenceStore implements RunEvidenceStore {
  private readonly references = new Map<string, EvidenceReference>();
  private readFailures = 0;
  private reviewReads = 0;
  private readonly commandEvidence = new Map<string, { sha256: string; sizeBytes: number }>();
  private commandSequence = 0;

  constructor(
    private readonly workspace: RunWorkspace,
    private readonly configuredOss?: OssAdapter,
  ) {}

  private get oss(): OssAdapter {
    if (!this.configuredOss) throw new Error('OSS Adapter 不可用，证据仅保留在本地');
    return this.configuredOss;
  }

  async list(): Promise<RunEvidenceFile[]> {
    const files = await this.workspace.listEvidence();
    const byName = new Map(files.map((file) => [file.name, file]));
    for (const reference of this.references.values()) {
      if (!byName.has(reference.filename)) {
        byName.set(reference.filename, {
          name: reference.filename,
          path: '',
          sizeBytes: reference.sizeBytes,
        });
      }
    }
    for (const [name, captured] of this.commandEvidence) {
      if (!byName.has(name)) byName.set(name, { name, path: '', sizeBytes: captured.sizeBytes });
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async upload(filename: string): Promise<EvidenceReference> {
    const existing = this.references.get(filename);
    if (existing) return existing;
    const files = await this.workspace.listEvidence();
    const file = files.find((item) => item.name === filename);
    if (!file) throw new Error(`证据文件不存在：${filename}`);
    if (this.commandEvidence.has(filename)) {
      this.assertCommandIntegrity(filename, await this.workspace.readEvidence(filename));
    }
    const reference = await this.oss.uploadFile(this.workspace.runId, filename, file.path);
    this.references.set(filename, reference);
    return reference;
  }

  async uploadAll(): Promise<EvidenceUploadResult> {
    const references: EvidenceReference[] = [];
    const failures: EvidenceUploadFailure[] = [];
    for (const file of await this.list()) {
      try {
        references.push(await this.upload(file.name));
      } catch (error) {
        failures.push({ filename: file.name, message: safeMessage(error) });
      }
    }
    return { references, failures };
  }

  async read(filename: string): Promise<EvidenceReadResult> {
    try {
      const reference = this.references.get(filename);
      if (reference) {
        const object = await this.oss.getObject(reference.objectKey);
        return {
          filename,
          body: object.body,
          contentType: object.contentType || reference.contentType,
          source: 'oss',
          url: reference.url,
        };
      }
      const body = await this.workspace.readEvidence(filename);
      return {
        filename,
        body,
        contentType: contentTypeFor(filename),
        source: 'local',
        url: null,
      };
    } catch (error) {
      this.readFailures += 1;
      throw error;
    }
  }

  async readUploaded(filename: string): Promise<EvidenceReadResult> {
    const reference = this.references.get(filename);
    if (!reference) {
      this.readFailures += 1;
      throw new Error(`证据尚未成功上传：${filename}`);
    }
    try {
      const object = await this.oss.getObject(reference.objectKey);
      return {
        filename,
        body: object.body,
        contentType: object.contentType || reference.contentType,
        source: 'oss',
        url: reference.url,
      };
    } catch (error) {
      this.readFailures += 1;
      throw error;
    }
  }

  cleanupLocal(): Promise<void> {
    return this.workspace.removeEvidence();
  }

  async cleanupUploaded(): Promise<EvidenceCleanupResult> {
    const deleted: string[] = [];
    const failures: EvidenceUploadFailure[] = [];
    for (const [filename, reference] of this.references) {
      try {
        await this.oss.deleteObject(reference.objectKey);
        this.references.delete(filename);
        deleted.push(filename);
      } catch (error) {
        failures.push({ filename, message: safeMessage(error) });
      }
    }
    return { deleted, failures };
  }

  readFailureCount(): number {
    return this.readFailures;
  }

  recordReadFailure(): void {
    this.readFailures += 1;
  }

  reviewReadCount(): number {
    return this.reviewReads;
  }

  recordReviewRead(): void {
    this.reviewReads += 1;
  }

  async captureCommand(
    command: string,
    targetCommit: string,
    result: CommandRunResult | { error: string },
    secrets: readonly string[],
  ): Promise<string> {
    const clean = (value: string, limit?: number) => redactCommandText(value, secrets, limit);
    const content = `${JSON.stringify(
      {
        runId: this.workspace.runId,
        targetCommit,
        command: clean(command, 16 * 1024),
        result:
          'error' in result
            ? { error: clean(result.error) }
            : {
                exitCode: result.exitCode,
                stdout: clean(result.stdout),
                stderr: clean(result.stderr),
              },
      },
      null,
      2,
    )}\n`;
    const filename = `command-${++this.commandSequence}.json`;
    await this.workspace.writeHarnessEvidence(filename, content);
    this.commandEvidence.set(filename, {
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: Buffer.byteLength(content),
    });
    return filename;
  }

  commandEvidenceIds(): string[] {
    return [...this.commandEvidence.keys()];
  }

  private assertCommandIntegrity(filename: string, body: Buffer): void {
    const expected = this.commandEvidence.get(filename);
    if (
      !expected ||
      body.byteLength > 1024 * 1024 ||
      createHash('sha256').update(body).digest('hex') !== expected.sha256
    ) {
      throw new Error('命令证据不属于本 Run 的 Harness 捕获记录或内容已改变');
    }
  }

  async readCommandEvidence(filename: string): Promise<string> {
    // Membership is checked before any path or OSS access. Other JSON/text is not readable.
    if (!this.commandEvidence.has(filename)) throw new Error('不是本 Run 的受控命令证据 ID');
    const evidence = await this.read(filename);
    this.assertCommandIntegrity(filename, evidence.body);
    this.recordReviewRead();
    return evidence.body.toString('utf8');
  }
}

export function redactCommandText(
  value: string,
  secrets: readonly string[],
  limit = 64 * 1024,
): string {
  let text = value;
  const representations = secrets
    .filter(Boolean)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
  for (const secret of representations.sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  // Remove complete header/quoted credential values, not just the first word.
  text = text
    .replace(/((?:set-cookie|cookie|authorization)\s*["']?\s*[:=])[^\r\n]*/gi, '$1 [REDACTED]')
    .replace(
      /((?:password|passwd|token|secret|api[-_]?key)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi,
      '$1[REDACTED]',
    );
  text = redactSensitiveText(text);
  const bytes = Buffer.from(text);
  return bytes.length <= limit
    ? text
    : `${bytes
        .subarray(0, limit)
        .toString('utf8')
        .replace(/\uFFFD$/, '')}\n[command evidence truncated]`;
}

export function createRunnerEvidenceTools(store: RunEvidenceStore): ToolDefinition[] {
  const filenameParameters = Type.Object({
    filename: Type.String({ description: 'evidence 目录中的相对文件名' }),
  });
  return [
    {
      name: 'list_evidence_files',
      label: '列出证据文件',
      description: '列出当前 Run evidence 目录中的普通文件，只返回相对文件名和大小。',
      parameters: Type.Object({}),
      execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const files = await store.list();
          return createTextResult(
            JSON.stringify(files.map(({ name, sizeBytes }) => ({ name, sizeBytes }))),
          );
        } catch (error) {
          return createTextResult(safeMessage(error), { error: true });
        }
      },
    },
    {
      name: 'upload_evidence',
      label: '上传证据',
      description:
        '将当前 Run 的证据文件保存到配置的证据存储，并返回不含短期签名的稳定地址。成功仅说明该存储已接收，不据此推断远程发布；不得把本地绝对路径写入报告。',
      parameters: filenameParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof filenameParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const reference = await store.upload(params.filename);
          return createTextResult(
            JSON.stringify({
              filename: reference.filename,
              url: reference.url,
              contentType: reference.contentType,
              sizeBytes: reference.sizeBytes,
            }),
          );
        } catch (error) {
          return createTextResult(safeMessage(error), { error: true });
        }
      },
    },
  ];
}

export function createReviewerEvidenceTools(store: RunEvidenceStore): ToolDefinition[] {
  const filenameParameters = Type.Object({
    filename: Type.String({ description: '已上传截图的相对文件名' }),
  });
  return [
    {
      name: 'list_evidence_files',
      label: '列出审核证据',
      description: '列出本次 Run 的图片及 Harness 捕获的脱敏命令结果；其他文本与任意路径不可读。',
      parameters: Type.Object({}),
      execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const commandIds = store.commandEvidenceIds();
          const files = (await store.list()).filter(
            ({ name }) => contentTypeFor(name).startsWith('image/') || commandIds.includes(name),
          );
          return createTextResult(
            JSON.stringify(files.map(({ name, sizeBytes }) => ({ name, sizeBytes }))),
          );
        } catch (error) {
          return createTextResult(safeMessage(error), { error: true });
        }
      },
    },
    {
      name: 'read_command_evidence',
      label: '读取受控命令结果',
      description:
        '按本 Run 的证据 ID 只读查询 Harness 捕获的命令、退出码和脱敏输出；截断会标注，不执行命令，不读取任意文本、路径或其他 Session。',
      parameters: Type.Object({
        filename: Type.String({ description: 'list_evidence_files 返回的 command 证据 ID' }),
      }),
      execute: async (_toolCallId: string, params: { filename: string }) => {
        try {
          return createTextResult(await store.readCommandEvidence(params.filename));
        } catch {
          store.recordReadFailure?.();
          return createTextResult(
            '受控命令证据不可用或校验失败；请核对本 Run 的证据 ID，不能确认相关结果',
            { error: true },
          );
        }
      },
    },
    {
      name: 'read_evidence_image',
      label: '读取截图证据',
      description:
        '从当前 Run 的证据存储中读取一张截图供独立审核；不能执行命令、读取测试账号或读取其他路径。',
      parameters: filenameParameters,
      execute: async (
        _toolCallId: string,
        params: Static<typeof filenameParameters>,
      ): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const evidence = store.readUploaded
            ? await store.readUploaded(params.filename)
            : await store.read(params.filename);
          if (!evidence.contentType.startsWith('image/')) {
            store.recordReadFailure?.();
            return createTextResult('该证据不是图片，Reviewer 只能通过此工具查看截图', {
              error: true,
            });
          }
          if (evidence.body.byteLength > MAX_REVIEW_IMAGE_BYTES) {
            store.recordReadFailure?.();
            return createTextResult('截图超过审核大小限制', { error: true });
          }
          store.recordReviewRead?.();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  filename: evidence.filename,
                  contentType: evidence.contentType,
                  source: evidence.source,
                  stableUrl: evidence.url,
                }),
              },
              {
                type: 'image',
                data: evidence.body.toString('base64'),
                mimeType: evidence.contentType.split(';', 1)[0] ?? 'image/png',
              },
            ],
            details: { filename: evidence.filename, source: evidence.source },
          } as AgentToolResult<Record<string, unknown>>;
        } catch (error) {
          return createTextResult(safeMessage(error), { error: true });
        }
      },
    },
  ];
}

export function evidenceReferenceContext(references: readonly EvidenceReference[]): string {
  return JSON.stringify(
    references.map(({ filename, url, contentType, sizeBytes, sha256 }) => ({
      filename,
      url,
      contentType,
      sizeBytes,
      sha256,
    })),
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : '证据操作失败';
}
