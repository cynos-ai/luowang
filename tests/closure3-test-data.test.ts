import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import {
  createReviewerTestDataTools,
  createTestDataManager,
  createTestDataTools,
  type TestDataEvidenceBoundary,
  type TestDataVerificationReceipt,
} from '../src/server/runs/test-data.js';

const RUN_ID = '01K00000000000000000000001';
const OTHER_RUN_ID = '01K00000000000000000000002';
const DATA_ID = `luowang-${RUN_ID}-user-1`;

describe('Closure 3 verified test data lifecycle', () => {
  it('captures a real allowlisted API response, redacts it, and requires Reviewer read before confirmation', async () => {
    let adapterCalls = 0;
    const manager = createTestDataManager({
      now: () => new Date('2026-09-01T03:00:00.000Z'),
      queryAdapters: [
        {
          id: 'users-api',
          kind: 'api-query',
          operations: { 'lookup-by-id': [] },
          query: async ({ runId, entry, operation, parameters }) => {
            adapterCalls += 1;
            assert.equal(runId, RUN_ID);
            assert.equal(entry.id, DATA_ID);
            assert.equal(operation, 'lookup-by-id');
            assert.deepEqual(parameters, {});
            return {
              absent: true,
              statusCode: 404,
              content: 'not found; token=adapter-secret-value; Authorization: Bearer hidden-value',
            };
          },
        },
      ],
    });
    const evidence = new MemoryEvidence();
    const runner = createTestDataTools(manager, RUN_ID, evidence);
    const reviewer = createReviewerTestDataTools(manager, RUN_ID, evidence);

    await invoke(runner, 'register_test_data', { id: DATA_ID, description: 'temporary user' });
    const captured = await invokeJson(runner, 'capture_test_data_cleanup_query', {
      dataId: DATA_ID,
      adapterId: 'users-api',
      operation: 'lookup-by-id',
      parameters: {},
      content: 'Agent supplied fake body',
      statusCode: 200,
      sha256: 'Agent supplied fake hash',
    });
    const evidenceId = captured.evidenceId as string;
    assert.equal(adapterCalls, 1);
    assert.match(evidenceId, /^controlled-1$/);
    assert.doesNotMatch(
      evidence.contents.get(evidenceId) ?? '',
      /adapter-secret-value|hidden-value/,
    );
    assert.doesNotMatch(evidence.contents.get(evidenceId) ?? '', /Agent supplied/);
    const receipt = captured.receipt as TestDataVerificationReceipt;
    assert.equal(receipt.sourceId, 'users-api');
    assert.equal(receipt.runId, RUN_ID);
    assert.equal(receipt.dataId, DATA_ID);
    assert.equal(receipt.statusCode, 404);
    assert.equal(receipt.queriedAt, '2026-09-01T03:00:00.000Z');
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);

    await invoke(runner, 'submit_test_data_cleanup_claim', {
      dataId: DATA_ID,
      evidenceIds: [evidenceId],
    });
    const pending = await invokeJson(reviewer, 'list_pending_test_data', {});
    assert.deepEqual(pending, [
      {
        id: DATA_ID,
        status: 'cleanup-claimed',
        evidenceIds: [evidenceId],
      },
    ]);
    const unread = await invokeJson(reviewer, 'verify_test_data_cleanup', {
      dataId: DATA_ID,
      decision: 'confirm',
    });
    assert.equal(unread.error, true);
    assert.match(readText(unread), /先读取/);

    await invoke(reviewer, 'read_test_data_cleanup_evidence', {
      dataId: DATA_ID,
      evidenceId,
    });
    const verified = await invokeJson(reviewer, 'verify_test_data_cleanup', {
      dataId: DATA_ID,
      decision: 'confirm',
    });
    assert.equal(verified.status, 'verified-cleaned');
    assert.equal(manager.finalize(RUN_ID).ok, true);
  });

  it('does not let Reviewer confirm a controlled query that says data still exists', async () => {
    const manager = createTestDataManager({
      queryAdapters: [
        {
          id: 'users-api',
          kind: 'api-query',
          operations: { lookup: [] },
          query: async () => ({ absent: false, statusCode: 200, content: 'record exists' }),
        },
      ],
    });
    const evidence = new MemoryEvidence();
    const runner = createTestDataTools(manager, RUN_ID, evidence);
    const reviewer = createReviewerTestDataTools(manager, RUN_ID, evidence);
    await invoke(runner, 'register_test_data', { id: DATA_ID });
    const captured = await invokeJson(runner, 'capture_test_data_cleanup_query', {
      dataId: DATA_ID,
      adapterId: 'users-api',
      operation: 'lookup',
    });
    const evidenceId = captured.evidenceId as string;
    await invoke(runner, 'submit_test_data_cleanup_claim', {
      dataId: DATA_ID,
      evidenceIds: [evidenceId],
    });
    await invoke(reviewer, 'read_test_data_cleanup_evidence', { dataId: DATA_ID, evidenceId });
    const result = await invokeJson(reviewer, 'verify_test_data_cleanup', {
      dataId: DATA_ID,
      decision: 'confirm',
    });
    assert.equal(result.error, true);
    assert.equal(manager.finalize(RUN_ID).ok, false);
  });

  it('records readonly-command provenance and rejects operations or parameters outside the adapter allowlist', async () => {
    const manager = createTestDataManager({
      queryAdapters: [
        {
          id: 'fixture-query',
          kind: 'readonly-command',
          operations: { lookup: ['scope'] },
          query: async () => ({ absent: true, exitCode: 0, content: 'record absent' }),
        },
      ],
    });
    await manager.register(RUN_ID, { id: DATA_ID });

    const captured = await manager.query(RUN_ID, DATA_ID, 'fixture-query', 'lookup', {
      scope: 'synthetic',
    });
    assert.equal(captured.receipt.sourceKind, 'readonly-command');
    assert.equal(captured.receipt.exitCode, 0);
    assert.equal(captured.receipt.statusCode, undefined);

    await assert.rejects(
      () => manager.query(RUN_ID, DATA_ID, 'fixture-query', 'echo', {}),
      /操作不在 allowlist/,
    );
    await assert.rejects(
      () =>
        manager.query(RUN_ID, DATA_ID, 'fixture-query', 'lookup', {
          path: '/arbitrary/path',
        }),
      /参数不在 allowlist/,
    );
    await assert.rejects(
      () => manager.query(RUN_ID, DATA_ID, 'unknown-adapter', 'lookup', {}),
      /适配器不在 allowlist/,
    );
  });

  it('accepts only current managed evidence and rejects unregistered or cross-data claims', async () => {
    const manager = createTestDataManager();
    const evidence = new MemoryEvidence();
    evidence.screenshots.add('cleanup-after.png');
    const tools = createTestDataTools(manager, RUN_ID, evidence);
    await invoke(tools, 'register_test_data', { id: DATA_ID });

    for (const evidenceId of ['../outside.png', 'https://example.test/evidence.png', 'notes.txt']) {
      const result = await invokeJson(tools, 'submit_test_data_cleanup_claim', {
        dataId: DATA_ID,
        evidenceIds: [evidenceId],
      });
      assert.equal(result.error, true, evidenceId);
    }
    const unknown = await invokeJson(tools, 'submit_test_data_cleanup_claim', {
      dataId: `luowang-${RUN_ID}-unknown`,
      evidenceIds: ['cleanup-after.png'],
    });
    assert.equal(unknown.error, true);

    await manager.register(OTHER_RUN_ID, { id: `luowang-${OTHER_RUN_ID}-other` });
    const crossRun = createTestDataTools(manager, OTHER_RUN_ID, new MemoryEvidence());
    const cross = await invokeJson(crossRun, 'submit_test_data_cleanup_claim', {
      dataId: `luowang-${OTHER_RUN_ID}-other`,
      evidenceIds: ['cleanup-after.png'],
    });
    assert.equal(cross.error, true);
    assert.equal(manager.pending(RUN_ID)[0]?.status, 'registered');
  });

  it('keeps pending and Reviewer-rejected records blocking with a redacted residual list', async () => {
    const manager = createTestDataManager();
    const evidence = new MemoryEvidence();
    evidence.screenshots.add('cleanup-after.png');
    const runner = createTestDataTools(manager, RUN_ID, evidence);
    const reviewer = createReviewerTestDataTools(manager, RUN_ID, evidence);
    await invoke(runner, 'register_test_data', { id: DATA_ID });
    await invoke(runner, 'submit_test_data_cleanup_claim', {
      dataId: DATA_ID,
      evidenceIds: ['cleanup-after.png'],
    });
    evidence.reviewed.add('cleanup-after.png');
    await invoke(reviewer, 'verify_test_data_cleanup', {
      dataId: DATA_ID,
      decision: 'reject',
      reason: '截图不足；password=should-not-remain',
    });

    const final = manager.finalize(RUN_ID);
    assert.equal(final.ok, false);
    assert.equal(final.pending[0]?.status, 'rejected');
    assert.doesNotMatch(final.pending[0]?.rejectionReason ?? '', /should-not-remain/);
    assert.match(final.pending[0]?.rejectionReason ?? '', /REDACTED/);
  });

  it('lets a trusted cleanup adapter mark only independently absent records verified', async () => {
    const manager = createTestDataManager({
      cleanupAdapter: {
        id: 'fixture-cleanup',
        cleanupAndVerify: async ({ entry }) => ({
          absent: entry.id.endsWith('gone'),
          statusCode: 200,
          content: entry.id.endsWith('gone') ? 'not found' : 'still present',
        }),
      },
    });
    const gone = `luowang-${RUN_ID}-gone`;
    const present = `luowang-${RUN_ID}-present`;
    await manager.register(RUN_ID, { id: gone });
    await manager.register(RUN_ID, { id: present });
    await manager.submitClaim(RUN_ID, present, ['cleanup-after.png']);

    const result = await manager.cleanup(RUN_ID);
    assert.equal(result.ok, false);
    assert.equal(result.attempted, 2);
    assert.deepEqual(result.failed, [present]);
    assert.equal(result.receipts.length, 2);
    assert.equal(
      manager
        .pending(RUN_ID)
        .map((entry) => entry.id)
        .join(','),
      present,
    );
    assert.equal(manager.pending(RUN_ID)[0]?.status, 'rejected');
    await assert.rejects(
      () => manager.verify(RUN_ID, present, 'confirm', undefined, () => true),
      /没有待审核/,
    );
    assert.equal(manager.finalize(RUN_ID).ok, false);
  });

  it('requires no adapter or Reviewer action for a zero-data Run', async () => {
    const manager = createTestDataManager();
    const cleanup = await manager.cleanup(RUN_ID);
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.attempted, 0);
    assert.equal(manager.finalize(RUN_ID).ok, true);
  });
});

class MemoryEvidence implements TestDataEvidenceBoundary {
  readonly contents = new Map<string, string>();
  readonly bindings = new Map<string, { runId: string; dataId: string }>();
  readonly screenshots = new Set<string>();
  readonly reviewed = new Set<string>();
  readonly absent = new Map<string, boolean>();

  async captureCleanupQuery(
    receipt: TestDataVerificationReceipt,
    redactedContent: string,
  ): Promise<string> {
    const id = `controlled-${this.contents.size + 1}`;
    this.contents.set(id, JSON.stringify({ provenance: receipt, redactedContent }));
    this.bindings.set(id, { runId: receipt.runId, dataId: receipt.dataId });
    this.absent.set(id, receipt.absent);
    return id;
  }

  async isCleanupClaimEvidence(
    evidenceId: string,
    runId: string,
    dataId: string,
  ): Promise<boolean> {
    const binding = this.bindings.get(evidenceId);
    if (binding) return binding.runId === runId && binding.dataId === dataId;
    return this.screenshots.has(evidenceId);
  }

  async readCleanupTextEvidence(
    evidenceId: string,
    runId: string,
    dataId: string,
  ): Promise<string> {
    const binding = this.bindings.get(evidenceId);
    if (!binding || binding.runId !== runId || binding.dataId !== dataId) {
      throw new Error('not controlled');
    }
    this.reviewed.add(evidenceId);
    return this.contents.get(evidenceId) ?? '';
  }

  isReviewedCleanupEvidence(evidenceId: string): boolean {
    return this.reviewed.has(evidenceId) && (this.absent.get(evidenceId) ?? true);
  }
}

async function invoke(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(
    'closure3-tool',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

async function invokeJson(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await invoke(tools, name, params);
  if (result.details.error === true) {
    return {
      error: true,
      text: result.content.map((item) => (item.type === 'text' ? item.text : '')).join(''),
    };
  }
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text) as Record<string, unknown>;
}

function readText(value: Record<string, unknown>): string {
  return String(value.text ?? '');
}
