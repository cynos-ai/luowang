import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { parseLiveQueueResponse, parseLiveRunResponse } from '../live-contract.js';

const sha = Type.String({ pattern: '^[a-f0-9]{40}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const image = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const bindingSchema = Type.Object({
  batchId: Type.String({ minLength: 1 }),
  candidateCommit: sha,
  runtimeImage: image,
  qualityImage: image,
  checkerSha256: hash,
  roleHashes: Type.Record(Type.String(), hash),
  models: Type.Object({ main: Type.String(), runner: Type.String(), reviewer: Type.String() }),
  instanceId: Type.String({ minLength: 1 }),
});
export type ReliabilityBinding = Static<typeof bindingSchema>;
const proofSchema = Type.Object({
  schema: Type.Literal('luowang.run-reliability-live.v1'),
  binding: bindingSchema,
  caseId: Type.String({ minLength: 1 }),
  projectId: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
  repository: Type.Union([
    Type.Literal('cynos-ai/luowang-v070-release-fixture'),
    Type.Literal('cynos-ai/luowang-mp-python-fixture'),
  ]),
  queueId: Type.Integer({ minimum: 1 }),
  runId: Type.Union([Type.String({ pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' }), Type.Null()]),
  targetCommit: Type.Union([sha, Type.Null()]),
  configRevision: Type.Integer({ minimum: 1 }),
  configFingerprint: hash,
  files: Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), sha256: hash }), {
    minItems: 1,
  }),
  layer: Type.Literal('live'),
  status: Type.Union([
    Type.Literal('passed'),
    Type.Literal('failed'),
    Type.Literal('blocked'),
    Type.Literal('not_run'),
  ]),
  queueResponse: Type.Unknown(),
  runResponse: Type.Optional(Type.Unknown()),
});
export type ReliabilityProof = Static<typeof proofSchema>;

/** This batch requires exact bindings. Historical/cross-candidate evidence is never promoted. */
export function validateReliabilityProof(
  value: unknown,
  expected: {
    binding: ReliabilityBinding;
    caseId: string;
    projectId: string;
    repository: string;
    queueId: number;
    runId: string | null;
    targetCommit: string | null;
    configRevision: number;
    configFingerprint: string;
  },
): ReliabilityProof {
  if (!Check(proofSchema, value)) throw new Error('Reliability proof shape invalid');
  if (canonical(value.binding) !== canonical(expected.binding))
    throw new Error('Candidate/batch/checker/model binding mismatch');
  for (const key of [
    'caseId',
    'projectId',
    'repository',
    'queueId',
    'runId',
    'targetCommit',
    'configRevision',
    'configFingerprint',
  ] as const)
    if (value[key] !== expected[key]) throw new Error(`Proof ${key} mismatch`);
  if (Object.keys(value.binding.roleHashes).length === 0) throw new Error('Role hashes missing');
  const queues = parseLiveQueueResponse(value.queueResponse);
  const queue = queues.find((item) => item.queueId === value.queueId);
  if (
    !queue ||
    (queue.runId ?? null) !== value.runId ||
    (queue.resolvedTargetCommit ?? null) !== value.targetCommit
  )
    throw new Error('Queue facts mismatch');
  if (value.runId !== null) {
    const run = parseLiveRunResponse(value.runResponse);
    if (run.runId !== value.runId || run.targetCommit !== value.targetCommit)
      throw new Error('Run facts mismatch');
  } else if (value.runResponse !== undefined)
    throw new Error('Preparation-only proof cannot fabricate a Run');
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length)
    throw new Error('Duplicate evidence');
  return value;
}

export async function verifyReliabilityProofFiles(
  root: string,
  proof: ReliabilityProof,
): Promise<void> {
  const directory = await realpath(root);
  for (const file of proof.files) {
    const path = resolve(directory, file.path);
    const info = await lstat(path);
    const actual = await realpath(path);
    const within = relative(directory, actual);
    if (
      isAbsolute(file.path) ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      within === '..' ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    )
      throw new Error('Evidence path outside proof directory');
    if (
      createHash('sha256')
        .update(await readFile(actual))
        .digest('hex') !== file.sha256
    )
      throw new Error('Evidence integrity mismatch');
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      ),
    );
  return JSON.stringify(value);
}
