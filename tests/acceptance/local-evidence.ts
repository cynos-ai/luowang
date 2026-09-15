import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { contentTypeFor, type OssAdapter } from '../../src/server/storage/oss.js';

/** Offline transport for production evidence tests; no synthetic missing-object fallback. */
export function localEvidenceTransport() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const object = (key: string) => {
    const body = objects.get(key);
    if (!body) throw new Error('Local evidence object missing');
    return {
      key,
      body: Buffer.from(body),
      contentType: contentTypeFor(key),
      contentLength: body.length,
      etag: null,
    };
  };
  const oss: OssAdapter = {
    isConfigured: () => true,
    checkConnectivity: async () => ({
      status: 'ok',
      message: 'local evidence transport only',
      checkedAt: null,
      latencyMs: null,
    }),
    objectKey: (runId, filename) => `${runId}/${filename}`,
    stableUrlForKey: (key) => `/api/evidence/${Buffer.from(key).toString('base64url')}`,
    async uploadFile(runId, filename, path) {
      const body = await readFile(path);
      const key = `${runId}/${filename}`;
      objects.set(key, Buffer.from(body));
      return {
        id: Buffer.from(key).toString('base64url'),
        filename,
        objectKey: key,
        url: this.stableUrlForKey(key),
        contentType: contentTypeFor(filename),
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        uploadedAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async putObject(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async getObject(key) {
      reads.push(key);
      return object(key);
    },
    async headObject(key) {
      return object(key);
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async getEvidenceByStableId(id) {
      return object(Buffer.from(id, 'base64url').toString());
    },
  };
  return { oss, objects, reads };
}
