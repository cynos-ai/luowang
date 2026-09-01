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
        evidence: ['Closure 7 live runner and operator-provided resources'],
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
          'report.acEvidence[] contains one entry per Closure 6 AC',
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
  const live: LayerResult =
    missing.length > 0
      ? {
          status: 'blocked',
          message: `live 输入不完整；缺少 ${missing.length} 项。`,
          missing,
        }
      : {
          status: 'blocked',
          message:
            '输入预检通过，但真实联合验收由 Closure 7 live runner 执行；本阶段不伪报 passed。',
        };
  return createLayeredReport({
    mode: 'live',
    startedAt,
    local: { status: 'not_run', message: 'live 命令不把未运行的 local 写成 passed。' },
    live,
    proofs: emptyProofStatuses('not_run'),
  });
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
    commands: localReport.commands,
    proofs: localReport.proofs,
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
