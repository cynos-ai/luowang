import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PUBLIC_QUALITY_SCRIPTS = [
  'format:check',
  'lint',
  'typecheck',
  'test',
  'build',
  'test:e2e',
] as const;

export const LIVE_INPUT_NAMES = [
  'LUOWANG_LIVE_REPOSITORY',
  'LUOWANG_LIVE_INITIAL_REF',
  'LUOWANG_LIVE_TARGET_ALLOWLIST',
  'LUOWANG_LIVE_GITHUB_TOKEN',
  'LUOWANG_ADMIN_PASSWORD',
  'LUOWANG_MASTER_KEY',
  'LUOWANG_LIVE_BASE_URL',
  'LUOWANG_LIVE_NON_PRODUCTION_CONFIRMED',
  'LUOWANG_LIVE_TEST_ACCOUNT_DEDICATED_CONFIRMED',
  'LUOWANG_LIVE_TEST_USERNAME',
  'LUOWANG_LIVE_TEST_PASSWORD',
  'LUOWANG_LIVE_PROVIDER',
  'LUOWANG_LIVE_PROVIDER_API_KEY',
  'LUOWANG_LIVE_MAIN_MODEL',
  'LUOWANG_LIVE_MAIN_THINKING',
  'LUOWANG_LIVE_RUNNER_MODEL',
  'LUOWANG_LIVE_RUNNER_THINKING',
  'LUOWANG_LIVE_REVIEWER_MODEL',
  'LUOWANG_LIVE_REVIEWER_THINKING',
  'LUOWANG_LIVE_REVIEWER_VISION_CONFIRMED',
  'LUOWANG_LIVE_OSS_ENDPOINT',
  'LUOWANG_LIVE_OSS_REGION',
  'LUOWANG_LIVE_OSS_BUCKET',
  'LUOWANG_LIVE_OSS_PREFIX',
  'LUOWANG_LIVE_OSS_ACCESS_KEY_ID',
  'LUOWANG_LIVE_OSS_ACCESS_KEY_SECRET',
  'LUOWANG_LIVE_OSS_PRIVATE_CONFIRMED',
  'LUOWANG_LIVE_PASSED_CASE',
  'LUOWANG_LIVE_FAILED_CASE_1',
  'LUOWANG_LIVE_FAILED_CASE_2',
  'LUOWANG_LIVE_BLOCKED_CASE',
  'LUOWANG_LIVE_RESET_PROCEDURE',
  'LUOWANG_LIVE_DELETION_PROCEDURE',
  'LUOWANG_LIVE_ABSENCE_VERIFICATION',
  'LUOWANG_LIVE_NETWORK_APPROVED',
  'LUOWANG_LIVE_COST_APPROVED',
  'LUOWANG_LIVE_RELEASE_AUTHORIZED',
  'LUOWANG_LIVE_CREDENTIAL_DISPOSITION',
] as const;

const LIVE_THINKING_INPUTS = new Set<string>([
  'LUOWANG_LIVE_MAIN_THINKING',
  'LUOWANG_LIVE_RUNNER_THINKING',
  'LUOWANG_LIVE_REVIEWER_THINKING',
]);
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const LIVE_TRUE_CONFIRMATIONS = new Set<string>([
  'LUOWANG_LIVE_NON_PRODUCTION_CONFIRMED',
  'LUOWANG_LIVE_TEST_ACCOUNT_DEDICATED_CONFIRMED',
  'LUOWANG_LIVE_REVIEWER_VISION_CONFIRMED',
  'LUOWANG_LIVE_OSS_PRIVATE_CONFIRMED',
  'LUOWANG_LIVE_NETWORK_APPROVED',
  'LUOWANG_LIVE_COST_APPROVED',
  'LUOWANG_LIVE_RELEASE_AUTHORIZED',
]);

type LayerStatus = 'passed' | 'failed' | 'blocked' | 'not_run';
type AcceptanceMode = 'local' | 'live' | 'release';

interface LayerResult {
  status: LayerStatus;
  message: string;
  missing?: string[];
}

interface CommandResult {
  command: string;
  status: 'passed' | 'failed';
  durationMs: number;
  summary: string;
}

export interface ClosureProofStatuses {
  doc: LayerStatus;
  instr01: LayerStatus;
  instr02: LayerStatus;
  instr03: LayerStatus;
  merge01: LayerStatus;
  target01: LayerStatus;
  merge02: LayerStatus;
  data01: LayerStatus;
  data02: LayerStatus;
  active01: LayerStatus;
  history01: LayerStatus;
  ordinaryPi: LayerStatus;
  directInitialization: LayerStatus;
  scenarioReview: LayerStatus;
  finalRevision: LayerStatus;
  invalidTool: LayerStatus;
  mergeConflict: LayerStatus;
  indexerRecovery: LayerStatus;
  archiveRetry: LayerStatus;
  processRestart: LayerStatus;
  queueRecovery: LayerStatus;
  publicQuality: LayerStatus;
  acceptanceLayering: LayerStatus;
  acMapping: LayerStatus;
}

interface AcceptanceReport {
  schema: 'luowang.production-acceptance.v1';
  mode: AcceptanceMode;
  startedAt: string;
  finishedAt: string;
  local: LayerResult;
  live: LayerResult;
  release: LayerResult;
  resourceChecks: Array<{
    id: string;
    status: LayerStatus;
    evidence: string[];
  }>;
  acEvidence: Array<{
    ac: string;
    status: LayerStatus;
    evidence: string[];
  }>;
  commands: CommandResult[];
  proofs: ClosureProofStatuses;
}

interface LiveQueueFact {
  queueId?: number;
  requestKind?: string;
  sourceRef?: string | null;
  preparedMergeMode?: string | null;
  preparedMergeCommit?: string | null;
  resolvedTargetCommit?: string | null;
  status?: string;
  runId?: string | null;
  archiveStatus?: string | null;
  initialization?: boolean;
}

interface LiveRunFact {
  runId?: string;
  status?: string;
  result?: string | null;
  request?: string;
  targetCommit?: string | null;
  initialization?: boolean;
  artifactNames?: string[];
  evidence?: Array<{
    id?: string;
    filename?: string;
    url?: string;
    contentType?: string;
    sizeBytes?: number;
    sha256?: string;
  }>;
  scenarioProgress?: { completed?: number; total?: number };
  activities?: Array<{ at?: string; message?: string; kind?: string }>;
  blockingReasons?: string[];
  scenarioPrUrl?: string | null;
  archive?: {
    reportStatus?: string;
    archiveStatus?: string;
    progressed?: boolean;
    scenarioStatus?: string;
    scenarioPrUrl?: string | null;
  };
  scenarioResults?: Array<{ id?: string; result?: string }>;
  confirmedBugs?: Array<{ key?: string; issueAction?: string; issueUrl?: string }>;
  issues?: Array<{ status?: string; issueNumber?: number; issueUrl?: string }>;
  artifacts?: Record<string, string>;
}

export interface LiveFactSelection {
  initializationRunId: string;
  passedRunId: string;
  failedRunId: string;
  blockedRunId: string;
  scenarioReviewRunId: string;
  currentHeadRetestRunId: string;
  progressRunId: string;
}

export function selectLiveFacts(queue: LiveQueueFact[], runs: LiveRunFact[]): LiveFactSelection {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const initializationQueue = queue.find(
    (item) =>
      item.requestKind === 'manual-merge-source' &&
      item.initialization === true &&
      item.preparedMergeMode === 'initial-create' &&
      isSha(item.preparedMergeCommit) &&
      item.preparedMergeCommit === item.resolvedTargetCommit &&
      item.status === 'completed' &&
      item.archiveStatus === 'completed' &&
      typeof item.runId === 'string',
  );
  const initializationRun = initializationQueue?.runId
    ? byId.get(initializationQueue.runId)
    : undefined;
  assertLive(
    initializationQueue &&
      initializationRun?.initialization === true &&
      initializationRun.targetCommit === initializationQueue.resolvedTargetCommit,
    '缺少首次 non-force 创建及唯一 initialization Run 事实',
  );
  assertLive(
    queue.filter((item) => item.runId === initializationQueue.runId).length === 1,
    '首次创建关联了非唯一 Run',
  );

  const passedRun = runs.find(
    (run) =>
      run.status === 'completed' &&
      run.result === 'passed' &&
      (run.scenarioProgress?.total ?? 0) > 0 &&
      run.scenarioProgress?.completed === run.scenarioProgress?.total &&
      run.evidence?.some((item) => item.contentType?.startsWith('image/')),
  );
  assertLive(passedRun?.runId, '缺少含 UI 截图的 passed Run');

  const failedRun = runs.find(
    (run) =>
      run.status === 'completed' &&
      run.result === 'failed' &&
      (run.confirmedBugs?.length ?? 0) >= 2 &&
      (run.issues?.filter((issue) => issue.status === 'succeeded' && issue.issueUrl).length ?? 0) >=
        2,
  );
  assertLive(failedRun?.runId, '缺少两个 confirmed Bugs/Issues 的 failed Run');

  const specialArtifacts = ['report.md', 'scenario-changes.patch'];
  const scenarioReviewRun = runs.find(
    (run) =>
      run.status === 'completed' &&
      run.result === 'blocked' &&
      sameValues([...(run.artifactNames ?? [])].sort(), specialArtifacts) &&
      run.archive?.reportStatus === 'not_applicable' &&
      run.archive?.archiveStatus === 'completed' &&
      run.archive?.scenarioStatus === 'pull_request' &&
      Boolean(run.scenarioPrUrl ?? run.archive?.scenarioPrUrl),
  );
  assertLive(scenarioReviewRun?.runId, '缺少三 Session 特殊场景 PR Run');

  const blockedCandidates = runs.filter(
    (run) =>
      run.status === 'completed' &&
      run.result === 'blocked' &&
      run.runId !== scenarioReviewRun.runId &&
      run.archive?.archiveStatus === 'completed' &&
      run.archive?.progressed === false &&
      (run.scenarioResults?.length ?? 0) > 0,
  );
  const blockedRun =
    blockedCandidates.find((run) => /环境.*(?:不可达|停止)/.test(run.request ?? '')) ??
    blockedCandidates[0];
  assertLive(blockedRun?.runId, '缺少依赖不可达且不推进的 blocked Run');

  const currentHeadRetestQueue = [...queue]
    .reverse()
    .find(
      (item) =>
        item.requestKind === 'manual-current-head' &&
        item.status === 'completed' &&
        item.archiveStatus === 'completed' &&
        typeof item.runId === 'string' &&
        byId.get(item.runId)?.result === 'passed',
    );
  assertLive(currentHeadRetestQueue?.runId, '缺少当前 HEAD 人工重测 passed Run');

  const progressRun = runs.find(
    (run) =>
      run.status === 'completed' &&
      run.result === 'passed' &&
      (run.scenarioProgress?.total ?? 0) > 0 &&
      run.scenarioProgress?.completed === run.scenarioProgress?.total &&
      run.activities?.some((activity) => activity.message?.startsWith('开始场景 ')) &&
      run.activities?.some((activity) => activity.message?.startsWith('完成场景 ')),
  );
  assertLive(progressRun?.runId, '缺少 Harness 实时场景开始/完成活动事实');

  return {
    initializationRunId: initializationRun.runId as string,
    passedRunId: passedRun.runId,
    failedRunId: failedRun.runId,
    blockedRunId: blockedRun.runId,
    scenarioReviewRunId: scenarioReviewRun.runId,
    currentHeadRetestRunId: currentHeadRetestQueue.runId,
    progressRunId: progressRun.runId,
  };
}

export function missingLiveInputs(environment: NodeJS.ProcessEnv): string[] {
  return LIVE_INPUT_NAMES.filter((name) => {
    const value = environment[name]?.trim();
    if (!value) return true;
    const normalized = value.toLocaleLowerCase();
    if (LIVE_TRUE_CONFIRMATIONS.has(name)) return normalized !== 'true';
    return LIVE_THINKING_INPUTS.has(name) && !VALID_THINKING_LEVELS.has(normalized);
  });
}

export function createLayeredReport(input: {
  mode: AcceptanceMode;
  startedAt: string;
  local: LayerResult;
  live: LayerResult;
  commands?: CommandResult[];
  proofs: ClosureProofStatuses;
  liveEvidence?: string[];
  releasePublished?: boolean;
}): AcceptanceReport {
  const releasePassed = input.local.status === 'passed' && input.live.status === 'passed';
  const piStatus = aggregateStatuses([
    input.proofs.instr01,
    input.proofs.instr02,
    input.proofs.ordinaryPi,
    input.proofs.directInitialization,
    input.proofs.scenarioReview,
    input.proofs.finalRevision,
    input.proofs.invalidTool,
  ]);
  const releaseStatus: LayerStatus = releasePassed
    ? 'passed'
    : input.local.status === 'failed' || input.live.status === 'failed'
      ? 'failed'
      : 'blocked';
  return {
    schema: 'luowang.production-acceptance.v1',
    mode: input.mode,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    local: input.local,
    live: input.live,
    release: {
      status: releaseStatus,
      message: releasePassed
        ? '公共质量、local 和 live 联合验收均通过。'
        : 'release 只有在 local 与 live 均 passed 时才能通过。',
    },
    resourceChecks: [
      {
        id: 'built-in-role-instruction-id-hash-isolation',
        status: aggregateStatuses([
          input.proofs.instr01,
          input.proofs.instr02,
          input.proofs.instr03,
        ]),
        evidence: [
          'tests/closure1-role-instructions.test.ts',
          'tests/closure6-production-pi.test.ts: integrated Session metadata assertions',
        ],
      },
      {
        id: 'pi-sdk-ordinary-four-session',
        status: input.proofs.ordinaryPi,
        evidence: ['tests/closure6-production-pi.test.ts: ordinary production Pi Run'],
      },
      {
        id: 'fifo-first-branch-six-session-pi-initialization',
        status: input.proofs.directInitialization,
        evidence: [
          'tests/closure6-production-pi.test.ts: manual-merge-source → FIFO → initial-create → resolved target → one six-Session Pi Run',
        ],
      },
      {
        id: 'scenario-review-three-session-special-finalize',
        status: input.proofs.scenarioReview,
        evidence: ['tests/closure6-production-pi.test.ts: review-required initialization'],
      },
      {
        id: 'final-revision-without-rerun',
        status: input.proofs.finalRevision,
        evidence: ['tests/closure6-production-pi.test.ts: final patch revision'],
      },
      {
        id: 'invalid-tool-fail-closed',
        status: input.proofs.invalidTool,
        evidence: ['tests/closure6-production-pi.test.ts: invalid tool request'],
      },
      {
        id: 'merge-conflict-cleanup',
        status: input.proofs.mergeConflict,
        evidence: ['tests/phase2.test.ts: conflicted merge cleanup'],
      },
      {
        id: 'indexer-atomic-recovery',
        status: input.proofs.indexerRecovery,
        evidence: ['tests/phase2.test.ts: valid cache retained on invalid input'],
      },
      {
        id: 'archive-retry',
        status: input.proofs.archiveRetry,
        evidence: ['tests/phase5.test.ts: failed Issue item retry'],
      },
      {
        id: 'process-restart-recovery',
        status: input.proofs.processRestart,
        evidence: ['tests/phase6.test.ts: orphaned Run becomes interrupted'],
      },
      {
        id: 'fifo-queue-recovery',
        status: input.proofs.queueRecovery,
        evidence: ['tests/phase6.test.ts: queued/running/waiting archive restart recovery'],
      },
      {
        id: 'live-external-resources',
        status: input.live.status,
        evidence:
          input.liveEvidence && input.liveEvidence.length > 0
            ? input.liveEvidence
            : ['Closure 7 live runner and operator-provided resources'],
      },
    ],
    acEvidence: [
      {
        ac: 'AC-CLOSURE-DOC-01',
        status: input.proofs.doc,
        evidence: ['README.md', 'tests/closure6-acceptance-layering.test.ts: documentation'],
      },
      {
        ac: 'AC-CLOSURE-INSTR-01',
        status: input.proofs.instr01,
        evidence: ['tests/closure1-role-instructions.test.ts: allowlist and ambient isolation'],
      },
      {
        ac: 'AC-CLOSURE-INSTR-02',
        status: input.proofs.instr02,
        evidence: [
          'tests/closure6-production-pi.test.ts: integrated Session metadata and prompt layering',
        ],
      },
      {
        ac: 'AC-CLOSURE-INSTR-03',
        status: input.proofs.instr03,
        evidence: ['resources/agent-roles/*.md', 'tests/closure1-role-instructions.test.ts'],
      },
      {
        ac: 'AC-CLOSURE-MERGE-01',
        status: input.proofs.merge01,
        evidence: ['tests/closure2-merge-queue.test.ts: FIFO prepared merge publication'],
      },
      {
        ac: 'AC-CLOSURE-TARGET-01',
        status: input.proofs.target01,
        evidence: ['tests/closure2-merge-queue.test.ts: fixed remote scenario target'],
      },
      {
        ac: 'AC-CLOSURE-MERGE-02',
        status: input.proofs.merge02,
        evidence: ['tests/closure2-merge-queue.test.ts: crash and Git ref recovery'],
      },
      {
        ac: 'AC-CLOSURE-DATA-01',
        status: input.proofs.data01,
        evidence: ['tests/closure3-test-data.test.ts: controlled cleanup verification'],
      },
      {
        ac: 'AC-CLOSURE-DATA-02',
        status: input.proofs.data02,
        evidence: ['tests/closure3-test-data.test.ts: rejected and pending cleanup boundaries'],
      },
      {
        ac: 'AC-CLOSURE-ACTIVE-01',
        status: input.proofs.active01,
        evidence: ['tests/closure4-progress.test.ts'],
      },
      {
        ac: 'AC-CLOSURE-HISTORY-01',
        status: input.proofs.history01,
        evidence: ['tests/closure5-history.test.ts'],
      },
      {
        ac: 'AC-CLOSURE-PI-01',
        status: piStatus,
        evidence: [
          'tests/closure6-production-pi.test.ts',
          'tests/acceptance/local-model-protocol.ts',
          'src/server/runs/agent-session.ts:createPiAgentSessionFactory',
        ],
      },
      {
        ac: 'AC-CLOSURE-ACCEPT-01',
        status: aggregateStatuses([input.proofs.publicQuality, input.proofs.acceptanceLayering]),
        evidence: [
          'package.json:test:acceptance:local/live/release',
          'tests/closure6-acceptance-layering.test.ts',
          ...PUBLIC_QUALITY_SCRIPTS.map((script) => `npm run ${script}`),
        ],
      },
      {
        ac: 'AC-CLOSURE-ACCEPT-02',
        status: input.proofs.acMapping,
        evidence: [
          'report.resourceChecks[] contains behavior-specific evidence',
          'report.acEvidence[] contains one entry per Closure AC',
        ],
      },
      {
        ac: 'AC-CLOSURE-LIVE-01',
        status: input.live.status,
        evidence: input.liveEvidence ?? ['Closure 7 live resources not yet verified'],
      },
      {
        ac: 'AC-CLOSURE-LIVE-02',
        status: input.live.status,
        evidence: input.liveEvidence ?? ['Closure 7 live lifecycle not yet verified'],
      },
      {
        ac: 'AC-CLOSURE-SECRET-01',
        status: input.live.status,
        evidence:
          input.live.status === 'passed'
            ? ['Live API, Run artifacts, GitHub PR and Issue payload secret scan: no match']
            : ['Live secret boundary not yet fully verified'],
      },
      {
        ac: 'AC-CLOSURE-RELEASE-01',
        status: releasePassed && input.releasePublished === true ? 'passed' : 'blocked',
        evidence:
          releasePassed && input.releasePublished === true
            ? ['Immutable SemVer tag, main and release commit verified after publication']
            : [
                'Pre-release gate requires local.status=passed and live.status=passed',
                'Set LUOWANG_LIVE_RELEASE_TAG and rerun after publication to verify immutable tag and main',
              ],
      },
    ],
    commands: input.commands ?? [],
    proofs: input.proofs,
  };
}

function aggregateStatuses(statuses: LayerStatus[]): LayerStatus {
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  return 'not_run';
}

function assertLive(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('live API 返回了无效对象');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('live API 返回了无效数组');
  return value;
}

function requiredLiveValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`live 输入缺少 ${name}`);
  return value;
}

export function parseHarnessUrl(value: string, allowlist: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LUOWANG_LIVE_HARNESS_URL 不是有效 URL');
  }
  assertLive(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    '候选实例 URL 不能包含凭据、路径、查询或 fragment',
  );
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:') {
    assertLive(loopback && url.port === '3000', 'HTTP 候选实例只允许 loopback:3000');
  } else {
    assertLive(
      url.protocol === 'https:' && (url.port === '' || url.port === '443'),
      '远程候选实例必须使用标准端口 HTTPS',
    );
    const approvedOrigins = allowlist
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        try {
          return new URL(item).origin;
        } catch {
          return '';
        }
      });
    assertLive(approvedOrigins.includes(url.origin), '远程候选实例 origin 未进入明确 allowlist');
  }
  return url.origin;
}

export function parseGitHubRepository(value: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LUOWANG_LIVE_REPOSITORY 不是有效 URL');
  }
  assertLive(
    url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname),
    'live runner 仅接受规范 https://github.com/owner/repository[.git] URL',
  );
  const parts = url.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  return { owner: parts[0] as string, name: parts[1] as string };
}

export function isNewSemVerTag(value: string): boolean {
  const match = value.match(
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match || match[4]) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  const baseline = [0, 1, 0];
  for (let index = 0; index < version.length; index += 1) {
    if ((version[index] ?? 0) > (baseline[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (baseline[index] ?? 0)) return false;
  }
  return false;
}

function repoPathFor(owner: string, name: string): string {
  return `/repos/${owner}/${name}`;
}

async function peelGitHubTag(
  github: (path: string) => Promise<Record<string, unknown>>,
  owner: string,
  name: string,
  ref: Record<string, unknown>,
): Promise<string> {
  const object = asRecord(ref.object);
  assertLive(isSha(object.sha), 'GitHub tag ref 缺少有效 SHA');
  if (object.type === 'commit') return object.sha;
  assertLive(object.type === 'tag', 'GitHub tag ref object 类型无效');
  const tag = await github(`${repoPathFor(owner, name)}/git/tags/${object.sha}`);
  const target = asRecord(tag.object);
  assertLive(target.type === 'commit' && isSha(target.sha), 'annotated tag 未指向 commit');
  return target.sha;
}

function parseGitHubNumber(
  value: string | null | undefined,
  repository: { owner: string; name: string },
  kind: 'pull' | 'issues',
): number {
  assertLive(value, `GitHub ${kind} URL 缺失`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GitHub ${kind} URL 无效`);
  }
  const pattern = new RegExp(
    `^/${escapeRegExp(repository.owner)}/${escapeRegExp(repository.name)}/${kind}/(\\d+)$`,
  );
  const match = url.pathname.match(pattern);
  assertLive(
    url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match,
    `GitHub ${kind} URL 不属于目标仓库`,
  );
  return Number(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyProofStatuses(status: LayerStatus): ClosureProofStatuses {
  return {
    doc: status,
    instr01: status,
    instr02: status,
    instr03: status,
    merge01: status,
    target01: status,
    merge02: status,
    data01: status,
    data02: status,
    active01: status,
    history01: status,
    ordinaryPi: status,
    directInitialization: status,
    scenarioReview: status,
    finalRevision: status,
    invalidTool: status,
    mergeConflict: status,
    indexerRecovery: status,
    archiveRetry: status,
    processRestart: status,
    queueRecovery: status,
    publicQuality: status,
    acceptanceLayering: status,
    acMapping: status,
  };
}

async function runLocal(artifactDirectory: string): Promise<AcceptanceReport> {
  const startedAt = new Date().toISOString();
  const phase9Directory = join(artifactDirectory, 'phase9-local');
  await mkdir(phase9Directory, { recursive: true });
  await mkdir(join(phase9Directory, 'isolated-home'), { recursive: true });
  const environment = localOnlyEnvironment(phase9Directory);
  const commands: CommandResult[] = [];
  const proofs = emptyProofStatuses('not_run');
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    for (const script of PUBLIC_QUALITY_SCRIPTS) {
      const quality = await runAcceptanceCommand(
        `npm run ${script}`,
        [npmCli, 'run', script],
        environment,
      );
      commands.push(quality.command);
    }
  } else {
    commands.push({
      command: 'public quality commands',
      status: 'failed',
      durationMs: 0,
      summary: 'npm_execpath is unavailable; public quality commands were not run.',
    });
  }
  proofs.publicQuality = commands.every((command) => command.status === 'passed')
    ? 'passed'
    : 'failed';
  const phase9 = await runAcceptanceCommand(
    'tsx tests/acceptance/phase9.ts',
    ['--import', 'tsx', 'tests/acceptance/phase9.ts'],
    environment,
    async () => {
      const report = JSON.parse(await readFile(join(phase9Directory, 'report.json'), 'utf8')) as {
        status?: unknown;
      };
      if (report.status !== 'passed') throw new Error('Phase 9 local report 未通过');
    },
  );
  commands.push(phase9.command);
  const definitions: Array<{
    key: keyof ClosureProofStatuses;
    label: string;
    file: string;
    pattern: string;
    requires?: string[];
  }> = [
    {
      key: 'doc',
      label: 'AC-CLOSURE-DOC-01 truthful Docker and acceptance documentation',
      file: 'tests/closure6-acceptance-layering.test.ts',
      pattern: 'documents Docker priority',
    },
    {
      key: 'instr01',
      label: 'AC-CLOSURE-INSTR-01 fixed role allowlist and ambient isolation',
      file: 'tests/closure1-role-instructions.test.ts',
      pattern: 'loads only|ignores ambient|fails closed',
    },
    {
      key: 'instr02',
      label: 'AC-CLOSURE-INSTR-02 prompt and tool isolation in production Pi',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'ordinary four-session|unfamiliar-project direct initialization',
      requires: ['tests/closure1-role-instructions.test.ts'],
    },
    {
      key: 'instr03',
      label: 'AC-CLOSURE-INSTR-03 role method content boundaries',
      file: 'tests/closure6-acceptance-layering.test.ts',
      pattern: 'validates integrated role instruction method content',
      requires: ['resources/agent-roles/common.md'],
    },
    {
      key: 'merge01',
      label: 'AC-CLOSURE-MERGE-01 prepared FIFO merge publication',
      file: 'tests/closure2-merge-queue.test.ts',
      pattern: 'creates a missing scenario branch|prepares and recovers|uses one FIFO',
    },
    {
      key: 'target01',
      label: 'AC-CLOSURE-TARGET-01 fixed remote scenario target',
      file: 'tests/closure2-merge-queue.test.ts',
      pattern: 'keeps only automatic|creates no Run|uses one FIFO',
    },
    {
      key: 'merge02',
      label: 'AC-CLOSURE-MERGE-02 crash and internal ref recovery',
      file: 'tests/closure2-merge-queue.test.ts',
      pattern:
        'does not regenerate|recovers push-before|keeps an already resolved|start-before-link|crash-gap',
    },
    {
      key: 'data01',
      label: 'AC-CLOSURE-DATA-01 controlled cleanup verification',
      file: 'tests/closure3-test-data.test.ts',
      pattern: 'captures a real|trusted cleanup adapter|zero-data Run',
    },
    {
      key: 'data02',
      label: 'AC-CLOSURE-DATA-02 rejected and pending cleanup boundaries',
      file: 'tests/closure3-test-data.test.ts',
      pattern: 'still exists|rejects operations|pending and Reviewer-rejected',
    },
    {
      key: 'active01',
      label: 'AC-CLOSURE-ACTIVE-01 live scenario progress',
      file: 'tests/closure4-progress.test.ts',
      pattern: 'updates current|rejects undeclared|explicit 0/0|preserves the last|caps activities',
    },
    {
      key: 'history01',
      label: 'AC-CLOSURE-HISTORY-01 bounded history queries',
      file: 'tests/closure5-history.test.ts',
      pattern: 'queries completed|matches Issue|enforces read-before|distinguishes successful',
    },
    {
      key: 'ordinaryPi',
      label: 'Pi ordinary four-session Run',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'ordinary four-session',
    },
    {
      key: 'directInitialization',
      label: 'FIFO first-branch six-session Pi initialization',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'creates the first scenario branch through FIFO',
    },
    {
      key: 'scenarioReview',
      label: 'Pi three-session scenario review and Archiver PR',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'review-required initialization',
    },
    {
      key: 'finalRevision',
      label: 'Pi final revision without rerun',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'finalization revisions',
    },
    {
      key: 'invalidTool',
      label: 'Pi invalid tool fail-closed',
      file: 'tests/closure6-production-pi.test.ts',
      pattern: 'outside the production allowlist',
    },
    {
      key: 'mergeConflict',
      label: 'merge conflict cleanup',
      file: 'tests/phase2.test.ts',
      pattern: 'conflicted merge',
    },
    {
      key: 'indexerRecovery',
      label: 'Indexer atomic cache recovery',
      file: 'tests/phase2.test.ts',
      pattern: 'atomically indexes valid scenes',
    },
    {
      key: 'archiveRetry',
      label: 'archive failed-item retry',
      file: 'tests/phase5.test.ts',
      pattern: 'creates multiple confirmed Bug Issues',
    },
    {
      key: 'processRestart',
      label: 'orphaned Run restart recovery',
      file: 'tests/phase6.test.ts',
      pattern: 'orphaned running directory',
    },
    {
      key: 'queueRecovery',
      label: 'FIFO queue process restart recovery',
      file: 'tests/phase6.test.ts',
      pattern: 'recovers queued, running and waiting-archive',
    },
    {
      key: 'acceptanceLayering',
      label: 'AC-CLOSURE-ACCEPT-01 command and status layering',
      file: 'tests/closure6-acceptance-layering.test.ts',
      pattern: 'lists every|builds local|redacts credential|keeps release blocked|exposes separate',
    },
    {
      key: 'acMapping',
      label: 'AC-CLOSURE-ACCEPT-02 independent status mapping',
      file: 'tests/closure6-acceptance-layering.test.ts',
      pattern: 'derives each AC status',
    },
  ];
  for (const definition of definitions) {
    const requiredPaths = [definition.file, ...(definition.requires ?? [])];
    const available = await Promise.all(
      requiredPaths.map((path) =>
        access(join(process.cwd(), path)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (available.some((item) => !item)) {
      proofs[definition.key] = 'blocked';
      commands.push({
        command: `vitest: ${definition.label}`,
        status: 'failed',
        durationMs: 0,
        summary:
          'Required Closure proof is not present on this standalone branch; deferred to aggregate validation.',
      });
      continue;
    }
    const proof = await runAcceptanceCommand(
      `vitest: ${definition.label}`,
      [
        join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        definition.file,
        '-t',
        definition.pattern,
      ],
      environment,
    );
    proofs[definition.key] = proof.status;
    commands.push(proof.command);
  }
  const passed =
    phase9.status === 'passed' && Object.values(proofs).every((status) => status === 'passed');
  const local: LayerResult = passed
    ? {
        status: 'passed',
        message: '本地质量、fixture、真实 Pi SDK Session 和逐 AC 专项证明通过。',
      }
    : {
        status: 'failed',
        message: '一个或多个 local 质量或逐 AC 专项证明失败。',
      };
  return createLayeredReport({
    mode: 'local',
    startedAt,
    local,
    live: {
      status: 'blocked',
      message: 'local 命令不会读取或运行真实 GitHub、Provider、MCP、OSS 和测试账号。',
      missing: missingLiveInputs(process.env),
    },
    commands,
    proofs,
  });
}

async function runLive(): Promise<AcceptanceReport> {
  const startedAt = new Date().toISOString();
  const missing = missingLiveInputs(process.env);
  if (missing.length > 0) {
    return createLayeredReport({
      mode: 'live',
      startedAt,
      local: { status: 'not_run', message: 'live 命令不把未运行的 local 写成 passed。' },
      live: {
        status: 'blocked',
        message: `live 输入不完整；缺少 ${missing.length} 项。`,
        missing,
      },
      proofs: emptyProofStatuses('not_run'),
    });
  }

  const commandStartedAt = Date.now();
  try {
    const evidence = await validateCompletedLiveAcceptance(process.env);
    return createLayeredReport({
      mode: 'live',
      startedAt,
      local: { status: 'not_run', message: 'live 命令不把未运行的 local 写成 passed。' },
      live: {
        status: 'passed',
        message:
          '真实 GitHub、Provider、Pi、Playwright MCP、私有 OSS 和非生产应用联合事实均已复核。',
      },
      commands: [
        {
          command: 'Closure 7 completed live acceptance verification',
          status: 'passed',
          durationMs: Date.now() - commandStartedAt,
          summary: `Verified ${evidence.length} redacted live evidence facts.`,
        },
      ],
      proofs: emptyProofStatuses('not_run'),
      liveEvidence: evidence,
      releasePublished: evidence.some((item) => item.startsWith('release tag ')),
    });
  } catch (error) {
    return createLayeredReport({
      mode: 'live',
      startedAt,
      local: { status: 'not_run', message: 'live 命令不把未运行的 local 写成 passed。' },
      live: {
        status: 'failed',
        message: `live 联合事实复核失败：${safeError(error)}`,
      },
      commands: [
        {
          command: 'Closure 7 completed live acceptance verification',
          status: 'failed',
          durationMs: Date.now() - commandStartedAt,
          summary: safeError(error),
        },
      ],
      proofs: emptyProofStatuses('not_run'),
    });
  }
}

async function validateCompletedLiveAcceptance(environment: NodeJS.ProcessEnv): Promise<string[]> {
  const harnessUrl = parseHarnessUrl(
    environment.LUOWANG_LIVE_HARNESS_URL ?? 'http://127.0.0.1:3000',
    requiredLiveValue(environment, 'LUOWANG_LIVE_TARGET_ALLOWLIST'),
  );
  const adminPassword = requiredLiveValue(environment, 'LUOWANG_ADMIN_PASSWORD');
  let cookie = '';
  const harness = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetch(`${harnessUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`候选实例 ${path} 返回 HTTP ${response.status}`);
    return response.json();
  };
  const loginResponse = await fetch(`${harnessUrl}/api/auth/login`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  if (!loginResponse.ok) throw new Error(`候选实例认证返回 HTTP ${loginResponse.status}`);
  cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assertLive(cookie !== '', '候选实例认证未返回 Session Cookie');

  const connectivityIds = [
    'test-environment-url',
    'github-repository-read',
    'provider-model',
    'playwright-mcp',
    'oss',
  ];
  const connectivity: Record<string, unknown>[] = [];
  for (const id of connectivityIds) {
    const response = asRecord(
      await harness(`/api/connectivity/checks/${id}`, { method: 'POST', body: '{}' }),
    );
    const result = asRecord(response.result);
    assertLive(result.status === 'ok', `${id} connectivity 不是 ok`);
    connectivity.push(response);
  }

  const queueResponse = asRecord(await harness('/api/queue'));
  const runsResponse = asRecord(await harness('/api/runs'));
  const queue = asArray(queueResponse.queue) as LiveQueueFact[];
  const runs = asArray(runsResponse.runs) as LiveRunFact[];
  const selection = selectLiveFacts(queue, runs);
  const selectedIds = [...new Set(Object.values(selection))];
  const details: LiveRunFact[] = [];
  for (const runId of selectedIds) {
    const response = asRecord(await harness(`/api/runs/${encodeURIComponent(runId)}`));
    details.push(asRecord(response.run) as LiveRunFact);
  }
  const detailById = new Map(details.map((run) => [run.runId, run]));
  const passed = detailById.get(selection.passedRunId);
  const failed = detailById.get(selection.failedRunId);
  const blocked = detailById.get(selection.blockedRunId);
  const scenarioReview = detailById.get(selection.scenarioReviewRunId);
  assertLive(passed && failed && blocked && scenarioReview, '无法读取一个或多个权威 Run 明细');
  assertLive(
    passed.artifacts?.['review.md']?.includes('verified-cleaned') === true,
    'passed Run 缺少 Reviewer verified-cleaned 事实',
  );
  const bugKeys = failed.confirmedBugs?.map((bug) => bug.key).filter(Boolean) ?? [];
  const succeededIssues = failed.issues?.filter(
    (issue) => issue.status === 'succeeded' && issue.issueUrl && issue.issueNumber,
  );
  assertLive(
    failed.confirmedBugs?.length === 2 &&
      bugKeys.length === 2 &&
      new Set(bugKeys).size === 2 &&
      succeededIssues?.length === 2 &&
      new Set(succeededIssues.map((issue) => issue.issueUrl)).size === 2 &&
      new Set(succeededIssues.map((issue) => issue.issueNumber)).size === 2,
    'failed Run 未形成两个相互独立的 confirmed Bugs/Issues',
  );
  assertLive(
    blocked.archive?.progressed === false && (blocked.blockingReasons?.length ?? 0) > 0,
    'blocked Run 没有保持不推进事实',
  );
  assertLive(scenarioReview.artifactNames?.length === 2, '场景 PR 特殊 Run 未保持两文件契约');

  const image = passed.evidence?.find(
    (item) => item.contentType?.startsWith('image/') && item.url && (item.sizeBytes ?? 0) > 0,
  );
  assertLive(image?.url, 'passed Run 缺少可读取的私有截图 URL');
  const imageResponse = await fetch(`${harnessUrl}${image.url}`, {
    headers: { cookie },
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  assertLive(imageResponse.ok, `私有 screenshot Gateway 返回 HTTP ${imageResponse.status}`);
  const imageBody = Buffer.from(await imageResponse.arrayBuffer());
  assertLive(
    imageResponse.headers.get('content-type')?.startsWith('image/') &&
      imageBody.byteLength === image.sizeBytes,
    '私有 screenshot Gateway 内容类型或大小不匹配',
  );

  const indexedReports: Record<string, unknown>[] = [];
  for (const runId of [
    selection.initializationRunId,
    selection.passedRunId,
    selection.failedRunId,
    selection.blockedRunId,
    selection.currentHeadRetestRunId,
  ]) {
    const response = asRecord(await harness(`/api/reports/${encodeURIComponent(runId)}`));
    const report = asRecord(response.report);
    assertLive(report.runId === runId, `Indexer 未回读 Run ${runId}`);
    indexedReports.push(report);
  }
  const scenarioResponse = asRecord(await harness('/api/scenarios/AUTH-REGISTRATION-002'));
  assertLive(
    asRecord(scenarioResponse.scenario).id === 'AUTH-REGISTRATION-002',
    'Indexer 未回读场景 PR 资产',
  );
  const dashboardResponse = asRecord(await harness('/api/dashboard'));
  const branch = asRecord(dashboardResponse.branch);
  assertLive(
    isSha(branch.head) && branch.head === branch.indexedCommit,
    '场景分支 HEAD 与 Indexer commit 不一致',
  );

  const repository = parseGitHubRepository(
    requiredLiveValue(environment, 'LUOWANG_LIVE_REPOSITORY'),
  );
  const token = requiredLiveValue(environment, 'LUOWANG_LIVE_GITHUB_TOKEN');
  const githubPayloads: unknown[] = [];
  const github = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'luowang-closure-live-acceptance',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`GitHub 验证返回 HTTP ${response.status}`);
    const body = asRecord(await response.json());
    githubPayloads.push(body);
    return body;
  };
  const repoPath = `/repos/${repository.owner}/${repository.name}`;
  const scenarioBranch = await github(`${repoPath}/git/ref/heads/scenario-testing`);
  assertLive(
    asRecord(scenarioBranch.object).sha === branch.head,
    'GitHub scenario-testing HEAD 与候选实例不一致',
  );
  const initializationQueue = queue.find(
    (item) => item.runId === selection.initializationRunId,
  ) as LiveQueueFact;
  const sourceRef = requiredLiveValue(environment, 'LUOWANG_LIVE_INITIAL_REF');
  const initialCommit = await github(`${repoPath}/commits/${encodeURIComponent(sourceRef)}`);
  assertLive(
    initialCommit.sha === initializationQueue.preparedMergeCommit,
    '首次创建 branch/tag/SHA source 与 prepared commit 不一致',
  );
  const compare = await github(
    `${repoPath}/compare/${initializationQueue.preparedMergeCommit}...${branch.head as string}`,
  );
  assertLive(
    compare.status === 'ahead' || compare.status === 'identical',
    '当前 scenario-testing 未包含首次创建 commit',
  );

  const scenarioPrUrl = scenarioReview.scenarioPrUrl ?? scenarioReview.archive?.scenarioPrUrl;
  const scenarioPrNumber = parseGitHubNumber(scenarioPrUrl, repository, 'pull');
  const scenarioPr = await github(`${repoPath}/pulls/${scenarioPrNumber}`);
  assertLive(
    scenarioPr.base && asRecord(scenarioPr.base).ref === 'scenario-testing',
    '场景 PR base 不是 scenario-testing',
  );
  assertLive(
    scenarioPr.merged === true && scenarioPr.merged_at && isSha(scenarioPr.merge_commit_sha),
    '场景 PR 尚未真实合并',
  );
  const retestRun = detailById.get(selection.currentHeadRetestRunId);
  assertLive(isSha(retestRun?.targetCommit), '当前 HEAD 重测缺少固定 target commit');
  const retestCompare = await github(
    `${repoPath}/compare/${scenarioPr.merge_commit_sha}...${retestRun.targetCommit}`,
  );
  assertLive(
    retestCompare.status === 'ahead' || retestCompare.status === 'identical',
    '当前 HEAD passed 重测 target 不包含场景 PR merge commit',
  );
  const verifiedIssueNumbers: number[] = [];
  for (const issue of failed.issues ?? []) {
    assertLive(issue.issueUrl, 'failed Run Issue URL 缺失');
    const issueNumber = parseGitHubNumber(issue.issueUrl, repository, 'issues');
    const githubIssue = await github(`${repoPath}/issues/${issueNumber}`);
    assertLive(
      githubIssue.number === issueNumber && !('pull_request' in githubIssue),
      `Issue #${issueNumber} 不是可复核的独立 Issue`,
    );
    verifiedIssueNumbers.push(issueNumber);
  }
  assertLive(new Set(verifiedIssueNumbers).size === 2, '两个 confirmed Bugs 关联了重复 Issue');

  const releaseEvidence: string[] = [];
  const releaseTag = environment.LUOWANG_LIVE_RELEASE_TAG?.trim();
  if (releaseTag) {
    assertLive(isNewSemVerTag(releaseTag), '新发布 tag 必须是高于 v0.1.0 的 SemVer');
    const mainRef = await github(`${repoPathFor('cynos-ai', 'luowang')}/git/ref/heads/main`);
    const tagRef = await github(
      `${repoPathFor('cynos-ai', 'luowang')}/git/ref/tags/${encodeURIComponent(releaseTag)}`,
    );
    const releaseCommit = await peelGitHubTag(github, 'cynos-ai', 'luowang', tagRef);
    assertLive(
      asRecord(mainRef.object).sha === releaseCommit,
      '发布 tag 与 luowang main commit 不一致',
    );
    const legacyTagRef = await github(`${repoPathFor('cynos-ai', 'luowang')}/git/ref/tags/v0.1.0`);
    assertLive(
      asRecord(legacyTagRef.object).sha === '388c54741e86e10f252bac4f15b353d4ef2f7037',
      'v0.1.0 tag object 已改变',
    );
    const legacyCommit = await peelGitHubTag(github, 'cynos-ai', 'luowang', legacyTagRef);
    assertLive(
      legacyCommit === '71bb6bec0fc9e93c4a6578e165233d793ed49037',
      'v0.1.0 peeled commit 已改变',
    );
    releaseEvidence.push(`release tag ${releaseTag} equals luowang main ${releaseCommit}`);
  }

  const secretValues = [
    'LUOWANG_LIVE_GITHUB_TOKEN',
    'LUOWANG_ADMIN_PASSWORD',
    'LUOWANG_MASTER_KEY',
    'LUOWANG_LIVE_TEST_PASSWORD',
    'LUOWANG_LIVE_PROVIDER_API_KEY',
    'LUOWANG_LIVE_OSS_ACCESS_KEY_ID',
    'LUOWANG_LIVE_OSS_ACCESS_KEY_SECRET',
  ]
    .map((name) => environment[name])
    .filter((value): value is string => typeof value === 'string' && value.length >= 8);
  const publicFacts = JSON.stringify({
    connectivity,
    queue,
    runs,
    details,
    indexedReports,
    scenario: scenarioResponse,
    dashboard: dashboardResponse,
    github: githubPayloads,
  });
  assertLive(
    secretValues.every((secret) => !publicFacts.includes(secret)),
    'Secret 扫描在 API、工件或 GitHub payload 中发现凭据值',
  );

  return [
    `initial create queue → Run ${selection.initializationRunId}`,
    `UI screenshot + verified cleanup passed Run ${selection.passedRunId}`,
    `two confirmed Bugs/Issues failed Run ${selection.failedRunId}`,
    `non-progressing blocked Run ${selection.blockedRunId}`,
    `three-Session two-artifact scenario PR Run ${selection.scenarioReviewRunId}`,
    `current HEAD retest Run ${selection.currentHeadRetestRunId}`,
    `real-time scenario activity Run ${selection.progressRunId}`,
    `private OSS evidence ${image.filename ?? image.id}: authenticated stable read`,
    `Indexer commit ${branch.indexedCommit as string} equals GitHub scenario-testing HEAD`,
    `scenario PR #${scenarioPrNumber} and Issues ${failed.issues?.map((item) => `#${item.issueNumber}`).join(', ')}`,
    'Provider, Playwright MCP, private OSS, GitHub read and non-production URL connectivity: ok',
    'Secret value scan across candidate API, Run artifacts, indexed reports and GitHub payloads: no match',
    ...releaseEvidence,
  ];
}

async function runRelease(artifactDirectory: string): Promise<AcceptanceReport> {
  const startedAt = new Date().toISOString();
  const localReport = await runLocal(join(artifactDirectory, 'local'));
  const liveReport = await runLive();
  return createLayeredReport({
    mode: 'release',
    startedAt,
    local: localReport.local,
    live: liveReport.live,
    commands: [...localReport.commands, ...liveReport.commands],
    proofs: localReport.proofs,
    liveEvidence: liveReport.resourceChecks.find((item) => item.id === 'live-external-resources')
      ?.evidence,
    releasePublished:
      liveReport.acEvidence.find((item) => item.ac === 'AC-CLOSURE-RELEASE-01')?.status ===
      'passed',
  });
}

async function runAcceptanceCommand(
  label: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  verify?: () => Promise<void>,
): Promise<{ status: 'passed' | 'failed'; command: CommandResult }> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    await verify?.();
    return {
      status: 'passed',
      command: {
        command: label,
        status: 'passed',
        durationMs: Date.now() - startedAt,
        summary: summarize(`${result.stdout}\n${result.stderr}`),
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      command: {
        command: label,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        summary: safeError(error),
      },
    };
  }
}

export function localOnlyEnvironment(phase9Directory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(phase9Directory, 'isolated-home'),
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CI: process.env.CI,
    NODE_ENV: 'test',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
    npm_config_registry: process.env.npm_config_registry,
    LUOWANG_ACCEPTANCE_ARTIFACT_DIR: phase9Directory,
  };
  if (process.platform === 'win32') {
    environment.SystemRoot = process.env.SystemRoot;
    environment.ComSpec = process.env.ComSpec;
    environment.PATHEXT = process.env.PATHEXT;
  }
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function writeReport(directory: string, report: AcceptanceReport): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(directory, 'report.md'), renderMarkdown(report), 'utf8');
}

function renderMarkdown(report: AcceptanceReport): string {
  const resources = report.resourceChecks
    .map((check) => `| ${check.id} | ${check.status} | ${check.evidence.join('<br>')} |`)
    .join('\n');
  const ac = report.acEvidence
    .map((item) => `| ${item.ac} | ${item.status} | ${item.evidence.join('<br>')} |`)
    .join('\n');
  return `# LuoWang production acceptance\n\n- Mode: **${report.mode}**\n- local.status: **${report.local.status}**\n- live.status: **${report.live.status}**\n- release.status: **${report.release.status}**\n\n## Resource checks\n\n| Check | Status | Evidence |\n|---|---|---|\n${resources}\n\n## AC evidence\n\n| AC | Status | Evidence |\n|---|---|---|\n${ac}\n\n本地 test double 只能证明 local；live blocked 时 release 必须 blocked。\n`;
}

function summarize(value: string): string {
  return redactAcceptanceText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(' | ')
    .slice(0, 1000);
}

function safeError(error: unknown): string {
  return redactAcceptanceText(error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

export function redactAcceptanceText(value: string): string {
  return value
    .replace(
      /((?:["']?)(?:authorization|password|passwd|token|secret|cookie|api[_-]?key)["']?\s*[=:]\s*["']?)(?:bearer\s+)?[^"'\s,}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:github_pat_|gh[opsur]_|sk-)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, 'https://[REDACTED]@');
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'local') as AcceptanceMode;
  if (!['local', 'live', 'release'].includes(mode)) {
    throw new Error(`未知验收模式：${mode}`);
  }
  const directory =
    process.env.LUOWANG_ACCEPTANCE_ARTIFACT_DIR ??
    join(
      process.cwd(),
      '.cynos',
      'acceptance',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`,
    );
  const report =
    mode === 'local'
      ? await runLocal(directory)
      : mode === 'live'
        ? await runLive()
        : await runRelease(directory);
  await writeReport(directory, report);
  process.stdout.write(
    `Acceptance ${mode}: local=${report.local.status}, live=${report.live.status}, release=${report.release.status}; report=${join(directory, 'report.json')}\n`,
  );
  if (report.live.missing?.length) {
    process.stderr.write(
      `Missing live inputs:\n${report.live.missing.map((name) => `- ${name}`).join('\n')}\n`,
    );
  }
  if (
    (mode === 'local' && report.local.status !== 'passed') ||
    (mode === 'live' && report.live.status !== 'passed') ||
    (mode === 'release' && report.release.status !== 'passed')
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
