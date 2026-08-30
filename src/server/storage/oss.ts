import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

import type { ConnectivityResult, EvidenceReference, HarnessConfig } from '../../shared/types.js';
import type { ConfigurationStore } from '../configuration.js';
import type { SecretStore } from '../security/secret-store.js';
import { assertEvidenceName } from '../runs/workspace.js';

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PRIVATE_EVIDENCE_ROUTE = '/api/evidence/';
const RUN_SEGMENT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

export interface OssObject {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength: number;
  etag: string | null;
}

export interface OssObjectMetadata {
  key: string;
  contentType: string;
  contentLength: number;
  etag: string | null;
}

export interface OssAdapter {
  isConfigured(): boolean;
  objectKey(runId: string, filename: string): string;
  stableUrlForKey(key: string): string;
  uploadFile(runId: string, filename: string, filePath: string): Promise<EvidenceReference>;
  putObject(key: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void>;
  getObject(key: string): Promise<OssObject>;
  headObject(key: string): Promise<OssObjectMetadata>;
  deleteObject(key: string): Promise<void>;
  getEvidenceByStableId(stableId: string): Promise<OssObject>;
  checkConnectivity(): Promise<ConnectivityResult>;
}

export interface OssAdapterOptions {
  clientFactory?: (config: S3ClientConfig) => S3ClientLike;
  now?: () => Date;
  randomId?: () => string;
  timeoutMs?: number;
}

export interface S3ClientLike {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?: () => void;
}

export class OssError extends Error {
  readonly code:
    | 'OSS_NOT_CONFIGURED'
    | 'OSS_CONFIGURATION_INVALID'
    | 'OSS_OBJECT_INVALID'
    | 'OSS_REQUEST_FAILED'
    | 'OSS_OBJECT_NOT_FOUND';

  constructor(code: OssError['code'], message: string) {
    super(message);
    this.name = 'OssError';
    this.code = code;
  }
}

export function createOssAdapter(
  configuration: ConfigurationStore,
  secretStore: SecretStore,
  options: OssAdapterOptions = {},
): OssAdapter {
  return new S3OssAdapter(configuration, secretStore, options);
}

class S3OssAdapter implements OssAdapter {
  private client: S3ClientLike | undefined;
  private clientFingerprint: string | undefined;

  constructor(
    private readonly configuration: ConfigurationStore,
    private readonly secretStore: SecretStore,
    private readonly options: OssAdapterOptions,
  ) {}

  isConfigured(): boolean {
    return this.readSettings() !== undefined;
  }

  objectKey(runId: string, filename: string): string {
    assertRunSegment(runId);
    assertEvidenceName(filename);
    const prefix = normalizeObjectPrefix(this.configuration.getHarness().oss.objectPrefix);
    return `${prefix}${runId}/${filename}`;
  }

  stableUrlForKey(key: string): string {
    this.assertConfiguredKey(key);
    const settings = this.readSettings();
    if (!settings) throw new OssError('OSS_NOT_CONFIGURED', 'OSS 尚未完成配置');

    if (settings.publicBaseUrl !== '') {
      const base = parsePublicBaseUrl(settings.publicBaseUrl);
      const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
      base.pathname = `${basePath}${key.split('/').map(encodeURIComponent).join('/')}`;
      base.search = '';
      base.hash = '';
      return base.toString();
    }

    return `${PRIVATE_EVIDENCE_ROUTE}${encodeObjectKey(key)}`;
  }

  async uploadFile(runId: string, filename: string, filePath: string): Promise<EvidenceReference> {
    const info = await lstat(filePath).catch(() => {
      throw new OssError('OSS_OBJECT_INVALID', `证据文件不可读：${filename}`);
    });
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES) {
      throw new OssError('OSS_OBJECT_INVALID', `证据文件无效：${filename}`);
    }
    const body = await readFile(filePath);
    const key = this.objectKey(runId, filename);
    const contentType = contentTypeFor(filename);
    await this.putObject(key, body, contentType);
    return {
      id: encodeObjectKey(key),
      filename,
      objectKey: key,
      url: this.stableUrlForKey(key),
      contentType,
      sizeBytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      uploadedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    const settings = this.assertConfiguredKey(key);
    const client = this.getClient(settings);
    const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
    if (size > MAX_EVIDENCE_BYTES) {
      throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
    }
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs()) },
      );
    } catch (error) {
      throw classifyOssError(error, 'OSS 对象上传失败');
    }
  }

  async getObject(key: string): Promise<OssObject> {
    const settings = this.assertConfiguredKey(key);
    const client = this.getClient(settings);
    try {
      const response = (await client.send(
        new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs()) },
      )) as {
        Body?: unknown;
        ContentType?: string;
        ContentLength?: number;
        ETag?: string;
      };
      if (!response.Body) {
        throw new OssError('OSS_OBJECT_NOT_FOUND', 'OSS 对象内容为空');
      }
      const body = await bodyToBuffer(response.Body);
      if (body.byteLength > MAX_EVIDENCE_BYTES) {
        throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
      }
      return {
        key,
        body,
        contentType: response.ContentType ?? contentTypeFor(key),
        contentLength: response.ContentLength ?? body.byteLength,
        etag: response.ETag ?? null,
      };
    } catch (error) {
      if (error instanceof OssError) throw error;
      throw classifyOssError(error, 'OSS 对象读取失败');
    }
  }

  async headObject(key: string): Promise<OssObjectMetadata> {
    const settings = this.assertConfiguredKey(key);
    const client = this.getClient(settings);
    try {
      const response = (await client.send(
        new HeadObjectCommand({ Bucket: settings.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs()) },
      )) as { ContentType?: string; ContentLength?: number; ETag?: string };
      return {
        key,
        contentType: response.ContentType ?? contentTypeFor(key),
        contentLength: response.ContentLength ?? 0,
        etag: response.ETag ?? null,
      };
    } catch (error) {
      throw classifyOssError(error, 'OSS 对象探测失败');
    }
  }

  async deleteObject(key: string): Promise<void> {
    const settings = this.assertConfiguredKey(key);
    const client = this.getClient(settings);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(this.timeoutMs()),
      });
    } catch (error) {
      throw classifyOssError(error, 'OSS 对象删除失败');
    }
  }

  async getEvidenceByStableId(stableId: string): Promise<OssObject> {
    const key = decodeObjectKey(stableId);
    this.assertEvidenceKey(key);
    return this.getObject(key);
  }

  async checkConnectivity(): Promise<ConnectivityResult> {
    const startedAt = Date.now();
    const settings = this.readSettings();
    if (!settings) {
      return {
        status: 'not_configured',
        message: 'OSS 尚未完成 endpoint、bucket 或访问凭据配置',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    }

    const suffix = (this.options.randomId ?? (() => randomBytes(12).toString('hex')))();
    const key = `${normalizeObjectPrefix(settings.objectPrefix)}connectivity/${suffix}.txt`.replace(
      /^\//,
      '',
    );
    const body = Buffer.from('luowang-oss-connectivity-v1', 'utf8');
    let result: ConnectivityResult = {
      status: 'failed',
      message: 'OSS 测试对象读写失败',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
    };
    try {
      await this.putObject(key, body, 'text/plain; charset=utf-8');
      const head = await this.headObject(key);
      if (head.contentLength !== body.byteLength) {
        throw new OssError('OSS_REQUEST_FAILED', 'OSS 测试对象长度校验失败');
      }
      const object = await this.getObject(key);
      if (!object.body.equals(body)) {
        throw new OssError('OSS_REQUEST_FAILED', 'OSS 测试对象内容校验失败');
      }
      result = {
        status: 'ok',
        message: 'OSS 测试对象上传、读取和删除均可用',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      result = connectivityFailure(error, startedAt);
    } finally {
      try {
        await this.deleteObject(key);
      } catch {
        if (result?.status === 'ok') {
          result = {
            status: 'failed',
            message: 'OSS 测试对象删除失败',
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - startedAt,
          };
        }
      }
    }
    return result;
  }

  private readSettings(): OssSettings | undefined {
    const oss = this.configuration.getHarness().oss;
    const accessKeyId = this.secretStore.get('ossAccessKeyId');
    const accessKeySecret = this.secretStore.get('ossAccessKeySecret');
    if (
      oss.endpoint.trim() === '' ||
      oss.region.trim() === '' ||
      oss.bucket.trim() === '' ||
      !accessKeyId ||
      !accessKeySecret
    ) {
      return undefined;
    }
    const endpoint = parseEndpoint(oss.endpoint);
    const objectPrefix = normalizeObjectPrefix(oss.objectPrefix);
    return {
      endpoint: endpoint.toString(),
      region: oss.region.trim(),
      bucket: oss.bucket.trim(),
      publicBaseUrl: oss.publicBaseUrl.trim(),
      accessMode: oss.accessMode,
      objectPrefix,
      accessKeyId,
      accessKeySecret,
    };
  }

  private getClient(settings: OssSettings): S3ClientLike {
    const fingerprint = [
      settings.endpoint,
      settings.region,
      settings.bucket,
      settings.accessKeyId,
      createHash('sha256').update(settings.accessKeySecret).digest('hex'),
    ].join('\u0000');
    if (this.client && this.clientFingerprint === fingerprint) return this.client;
    this.client?.destroy?.();
    const config: S3ClientConfig = {
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.accessKeySecret,
      },
    };
    this.client = this.options.clientFactory?.(config) ?? new S3Client(config);
    this.clientFingerprint = fingerprint;
    return this.client;
  }

  private assertConfiguredKey(key: string): OssSettings {
    const settings = this.readSettings();
    if (!settings) throw new OssError('OSS_NOT_CONFIGURED', 'OSS 尚未完成配置');
    assertObjectKey(key, settings.objectPrefix);
    return settings;
  }

  private assertEvidenceKey(key: string): void {
    const settings = this.readSettings();
    if (!settings) throw new OssError('OSS_NOT_CONFIGURED', 'OSS 尚未完成配置');
    assertObjectKey(key, settings.objectPrefix);
    const rest = settings.objectPrefix !== '' ? key.slice(settings.objectPrefix.length) : key;
    const match = rest.match(/^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(.+)$/);
    if (!match || !RUN_SEGMENT_PATTERN.test(match[1])) {
      throw new OssError('OSS_OBJECT_INVALID', '证据对象路径无效');
    }
    try {
      assertEvidenceName(match[2]);
    } catch {
      throw new OssError('OSS_OBJECT_INVALID', '证据对象路径无效');
    }
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
}

interface OssSettings {
  endpoint: string;
  region: string;
  bucket: string;
  publicBaseUrl: string;
  accessMode: HarnessConfig['oss']['accessMode'];
  objectPrefix: string;
  accessKeyId: string;
  accessKeySecret: string;
}

function assertRunSegment(value: string): void {
  if (!RUN_SEGMENT_PATTERN.test(value)) {
    throw new OssError('OSS_OBJECT_INVALID', 'Run ID 无效');
  }
}

function assertObjectKey(key: string, prefix: string): void {
  if (
    typeof key !== 'string' ||
    key.trim() === '' ||
    key.includes('\\') ||
    key.includes('\u0000')
  ) {
    throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象路径无效');
  }
  const normalizedPrefix = normalizeObjectPrefix(prefix);
  if (normalizedPrefix !== '' && !key.startsWith(normalizedPrefix)) {
    throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出配置的 object prefix');
  }
  if (
    key.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    key.split('/').some((part) => !PREFIX_SEGMENT_PATTERN.test(part) && part !== '')
  ) {
    throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象路径无效');
  }
}

function normalizeObjectPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const segments = trimmed.split('/');
  if (segments.some((segment) => !PREFIX_SEGMENT_PATTERN.test(segment))) {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS object prefix 配置无效');
  }
  return `${segments.join('/')}/`;
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS endpoint 配置无效');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS endpoint 配置无效');
  }
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function parsePublicBaseUrl(value: string): URL {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS public base URL 配置无效');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS public base URL 配置无效');
  }
  if (base.search || base.hash) {
    throw new OssError('OSS_CONFIGURATION_INVALID', 'OSS public base URL 不能包含查询参数');
  }
  return base;
}

function encodeObjectKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeObjectKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象标识无效');
  }
  try {
    const key = Buffer.from(value, 'base64url').toString('utf8');
    if (encodeObjectKey(key) !== value) throw new Error('invalid encoding');
    return key;
  } catch {
    throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象标识无效');
  }
}

export function encodeStableEvidenceId(key: string): string {
  return encodeObjectKey(key);
}

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(basename(filename)).toLowerCase()] ?? 'application/octet-stream';
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_EVIDENCE_BYTES) {
      throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
    }
    return Buffer.from(body);
  }
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  };
  if (typeof candidate.transformToByteArray === 'function') {
    const buffer = Buffer.from(await candidate.transformToByteArray());
    if (buffer.byteLength > MAX_EVIDENCE_BYTES) {
      throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
    }
    return buffer;
  }
  if (typeof candidate[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of candidate as AsyncIterable<unknown>) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : Buffer.from(String(chunk));
      total += buffer.byteLength;
      if (total > MAX_EVIDENCE_BYTES) {
        throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  if (typeof body === 'string') {
    const buffer = Buffer.from(body, 'utf8');
    if (buffer.byteLength > MAX_EVIDENCE_BYTES) {
      throw new OssError('OSS_OBJECT_INVALID', 'OSS 对象超出大小限制');
    }
    return buffer;
  }
  throw new OssError('OSS_REQUEST_FAILED', 'OSS 返回了无法读取的对象内容');
}

function classifyOssError(error: unknown, fallback: string): OssError {
  if (error instanceof OssError) return error;
  const possible = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = possible.$metadata?.httpStatusCode;
  if (status === 404 || possible.name === 'NoSuchKey' || possible.name === 'NotFound') {
    return new OssError('OSS_OBJECT_NOT_FOUND', 'OSS 对象不存在');
  }
  return new OssError('OSS_REQUEST_FAILED', fallback);
}

function connectivityFailure(error: unknown, startedAt: number): ConnectivityResult {
  const possible = error as { name?: unknown; code?: unknown };
  const timedOut = possible.name === 'AbortError' || possible.code === 'ETIMEDOUT';
  return {
    status: timedOut ? 'timeout' : 'failed',
    message: timedOut ? 'OSS 检查超时' : 'OSS 测试对象读写失败',
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}
