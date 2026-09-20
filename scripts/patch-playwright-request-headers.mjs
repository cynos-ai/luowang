import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import './patch-playwright-screenshot-guard.mjs';

// The pinned MCP uses Request.headers(), which omits Cookie. Preserve the
// existing tool surface, but await allHeaders() for independently reviewable
// session replay. Fail closed when the pinned upstream format changes.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('playwright-core/package.json'));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (version !== '1.63.0-alpha-2026-08-05')
  throw new Error('Unexpected Playwright version for request-header patch');
const path = join(root, 'lib/coreBundle.js');
let source = await readFile(path, 'utf8');
const edits = [
  [
    'function renderRequestDetails(index, request2, skillMode) {',
    'async function renderRequestDetails(index, request2, skillMode) {',
  ],
  [
    'appendHeaderSection(lines, "Request headers", request2.headers());',
    'appendHeaderSection(lines, "Request headers", await request2.allHeaders());',
  ],
  [
    'renderHeaders(request2.headers()), { prefix: "request",',
    'renderHeaders(await request2.allHeaders()), { prefix: "request",',
  ],
  [
    'response2.addResult("Request", renderRequestDetails(params2.index, request2, !!tab2.context.config.skillMode),',
    'response2.addResult("Request", await renderRequestDetails(params2.index, request2, !!tab2.context.config.skillMode),',
  ],
];
const count = (text) => source.split(text).length - 1;
// Check the complete post-patch shape first (the async function contains the old substring).
if (edits.every(([, after]) => count(after) === 1)) process.exit(0);
if (!edits.every(([before, after]) => count(before) === 1 && count(after) === 0)) {
  throw new Error('Pinned MCP request-header implementation changed; patch not applied');
}
for (const [before, after] of edits) source = source.replace(before, after);
await writeFile(path, source);
console.log('Applied pinned MCP complete request-header fix');
