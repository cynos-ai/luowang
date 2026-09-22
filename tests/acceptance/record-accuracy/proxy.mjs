import { createServer } from 'node:http';

const DNS_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TLS_FAILURE_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function upstreamFailureCategory(error) {
  if (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    error?.name === 'TimeoutError'
  ) {
    return 'upstream-timeout';
  }
  const codes = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (typeof current.code === 'string') codes.push(current.code);
    current = current.cause;
  }
  if (codes.includes('ETIMEDOUT')) return 'upstream-timeout';
  if (codes.some((code) => DNS_FAILURE_CODES.has(code))) return 'upstream-dns';
  if (
    codes.some(
      (code) =>
        TLS_FAILURE_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'),
    )
  ) {
    return 'upstream-tls';
  }
  return 'upstream-connect';
}

// Completion (including the response body) belongs to the counted attempt.
export function modelProxy(budget, endpoint, apiKey, request = fetch) {
  return createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const input = JSON.parse(body);
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/chat/completions' ||
        !['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(input.model)
      ) {
        budget.stop('invalid-model-request');
        res.writeHead(400).end();
        return;
      }
      await budget.request(input.model, async (receipt) => {
        let upstream;
        try {
          upstream = await request(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(180000),
          });
        } catch (error) {
          receipt.failureCategory = upstreamFailureCategory(error);
          throw error;
        }
        receipt.httpStatus = upstream.status;
        if (!upstream.ok) {
          receipt.failureCategory = 'upstream-http';
          throw new Error('Upstream rejected');
        }
        if (!upstream.body) {
          receipt.failureCategory = 'upstream-missing-body';
          throw new Error('Upstream body missing');
        }
        let tail = '',
          done = !input.stream,
          bytes = 0;
        const responseParts = [];
        try {
          for await (const part of upstream.body) {
            bytes += part.length;
            if (bytes > 4 * 1024 * 1024) {
              receipt.failureCategory = 'response-too-large';
              throw new Error('Response too large');
            }
            responseParts.push(Buffer.from(part));
            tail = (tail + Buffer.from(part).toString('utf8')).slice(-4096);
            if (/data:\s*\[DONE\]/.test(tail)) done = true;
          }
        } catch (error) {
          receipt.failureCategory ??= 'response-stream-error';
          throw error;
        }
        if (!done) {
          receipt.failureCategory = 'response-incomplete';
          throw new Error('Incomplete stream');
        }
        if (res.destroyed) {
          receipt.failureCategory = 'consumer-disconnected';
          throw new Error('Consumer disconnected');
        }
        res.writeHead(200, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        res.end(Buffer.concat(responseParts));
      });
    } catch {
      budget.stop('transport-or-response-failure');
      if (res.headersSent) res.destroy();
      else res.writeHead(403).end(JSON.stringify({ error: { message: 'Evaluation stopped' } }));
    }
  });
}
