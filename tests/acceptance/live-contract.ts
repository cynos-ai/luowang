import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const optionalText = Type.Optional(Type.String());
const nullableText = Type.Optional(Type.Union([Type.String(), Type.Null()]));

const queueSchema = Type.Object({
  queueId: Type.Integer(),
  requestKind: Type.String(),
  status: Type.String(),
  sourceRef: nullableText,
  preparedMergeMode: nullableText,
  preparedMergeCommit: nullableText,
  resolvedTargetCommit: nullableText,
  runId: nullableText,
  archiveStatus: nullableText,
  initialization: Type.Optional(Type.Boolean()),
});

const runSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  status: Type.String(),
  result: nullableText,
  request: optionalText,
  targetCommit: nullableText,
  initialization: Type.Optional(Type.Boolean()),
  evidence: Type.Optional(
    Type.Array(
      Type.Object({
        id: optionalText,
        filename: optionalText,
        url: optionalText,
        contentType: optionalText,
        sizeBytes: Type.Optional(Type.Number()),
        sha256: optionalText,
      }),
    ),
  ),
  scenarioProgress: Type.Optional(
    Type.Union([Type.Object({ completed: Type.Number(), total: Type.Number() }), Type.Null()]),
  ),
  activities: Type.Optional(
    Type.Array(
      Type.Object({
        at: optionalText,
        message: optionalText,
        kind: optionalText,
      }),
    ),
  ),
  blockingReasons: Type.Optional(Type.Array(Type.String())),
  scenarioPrUrl: nullableText,
  archive: Type.Optional(
    Type.Union([
      Type.Object({
        reportStatus: Type.String(),
        archiveStatus: Type.String(),
        progressed: Type.Boolean(),
        scenarioStatus: Type.String(),
      }),
      Type.Null(),
    ]),
  ),
  scenarioResults: Type.Optional(
    Type.Array(Type.Object({ id: optionalText, result: optionalText })),
  ),
  confirmedBugs: Type.Optional(
    Type.Array(
      Type.Object({
        key: optionalText,
        issueAction: optionalText,
        issueUrl: nullableText,
      }),
    ),
  ),
  issues: Type.Optional(
    Type.Array(
      Type.Object({
        status: optionalText,
        issueNumber: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        issueUrl: nullableText,
      }),
    ),
  ),
  artifacts: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type LiveQueueFact = Static<typeof queueSchema>;
export type LiveRunFact = Static<typeof runSchema>;

// These are API contracts, not copies of the flat SQLite StoredRun shape.
export function parseLiveQueueResponse(value: unknown): LiveQueueFact[] {
  const schema = Type.Object({ queue: Type.Array(queueSchema) });
  if (!Check(schema, value)) throw new Error('live queue API 响应格式错误');
  return value.queue;
}

export function parseLiveRunResponse(value: unknown): LiveRunFact {
  const schema = Type.Object({ run: runSchema });
  if (!Check(schema, value)) throw new Error('live Run API 响应格式错误');
  rejectFlatArchive(value.run);
  return value.run;
}

export function parseLiveRunsResponse(value: unknown): LiveRunFact[] {
  const schema = Type.Object({ runs: Type.Array(runSchema) });
  if (!Check(schema, value)) throw new Error('live runs API 响应格式错误');
  value.runs.forEach(rejectFlatArchive);
  return value.runs;
}

function rejectFlatArchive(run: LiveRunFact): void {
  if (['reportStatus', 'archiveStatus', 'scenarioStatus', 'progressed'].some((key) => key in run)) {
    throw new Error('live Run 归档字段必须位于 archive');
  }
}
