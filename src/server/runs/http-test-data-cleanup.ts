import type { SecretStore } from '../security/secret-store.js';
import { UnsupportedCleanupScopeError, type TestDataCleanupAdapter } from './test-data.js';

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Trusted deployment endpoint only; agents cannot select a URL, token or deletion scope. */
export function createHttpTestDataCleanupAdapter(
  endpoint: string,
  secrets: Pick<SecretStore, 'get'>,
  request: typeof fetch = fetch,
): TestDataCleanupAdapter {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    throw new Error('测试数据清理地址无效');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('测试数据清理地址必须是不含凭据、查询或片段的 HTTP(S) 地址');
  }
  return {
    id: 'run-scoped-http-cleanup',
    async cleanupAndVerify({ runId, entry }) {
      if (!RUN_ID.test(runId) || !entry.id.startsWith(`luowang-${runId}-`)) {
        throw new Error('测试数据清理范围无效');
      }
      if (entry.cleanupScope !== 'website-accounts') {
        throw new UnsupportedCleanupScopeError('未绑定官网账号清理资源域');
      }
      const token = secrets.get('testDataCleanupToken');
      if (!token || token.length < 32) throw new Error('测试数据清理凭据未配置或无效');
      const url = base.href.replace(/\/$/, '') + '/' + runId;
      const signal = AbortSignal.timeout(10_000);
      const call = async (method: 'DELETE' | 'GET') => {
        const response = await request(url, {
          method,
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error('测试数据清理服务未确认成功');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('测试数据清理响应为空');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 4096) throw new Error('测试数据清理响应超限');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        let result: unknown;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new Error('测试数据清理响应不是有效 JSON');
        }
        if (
          !result ||
          typeof result !== 'object' ||
          !('runId' in result) ||
          result.runId !== runId ||
          !('remaining' in result) ||
          !Number.isSafeInteger(result.remaining) ||
          (result.remaining as number) < 0
        ) {
          throw new Error('测试数据清理响应范围或计数无效');
        }
        return result.remaining as number;
      };
      await call('DELETE');
      const remaining = await call('GET');
      // Never return the remote response body (which could contain echoed credentials).
      return {
        absent: remaining === 0,
        statusCode: 200,
        content: JSON.stringify({ runId, remaining, verification: 'independent-get-after-delete' }),
      };
    },
  };
}
