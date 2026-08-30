import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { build } from 'esbuild';

const projectRoot = resolve(process.cwd());
const outputDirectory = resolve(projectRoot, 'dist/server/vendor');

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(projectRoot, 'node_modules/pi-mcp-adapter/index.ts')],
  outfile: resolve(outputDirectory, 'pi-mcp-adapter.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // pi-mcp-adapter includes CommonJS dependencies that use runtime `require`
  // calls (for example, cross-spawn).  The generated file is ESM, so provide
  // a real Node-compatible require before esbuild's dynamic-require shim runs.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: 'warning',
});
