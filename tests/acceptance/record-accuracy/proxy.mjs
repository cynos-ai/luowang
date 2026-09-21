import { createServer } from 'node:http';

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
        const upstream = await request(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(180000),
        });
        receipt.httpStatus = upstream.status;
        if (!upstream.ok || !upstream.body) throw new Error('Upstream rejected');
        let tail = '',
          done = !input.stream,
          bytes = 0;
        const responseParts = [];
        for await (const part of upstream.body) {
          bytes += part.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('Response too large');
          responseParts.push(Buffer.from(part));
          tail = (tail + Buffer.from(part).toString('utf8')).slice(-4096);
          if (/data:\s*\[DONE\]/.test(tail)) done = true;
        }
        if (!done) throw new Error('Incomplete stream');
        if (res.destroyed) throw new Error('Consumer disconnected');
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
