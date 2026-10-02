import { mkdir, readFile } from 'node:fs/promises';
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
  // The pinned stdio transport sends SIGKILL after its cooperative deadline but
  // returns before the child close event. Keep the Run occupied until actual exit.
  plugins: [
    {
      name: 'confirm-owned-mcp-child-exit',
      setup(builder) {
        let applied = false;
        builder.onEnd(() => {
          if (!applied) throw new Error('MCP child exit confirmation was not bundled');
        });
        builder.onLoad(
          { filter: /@modelcontextprotocol[\\/]client[\\/]dist[\\/]stdio\.mjs$/ },
          async ({ path }) => {
            const source = await readFile(path, 'utf8');
            const end =
              '\t\t\tif (processToClose.exitCode === null) try {\n\t\t\t\tprocessToClose.kill("SIGKILL");\n\t\t\t} catch {}';
            if (!source.includes(end))
              throw new Error(
                'Pinned MCP stdio shutdown changed; review exit confirmation before building',
              );
            applied = true;
            return {
              contents: source.replace(end, `${end}\n\t\t\tawait closePromise;`),
              loader: 'js',
            };
          },
        );
      },
    },
  ],
  // pi-mcp-adapter includes CommonJS dependencies that use runtime `require`
  // calls (for example, cross-spawn).  The generated file is ESM, so provide
  // a real Node-compatible require before esbuild's dynamic-require shim runs.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: 'warning',
});
