import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';

import {
  validateManifest,
  verifyEvidence,
  verifyRunFacts,
} from './acceptance/multi-project-live.js';

const runId = '01M3C8S9ZFZ6YGRGGVGRH2XRRQ';
const targetCommit = '4f870803f4a741af2966f43c7a4b30bda9e6790d';
const reportCommit = '0defd30be3761c7ad8ba66bfd96d65737f54245b';
const project = {
  projectId: '4b1cb89c-539c-4b1d-a197-688389e808c8',
  repository: 'cynos-ai/luowang-closure7-fixture',
  runs: [
    {
      queueId: 24,
      runId,
      targetCommit,
      reportCommit,
      result: 'passed' as const,
      scenarios: { 'AUTH-LOGIN-001': 'passed' as const },
      minScreenshots: 1,
      minCleanup: 1,
    },
  ],
};
const expectation = project.runs[0];
const content = '## Harness 清理收尾\n\n独立核验： account · source · now · absent=true';
const facts = {
  project,
  expectation,
  queue: {
    queueId: 24,
    runId,
    status: 'completed',
    archiveStatus: 'completed',
    resolvedTargetCommit: targetCommit,
  },
  run: {
    runId,
    targetCommit,
    status: 'completed',
    result: 'passed',
    archiveStatus: 'completed',
    reportStatus: 'published',
    reportCommitSha: reportCommit,
    scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
    evidence: [{ contentType: 'image/png' }],
  },
  report: {
    runId,
    targetCommit,
    result: 'passed',
    path: `docs/scenario-testing/reports/${runId}`,
    content,
    scenarioResults: [{ id: 'AUTH-LOGIN-001', result: 'passed' }],
  },
};

describe('multi-project live acceptance guards', () => {
  it('requires independent projects and rejects duplicate Run IDs', () => {
    assert.throws(() => validateManifest({ projects: [project] }), /at least two/);
    assert.throws(
      () =>
        validateManifest({
          projects: [
            project,
            {
              ...project,
              projectId: 'daf7e42d-20d7-453a-a26d-d2bab1c1f478',
              repository: 'cynos-ai/other',
            },
          ],
        }),
      /duplicate Run ID/,
    );
  });

  it('rejects wrong queue ownership, changed target and missing cleanup', () => {
    assert.equal(verifyRunFacts(facts).cleanupCount, 1);
    assert.throws(
      () => verifyRunFacts({ ...facts, queue: { ...facts.queue, runId: 'wrong' } }),
      /wrong queue ownership/,
    );
    assert.throws(
      () => verifyRunFacts({ ...facts, run: { ...facts.run, targetCommit: reportCommit } }),
      /Run target changed/,
    );
    assert.throws(
      () =>
        verifyRunFacts({
          ...facts,
          report: { ...facts.report, content: '## Harness 清理收尾\nnone' },
        }),
      /cleanup receipts missing/,
    );
  });

  it('rejects altered screenshot bytes', () => {
    const body = Buffer.from('image bytes');
    const evidence = {
      contentType: 'image/png',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    verifyEvidence(evidence, body);
    assert.throws(
      () => verifyEvidence(evidence, Buffer.from('wrong bytes')),
      /evidence hash differs/,
    );
  });
});
