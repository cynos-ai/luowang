import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  validateReliabilityProof,
  verifyReliabilityProofFiles,
} from './acceptance/run-reliability/contract.js';

const binding = {
  batchId: 'reliability',
  candidateCommit: 'a'.repeat(40),
  runtimeImage: `sha256:${'b'.repeat(64)}`,
  qualityImage: `sha256:${'c'.repeat(64)}`,
  checkerSha256: 'd'.repeat(64),
  roleHashes: { main: 'e'.repeat(64) },
  models: { main: 'text', runner: 'text', reviewer: 'vision' },
  instanceId: 'isolated-candidate',
};
const expected = {
  binding,
  caseId: 'queued-stop',
  projectId: '11111111-1111-4111-8111-111111111111',
  repository: 'cynos-ai/luowang-v070-release-fixture',
  queueId: 1,
  runId: null,
  targetCommit: null,
  configRevision: 1,
  configFingerprint: 'f'.repeat(64),
};
const proof = {
  ...expected,
  schema: 'luowang.run-reliability-live.v1',
  layer: 'live',
  status: 'passed',
  files: [
    { path: 'proof.txt', sha256: createHash('sha256').update('actual receipt').digest('hex') },
  ],
  queueResponse: {
    queue: [
      {
        queueId: 1,
        requestKind: 'manual-current-head',
        status: 'interrupted',
        runId: null,
        resolvedTargetCommit: null,
      },
    ],
  },
};

describe('run reliability exact candidate proof', () => {
  it('accepts scoped queue facts and rejects mismatched batch, candidate, project, configuration and fabricated Run', () => {
    expect(validateReliabilityProof(proof, expected).runId).toBe(null);
    for (const key of ['batchId', 'candidateCommit', 'runtimeImage', 'checkerSha256', 'instanceId'])
      expect(() =>
        validateReliabilityProof({ ...proof, binding: { ...binding, [key]: 'wrong' } }, expected),
      ).toThrow();
    for (const key of [
      'projectId',
      'queueId',
      'configRevision',
      'configFingerprint',
      'targetCommit',
    ])
      expect(() => validateReliabilityProof({ ...proof, [key]: 'wrong' }, expected)).toThrow();
    expect(() =>
      validateReliabilityProof({ ...proof, runResponse: { run: {} } }, expected),
    ).toThrow(/fabricate/);
    expect(() => validateReliabilityProof({ ...proof, layer: 'model-replay' }, expected)).toThrow();
    expect(() => validateReliabilityProof({ ...proof, files: [] }, expected)).toThrow();
  });
  it('requires present, matching evidence inside this proof directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reliability-proof-'));
    try {
      const validated = validateReliabilityProof(proof, expected);
      await expect(verifyReliabilityProofFiles(root, validated)).rejects.toThrow();
      await writeFile(join(root, 'proof.txt'), 'actual receipt');
      await verifyReliabilityProofFiles(root, validated);
      await writeFile(join(root, 'proof.txt'), 'changed');
      await expect(verifyReliabilityProofFiles(root, validated)).rejects.toThrow(/integrity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
