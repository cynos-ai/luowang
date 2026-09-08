import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createTestDataManager, createTestDataTools } from '../src/server/runs/test-data.js';

const RUN = '01K00000000000000000000000';
const ID = `luowang-${RUN}-account`;

describe('Harness-owned test data teardown', () => {
  it('only exposes registration and observation, not cleanup claims or Reviewer confirmation', () => {
    const tools = createTestDataTools(createTestDataManager(), RUN);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['get_test_data_prefix', 'register_test_data', 'list_pending_test_data'],
    );
    assert.match(tools[0]!.description, /最终 Main 结束后/);
  });
  it('requires current Run ownership and makes registration idempotent without trusting status', async () => {
    const manager = createTestDataManager();
    await assert.rejects(manager.register(RUN, { id: 'other-account' }));
    await assert.rejects(manager.register(RUN, { id: `${ID}/../other` }));
    await manager.register(RUN, { id: ID });
    await manager.register(RUN, { id: ID });
    const entries = manager.pending(RUN);
    assert.equal(entries.length, 1);
    entries[0]!.status = 'verified-cleaned';
    assert.equal(manager.pending(RUN)[0]!.status, 'registered');
    assert.deepEqual(manager.pending('other-run'), []);
  });
  it('does not claim cleanup when an adapter is missing, but allows an empty scope', async () => {
    const manager = createTestDataManager();
    assert.equal((await manager.cleanup(RUN)).ok, true);
    await manager.register(RUN, { id: ID });
    const result = await manager.cleanup(RUN);
    assert.equal(result.ok, false);
    assert.equal(result.attempted, 0);
    assert.deepEqual(result.failed, [ID]);
    assert.equal(manager.finalize(RUN).ok, false);
    assert.doesNotMatch(result.message, /等待 Reviewer/);
  });
  it('only invokes a trusted adapter for registered current Run data and captures its result', async () => {
    const calls: string[] = [];
    const existing = new Set([ID]);
    const manager = createTestDataManager({
      cleanupAdapter: {
        id: 'isolated-fixture',
        async cleanupAndVerify({ runId, entry }) {
          assert.equal(runId, RUN);
          calls.push(entry.id);
          existing.delete(entry.id);
          return {
            absent: !existing.has(entry.id),
            exitCode: 0,
            content: 'absent; password=synthetic-secret',
          };
        },
      },
    });
    await manager.register(RUN, { id: ID });
    const result = await manager.cleanup(RUN);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [ID]);
    assert.equal(result.receipts[0]!.runId, RUN);
    assert.equal(result.receipts[0]!.dataId, ID);
    assert.equal(result.receipts[0]!.sourceKind, 'cleanup-adapter');
    assert.match(result.receipts[0]!.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(result.receipts[0]!.summary, /synthetic-secret/);
    assert.equal(manager.finalize(RUN).ok, true);
    assert.equal((await manager.cleanup(RUN)).attempted, 0);
  });
  it('keeps partial failures, exceptions and oversized observations unconfirmed without leaking errors', async () => {
    const manager = createTestDataManager({
      cleanupAdapter: {
        id: 'partial',
        async cleanupAndVerify({ entry }) {
          if (entry.id.endsWith('throw')) throw new Error('password=private-value');
          return {
            absent: entry.id.endsWith('large'),
            content: entry.id.endsWith('large') ? 'x'.repeat(256 * 1024 + 1) : 'still exists',
            exitCode: 0,
          };
        },
      },
    });
    for (const suffix of ['present', 'throw', 'large'])
      await manager.register(RUN, { id: `${ID}-${suffix}` });
    assert.equal((await manager.cleanup(RUN)).failed.length, 3);
    const final = manager.finalize(RUN);
    assert.equal(final.ok, false);
    assert.equal(final.pending.length, 3);
    assert.doesNotMatch(JSON.stringify(final), /private-value/);
  });
});
