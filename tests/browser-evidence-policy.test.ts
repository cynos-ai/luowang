import { strict as assert } from 'node:assert';
import { it } from 'vitest';
import {
  assertBrowserEvidenceCoverage,
  browserEvidencePolicy,
} from '../src/server/browser/evidence-policy.js';
import { createPlaywrightMcpAdapter } from '../src/server/browser/playwright-mcp.js';
import type { ConfigurationStore } from '../src/server/configuration.js';

it('rejects unmapped tools and keeps receipt-only evidence explicit', () => {
  assert.throws(
    () => assertBrowserEvidenceCoverage(['browser_future_tool']),
    /MCP_EVIDENCE_POLICY_MISSING/,
  );
  assert.equal(browserEvidencePolicy('toString'), undefined);
  assert.equal(browserEvidencePolicy('browser_evaluate'), undefined);
  assert.equal(browserEvidencePolicy('browser_click')!.capture, 'receipt');
  assert.equal(browserEvidencePolicy('browser_cookie_get')!.readTool, 'read_command_evidence');
  assert.equal(
    browserEvidencePolicy('browser_take_screenshot')!.artifactReader,
    'read_evidence_image',
  );
});

it('fails connection readiness on an unmapped visible tool while filtering excluded raw tools', async () => {
  const configuration = {
    getHarness: () => ({ mcp: { enabled: true, browser: 'chromium', timeoutMs: 1000 } }),
  } as ConfigurationStore;
  const names = [
    'browser_navigate',
    'browser_snapshot',
    'browser_take_screenshot',
    'browser_cookie_list',
    'browser_cookie_get',
    'browser_cookie_set',
    'browser_evaluate',
  ];
  const adapter = createPlaywrightMcpAdapter(configuration, {
    probe: async () => ({ toolNames: [...names] }),
  });
  assert.equal((await adapter.checkConnectivity()).status, 'ok');
  names.push('browser_future_tool');
  const failed = await adapter.checkConnectivity();
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /证据采集\/读取规则/);
});
