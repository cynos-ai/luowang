import { ConfigurationError } from '../configuration.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PREFIX = '@luowang-file-v1:';
export type ProjectFileContent = {
  bytes: Buffer;
  purpose: 'config' | 'data';
  encoding: 'utf8' | 'base64';
};

export function encodeUploadedContent(content: string, purpose: 'config' | 'data'): string {
  if (
    !content ||
    content.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
  )
    throw new ConfigurationError('上传内容无效或超过 10 MiB');
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new ConfigurationError('文件超过 10 MiB');
  if (
    purpose === 'config' &&
    (bytes.length > 256 * 1024 || bytes.toString('utf8').includes('\uFFFD') || bytes.includes(0))
  )
    throw new ConfigurationError('配置文件仅支持 256 KiB 以内的 UTF-8 文本');
  return PREFIX + JSON.stringify({ purpose, content });
}

export function decodeProjectFileContent(value: string): ProjectFileContent {
  if (!value.startsWith(PREFIX))
    return { bytes: Buffer.from(value, 'utf8'), purpose: 'config', encoding: 'utf8' };
  const record = JSON.parse(value.slice(PREFIX.length)) as {
    purpose: 'config' | 'data';
    content: string;
  };
  return {
    bytes: Buffer.from(record.content, 'base64'),
    purpose: record.purpose,
    encoding: 'base64',
  };
}
