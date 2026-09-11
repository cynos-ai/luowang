import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import { runBrowserPreflight } from '../src/server/browser/preflight.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function unusedBrowser(): BrowserMcpAdapter {
  return {
    isEnabled: () => {
      throw new Error('Browser must not start before filesystem checks');
    },
    serverDefinition: () => {
      throw new Error('Unexpected server definition');
    },
    extension: () => {
      throw new Error('Unexpected extension');
    },
    checkConnectivity: () => {
      throw new Error('Discovery is not a native startup proof');
    },
  };
}
it('fails closed without an explicit state directory and makes no model request', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  expect(await runBrowserPreflight(unusedBrowser())).toMatchObject({
    status: 'failed',
    modelRequests: 0,
    failure: { stage: 'state-directory', code: 'EXPLICIT_STATE_DIRECTORY_REQUIRED' },
  });
});
it('actually creates the state directory instead of trusting configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luowang-preflight-test-'));
  directories.push(root);
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'occupied');
  vi.stubEnv('PI_CODING_AGENT_DIR', file);
  expect(await runBrowserPreflight(unusedBrowser())).toMatchObject({
    status: 'failed',
    modelRequests: 0,
    failure: { stage: 'state-directory' },
  });
});
