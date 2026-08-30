import { Type, type Static } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { EvidenceReference } from '../../shared/types.js';
import { createTextResult } from './agent-session.js';
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

export interface RunEvidenceStore {
  list(): Promise<RunEvidenceFile[]>;
  upload(filename: string): Promise<EvidenceReference>;
  uploadAll(): Promise<EvidenceUploadResult>;
  read(filename: string): Promise<EvidenceReadResult>;
  readUploaded?(filename: string): Promise<EvidenceReadResult>;
  cleanupLocal(): Promise<void>;
  readFailureCount?: () => number;
  recordReadFailure?: () => void;
  reviewReadCount?: () => number;
  recordReviewRead?: () => void;
}

export interface EvidenceReadResult {
  filename: string;
  body: Buffer;
  contentType: string;
  source: 'oss' | 'local';
  url: string | null;
}

export function createRunEvidenceStore(workspace: RunWorkspace, oss: OssAdapter): RunEvidenceStore {
  return new DefaultRunEvidenceStore(workspace, oss);
}

class DefaultRunEvidenceStore implements RunEvidenceStore {
  private readonly references = new Map<string, EvidenceReference>();
  private readFailures = 0;
  private reviewReads = 0;

  constructor(
    private readonly workspace: RunWorkspace,
    private readonly oss: OssAdapter,
  ) {}

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
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async upload(filename: string): Promise<EvidenceReference> {
    const existing = this.references.get(filename);
    if (existing) return existing;
    const files = await this.workspace.listEvidence();
    const file = files.find((item) => item.name === filename);
    if (!file) throw new Error(`证据文件不存在：${filename}`);
    const reference = await this.oss.uploadFile(this.workspace.runId, filename, file.path);
    this.references.set(filename, reference);
    return reference;
  }

  async uploadAll(): Promise<EvidenceUploadResult> {
    const references: EvidenceReference[] = [];
    const failures: EvidenceUploadFailure[] = [];
    for (const file of await this.workspace.listEvidence()) {
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
        '将当前 Run 的证据文件上传到配置的 OSS，并返回不含短期签名的稳定地址。不得把本地绝对路径写入报告。',
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
      description: '列出本次 Run 已产生的证据文件；只能读取当前 Run 的证据。',
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
      name: 'read_evidence_image',
      label: '读取截图证据',
      description:
        '从当前 Run 的 OSS 证据中读取一张截图供独立审核；不能执行命令、读取测试账号或读取其他路径。',
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
