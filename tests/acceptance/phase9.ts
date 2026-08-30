import { strict as assert } from 'node:assert';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium, type Browser } from 'playwright';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import pino from 'pino';

import { createApp } from '../../src/server/app.js';
import { createGitPoller } from '../../src/server/automation/poller.js';
import { createAutomationScheduler, matchesCron } from '../../src/server/automation/scheduler.js';
import { createAutomationStateStore } from '../../src/server/automation/state.js';
import { createTestRequestQueue } from '../../src/server/automation/queue.js';
import { createConfigurationStore } from '../../src/server/configuration.js';
import { loadConfig } from '../../src/server/config.js';
import { initializeDatabase } from '../../src/server/db/migrate.js';
import { createRepositoryIndexer } from '../../src/server/repository/indexer.js';
import { createRepositoryService } from '../../src/server/repository/service.js';
import type { RepositoryService } from '../../src/server/repository/service.js';
import { createRunArchiver } from '../../src/server/runs/archiver.js';
import { createControlledCommandRunner } from '../../src/server/runs/command-runner.js';
import type { ProviderAdapter } from '../../src/server/runs/provider.js';
import { createRunOrchestrator } from '../../src/server/runs/orchestrator.js';
import { createRunRecoveryStore } from '../../src/server/automation/recovery.js';
import { createRunStore, type RunStore } from '../../src/server/runs/store.js';
import { createTestDataManager } from '../../src/server/runs/test-data.js';
import type { AgentSessionFactory, AgentSessionInput } from '../../src/server/runs/types.js';
import { RunWorkspaceStore } from '../../src/server/runs/workspace.js';
import { createSecretStore } from '../../src/server/security/secret-store.js';
import type { RepositoryIssue, RunResult } from '../../src/shared/types.js';

const execFileAsync = promisify(execFile);

const SAMPLE_ADMIN_PASSWORD = 'phase9-sample-admin-password!';
const SAMPLE_NEW_ADMIN_PASSWORD = 'phase9-sample-new-password!';
const SAMPLE_MASTER_KEY = 'phase9-sample-master-key-material';
const SAMPLE_SECRET = 'phase9-sample-secret-value';
const SAMPLE_RUN_ID = '01K00000000000000000000001';
const SAMPLE_TARGET = 'a'.repeat(40);
const SAMPLE_SCENARIO_ID = 'AUTH-LOGIN-001';

type CaseStatus = 'passed' | 'failed';
type ProofKey =
  'security' | 'repository' | 'run' | 'archive' | 'automation' | 'browser' | 'regression';

interface AcceptanceCase {
  id: string;
  title: string;
  status: CaseStatus;
  detail: string;
  evidence: string[];
}

interface CommandEvidence {
  command: string;
  status: 'passed' | 'failed';
  durationMs: number;
  summary: string;
}

interface LocalProofs {
  security: boolean;
  repository: boolean;
  run: boolean;
  archive: boolean;
  automation: boolean;
  browser: boolean;
  regression: boolean;
}

interface GitFixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
  cloneDir: string;
  initialHead: string;
}

interface RepositoryProofContext {
  fixture: GitFixture;
  dataDir: string;
  reportDir: string;
  config: ReturnType<typeof loadConfig>;
  database: ReturnType<typeof initializeDatabase>;
  configuration: ReturnType<typeof createConfigurationStore>;
  repository: ReturnType<typeof createRepositoryService>;
  indexer: ReturnType<typeof createRepositoryIndexer>;
  runStore: RunStore;
  scenarioHead: string;
  productCommit: string;
}

interface SampleApp {
  baseUrl: string;
  close: () => Promise<void>;
}

const AC_DEFINITIONS: Array<{
  id: string;
  title: string;
  proof: ProofKey;
  evidence: string[];
}> = [
  {
    id: 'AC-DEPLOY-01',
    title: 'Docker 单实例启动、管理员初始化和 SQLite 持久化',
    proof: 'security',
    evidence: ['tests/acceptance/phase9.ts: security proof', 'tests/e2e/smoke.ts'],
  },
  {
    id: 'AC-CONFIG-01',
    title: '唯一目标仓库、Agent、MCP、OSS、Cron 和 Secret 元数据可配置',
    proof: 'security',
    evidence: ['tests/acceptance/phase9.ts: authenticated configuration proof'],
  },
  {
    id: 'AC-CONNECT-01',
    title: 'GitHub、Provider、MCP、OSS 和测试环境检查保持独立边界',
    proof: 'regression',
    evidence: ['tests/phase1.test.ts', 'tests/phase3-provider.test.ts', 'tests/phase4.test.ts'],
  },
  {
    id: 'AC-GIT-01',
    title: '场景测试分支可以从指定初始 ref 创建',
    proof: 'repository',
    evidence: ['tests/acceptance/phase9.ts: local bare repository'],
  },
  {
    id: 'AC-GIT-02',
    title: 'Git Poll 只监控场景测试分支',
    proof: 'automation',
    evidence: ['tests/phase6.test.ts', 'tests/acceptance/phase9.ts: poll proof'],
  },
  {
    id: 'AC-INDEX-01',
    title: 'Indexer 原子同步场景、报告、commit 和同步时间',
    proof: 'repository',
    evidence: ['tests/phase2.test.ts', 'tests/acceptance/phase9.ts: index proof'],
  },
  {
    id: 'AC-TRIGGER-01',
    title: 'commit/Cron 触发可以排除测试资产并合并待测提交',
    proof: 'automation',
    evidence: ['tests/phase6.test.ts', 'tests/acceptance/phase9.ts: queue and poll proof'],
  },
  {
    id: 'AC-RUN-01',
    title: 'Run 固定 base、target 和 included commits',
    proof: 'run',
    evidence: ['tests/phase3.test.ts', 'tests/acceptance/phase9.ts: orchestrator proof'],
  },
  {
    id: 'AC-GIT-03',
    title: '人工 merge 使用 no-ff、non-force push 且可幂等重试',
    proof: 'repository',
    evidence: ['tests/phase2.test.ts', 'tests/acceptance/phase9.ts: local merge proof'],
  },
  {
    id: 'AC-PROGRESS-01',
    title: 'passed/failed 只在报告和 Issue 归档完成后推进',
    proof: 'archive',
    evidence: ['tests/phase5.test.ts', 'tests/acceptance/phase9.ts: archive proof'],
  },
  {
    id: 'AC-PROGRESS-02',
    title: 'blocked、interrupted 和未完成 Issue 不推进',
    proof: 'archive',
    evidence: [
      'tests/phase5.test.ts',
      'tests/phase6.test.ts',
      'tests/acceptance/phase9.ts: archive proof',
    ],
  },
  {
    id: 'AC-ISSUE-01',
    title: '同一 Run 支持多个 Issue、创建幂等和已有 Issue 关联',
    proof: 'archive',
    evidence: ['tests/phase5.test.ts', 'tests/acceptance/phase9.ts: multi-issue proof'],
  },
  {
    id: 'AC-HISTORY-01',
    title: '旧 Run、报告和 Issue 关系保持只读历史不回写',
    proof: 'archive',
    evidence: ['tests/phase5.test.ts', 'tests/phase8.test.ts'],
  },
  {
    id: 'AC-TRIGGER-02',
    title: '只修改场景或报告目录的 commit 不自动触发测试',
    proof: 'automation',
    evidence: ['tests/phase6.test.ts', 'tests/acceptance/phase9.ts: test asset filter proof'],
  },
  {
    id: 'AC-SCENARIO-01',
    title: '场景 PR 合并后可人工重测最新场景且不计入产品提交',
    proof: 'automation',
    evidence: ['tests/phase7.test.ts', 'tests/phase6.test.ts'],
  },
  {
    id: 'AC-GIT-VIEW-01',
    title: 'Git 树只展示 Run Store 标记的 included/target 事实',
    proof: 'regression',
    evidence: ['tests/phase8.test.ts', 'tests/e2e/phase8-ui-smoke.ts'],
  },
  {
    id: 'AC-SCENARIO-VIEW-01',
    title: '场景列表、筛选、正文、历史和待审核 PR 可查看',
    proof: 'regression',
    evidence: ['tests/phase8.test.ts', 'tests/e2e/phase8-ui-smoke.ts'],
  },
  {
    id: 'AC-RUN-VIEW-01',
    title: 'Run 五文件、特殊 blocked 文件、证据和归档错误可查看',
    proof: 'regression',
    evidence: ['tests/phase8.test.ts', 'tests/e2e/phase8-ui-smoke.ts'],
  },
  {
    id: 'AC-ACTIVE-VIEW-01',
    title: '当前测试页展示阶段、场景、进度和脱敏活动',
    proof: 'regression',
    evidence: ['tests/phase8.test.ts', 'tests/e2e/phase8-ui-smoke.ts'],
  },
  {
    id: 'AC-AGENT-01',
    title: '人工请求按 Main A、Runner、Reviewer、Main B 产生五文件',
    proof: 'run',
    evidence: ['tests/phase3.test.ts', 'tests/acceptance/phase9.ts: four-session proof'],
  },
  {
    id: 'AC-BROWSER-01',
    title: '样例 Web 应用可由 headless Chromium 执行并产生可审核 UI 结果',
    proof: 'browser',
    evidence: [
      'tests/acceptance/phase9.ts: sample application browser proof',
      'tests/e2e/phase8-ui-smoke.ts',
    ],
  },
  {
    id: 'AC-ARCHIVE-01',
    title: '正常 Run 可幂等归档、发布、关联 Issue 并决定推进',
    proof: 'archive',
    evidence: ['tests/phase5.test.ts', 'tests/acceptance/phase9.ts: archive proof'],
  },
  {
    id: 'AC-REPORT-01',
    title: '正式报告只新增当前 Run 的三份 Markdown 文件',
    proof: 'archive',
    evidence: ['tests/phase5.test.ts', 'tests/acceptance/phase9.ts: report proof'],
  },
  {
    id: 'AC-SCENARIO-02',
    title: 'autonomous/add-only 的无需审批场景 patch 直接归档且不重复触发',
    proof: 'archive',
    evidence: ['tests/phase7.test.ts', 'tests/acceptance/phase9.ts: scenario publication proof'],
  },
  {
    id: 'AC-SCENARIO-03',
    title: '三种场景模式、allowlist 和 blocked 场景 PR 边界正确',
    proof: 'archive',
    evidence: ['tests/phase7.test.ts', 'tests/acceptance/phase9.ts: scenario PR proof'],
  },
  {
    id: 'AC-SCENARIO-04',
    title: '场景维护 PR 不重复创建产品 Bug Issue',
    proof: 'archive',
    evidence: ['tests/phase7.test.ts', 'tests/acceptance/phase9.ts: scenario PR proof'],
  },
  {
    id: 'AC-SCENARIO-05',
    title: '场景 PR 合并不改写旧 blocked Run，人工重测产生新 Run',
    proof: 'automation',
    evidence: ['tests/phase7.test.ts', 'tests/phase6.test.ts'],
  },
  {
    id: 'AC-QUEUE-01',
    title: '请求 FIFO、自动合批、人工重测和同 target 重跑不丢失',
    proof: 'automation',
    evidence: ['tests/phase6.test.ts', 'tests/acceptance/phase9.ts: queue proof'],
  },
  {
    id: 'AC-ZERO-01',
    title: 'Main 和 Reviewer 确认零场景时可以可信 passed',
    proof: 'run',
    evidence: ['tests/phase3.test.ts', 'tests/acceptance/phase9.ts: zero-scenario proof'],
  },
  {
    id: 'AC-RECOVERY-01',
    title: '重启后遗留 Run 显示 interrupted，不伪造结果',
    proof: 'automation',
    evidence: ['tests/phase6.test.ts', 'tests/acceptance/phase9.ts: recovery proof'],
  },
  {
    id: 'AC-SECRET-01',
    title: '密码、Token 和其他 Secret 不泄漏并可撤销旧会话',
    proof: 'security',
    evidence: [
      'tests/phase1.test.ts',
      'tests/phase3.test.ts',
      'tests/acceptance/phase9.ts: secret proof',
    ],
  },
  {
    id: 'AC-DATA-01',
    title: '样例临时测试数据按 Run 标记并可清理',
    proof: 'run',
    evidence: [
      'tests/phase4-orchestrator.test.ts',
      'tests/acceptance/phase9.ts: data cleanup proof',
    ],
  },
  {
    id: 'AC-INIT-01',
    title: '无场景样例项目初始化只建立少量场景，不引入 suite/catalog/state graph',
    proof: 'repository',
    evidence: ['tests/phase7.test.ts', 'tests/acceptance/phase9.ts: no-suite fixture proof'],
  },
  {
    id: 'AC-QUALITY-01',
    title: '格式、lint、typecheck、单测、生产构建和 headless e2e 全部通过',
    proof: 'regression',
    evidence: ['tests/acceptance/phase9.ts: isolated quality commands'],
  },
];

const QUALITY_COMMANDS: Array<[string, string[]]> = [
  ['npm run format:check', ['run', 'format:check']],
  ['npm run lint', ['run', 'lint']],
  ['npm run typecheck', ['run', 'typecheck']],
  ['npm test', ['test']],
  ['npm run build', ['run', 'build']],
  ['npm run test:e2e', ['run', 'test:e2e']],
];

const main = async (): Promise<void> => {
  const startedAt = new Date();
  const artifactDirectory =
    process.env.LUOWANG_ACCEPTANCE_ARTIFACT_DIR ??
    join(process.cwd(), '.cynos', 'acceptance', acceptanceTimestamp(startedAt));
  await mkdir(artifactDirectory, { recursive: true });

  const commands: CommandEvidence[] = [];
  const cases: AcceptanceCase[] = [];
  const proofs: LocalProofs = {
    security: false,
    repository: false,
    run: false,
    archive: false,
    automation: false,
    browser: false,
    regression: false,
  };
  const failures: string[] = [];
  let fixtureDetails: Record<string, unknown> = {};
  let repositoryDatabase: ReturnType<typeof initializeDatabase> | undefined;

  try {
    const qualityPassed = await runQualityCommands(commands);
    proofs.regression = qualityPassed;

    const rootDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase9-acceptance-'));
    let sampleApp: SampleApp | undefined;
    let browser: Browser | undefined;
    try {
      const fixture = await createGitFixture(rootDirectory);
      sampleApp = await startSampleApp();
      const repositoryContext = await createRepositoryProofContext(rootDirectory, fixture);
      repositoryDatabase = repositoryContext.database;
      fixtureDetails = {
        repository: 'local acceptance fixture for cynos-ai/cynos-website',
        initialCommit: fixture.initialHead,
        scenarioHead: repositoryContext.scenarioHead,
        productCommit: repositoryContext.productCommit,
        sampleApp: sampleApp.baseUrl,
      };

      await runProof('security', proofs, failures, () => runSecurityProof(rootDirectory));
      await runProof('repository', proofs, failures, () => runRepositoryProof(repositoryContext));
      await runProof('run', proofs, failures, () => runRunProof(repositoryContext));
      await runProof('archive', proofs, failures, () => runArchiveProof(rootDirectory));
      await runProof('automation', proofs, failures, () =>
        runAutomationProof(rootDirectory, repositoryContext),
      );
      browser = await chromium.launch({ headless: true });
      await runProof('browser', proofs, failures, () => runBrowserProof(browser!, sampleApp!));
    } finally {
      repositoryDatabase?.close();
      if (browser) await browser.close();
      if (sampleApp) await sampleApp.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  } catch (error) {
    failures.push(`Phase 9 harness setup failed: ${safeErrorMessage(error)}`);
  }

  for (const definition of AC_DEFINITIONS) {
    const passed = proofs[definition.proof];
    cases.push({
      id: definition.id,
      title: definition.title,
      status: passed ? 'passed' : 'failed',
      detail: passed
        ? '本地验收 fixture 和对应阶段回归证据通过。'
        : failures.join('；') || `本地 proof ${definition.proof} 未通过。`,
      evidence: definition.evidence,
    });
  }

  const live = await runOptionalGithubSmoke(commands);
  const localAcceptanceFailed = cases.some((item) => item.status === 'failed');
  const liveSmokeFailed = live.status === 'failed';
  const report = {
    schema: 'luowang.phase9.acceptance.v1',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    targetProject: 'cynos-ai/cynos-website',
    mode: 'local-fixture',
    status: localAcceptanceFailed || liveSmokeFailed ? 'failed' : 'passed',
    localProofs: proofs,
    fixture: fixtureDetails,
    cases,
    commands,
    liveSmoke: live,
    notes: [
      '样例仓库和样例 Web 应用均为本次命令创建的临时资源，已在报告写入后清理。',
      '本地 fixture 不替代真实 GitHub、DeepSeek、Playwright MCP、OSS 和非生产测试环境 smoke。',
      'live smoke 未启用时保持 blocked，不会被计入本地 AC 的 passed 证据。',
    ],
  };
  const reportPath = join(artifactDirectory, 'report.json');
  const markdownPath = join(artifactDirectory, 'report.md');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdownReport(report), 'utf8');

  process.stdout.write(
    `Phase 9 local acceptance ${report.status}; ${cases.length} AC recorded; report: ${reportPath}\n`,
  );
  if (live.status === 'blocked') {
    process.stdout.write(`Live smoke: blocked (${live.reason})\n`);
  } else {
    process.stdout.write(`Live smoke: ${live.status}\n`);
  }
  if (failures.length > 0 || liveSmokeFailed) {
    const errors = [...failures];
    if (liveSmokeFailed) errors.push('Live smoke failed; see the recorded command evidence.');
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  }
};

async function runQualityCommands(commands: CommandEvidence[]): Promise<boolean> {
  let passed = true;
  const npm = npmCommand();
  for (const [label, args] of QUALITY_COMMANDS) {
    const startedAt = Date.now();
    try {
      const result = await runCommand(npm.executable, [...npm.prefix, ...args]);
      commands.push({
        command: label,
        status: 'passed',
        durationMs: Date.now() - startedAt,
        summary: summarizeOutput(`${result.stdout}\n${result.stderr}`),
      });
    } catch (error) {
      passed = false;
      const details = commandErrorDetails(error);
      commands.push({
        command: label,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        summary: summarizeOutput(details),
      });
    }
  }
  return passed;
}

async function runOptionalGithubSmoke(commands: CommandEvidence[]): Promise<{
  status: 'passed' | 'failed' | 'blocked';
  reason?: string;
}> {
  if (process.env.LUOWANG_ACCEPTANCE_LIVE !== '1') {
    return {
      status: 'blocked',
      reason: '未设置 LUOWANG_ACCEPTANCE_LIVE=1；默认不执行外部副作用 smoke',
    };
  }
  const repository = process.env.LUOWANG_SMOKE_REPOSITORY;
  const token = process.env.LUOWANG_SMOKE_GITHUB_TOKEN;
  if (!repository || !token) {
    return {
      status: 'blocked',
      reason: '缺少 LUOWANG_SMOKE_REPOSITORY 或 LUOWANG_SMOKE_GITHUB_TOKEN',
    };
  }
  if (repository !== 'https://github.com/cynos-ai/cynos-website') {
    return { status: 'blocked', reason: 'Phase 9 固定目标必须是 cynos-ai/cynos-website' };
  }

  const startedAt = Date.now();
  const npm = npmCommand();
  try {
    const result = await runCommand(npm.executable, [...npm.prefix, 'run', 'test:e2e:github'], {
      LUOWANG_SMOKE_REPOSITORY: repository,
      LUOWANG_SMOKE_GITHUB_TOKEN: token,
    });
    commands.push({
      command: 'npm run test:e2e:github (live)',
      status: 'passed',
      durationMs: Date.now() - startedAt,
      summary: summarizeOutput(`${result.stdout}\n${result.stderr}`),
    });
    return { status: 'passed' };
  } catch (error) {
    commands.push({
      command: 'npm run test:e2e:github (live)',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      summary: summarizeOutput(commandErrorDetails(error)),
    });
    return { status: 'failed' };
  }
}

async function runProof(
  key: ProofKey,
  proofs: LocalProofs,
  failures: string[],
  proof: () => Promise<void>,
): Promise<void> {
  try {
    await proof();
    proofs[key] = true;
  } catch (error) {
    failures.push(`${key} proof failed: ${safeErrorMessage(error)}`);
  }
}

async function createGitFixture(parentDirectory: string): Promise<GitFixture> {
  const rootDir = join(parentDirectory, 'sample-repository');
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 9 Fixture'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase9@example.test'], sourceDir);
  await mkdir(join(sourceDir, 'docs'), { recursive: true });
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(
    join(sourceDir, 'README.md'),
    '# Cynos 官网验收样例\n\n仅用于本地验收。\n',
    'utf8',
  );
  await writeFile(
    join(sourceDir, 'docs', 'PROJECT.md'),
    '# Cynos 官网样例\n\n该样例模拟登录和注册流程，不连接生产数据。\n',
    'utf8',
  );
  await writeFile(
    join(sourceDir, 'src', 'account.ts'),
    'export const accountFlow = true;\n',
    'utf8',
  );
  await git(['add', '--all'], sourceDir);
  await git(['commit', '-m', 'fixture: initialize Cynos website sample'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  const initialHead = (await git(['rev-parse', 'HEAD'], sourceDir)).stdout.trim();
  return { rootDir, remoteDir, sourceDir, cloneDir, initialHead };
}

async function createRepositoryProofContext(
  parentDirectory: string,
  fixture: GitFixture,
): Promise<RepositoryProofContext> {
  const dataDir = join(parentDirectory, 'repository-data');
  const reportDir = join(dataDir, 'report');
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: fixture.cloneDir,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_ADMIN_PASSWORD: SAMPLE_ADMIN_PASSWORD,
    LUOWANG_MASTER_KEY: SAMPLE_MASTER_KEY,
  });
  const database = initializeDatabase(config);
  try {
    const configuration = createConfigurationStore(database.sqlite, {
      repoDir: config.repoDir,
      reportDir: config.reportDir,
    });
    configuration.updateRepository({
      repository: fixture.remoteDir,
      scenarioBranch: 'scenario-testing',
      scenarioMode: 'review-all',
      triggerOnCommit: true,
      pollIntervalSeconds: 60,
      cron: '*/5 * * * *',
    });
    configuration.updateHarness({
      provider: 'deepseek',
      agents: {
        main: { model: 'deepseek-v4-flash', thinking: 'medium' },
        runner: { model: 'deepseek-v4-flash', thinking: 'medium' },
        reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'medium' },
      },
      mcp: { enabled: true, browser: 'chromium', headless: true, timeoutMs: 30_000 },
      oss: {
        endpoint: 'https://objects.example.test',
        region: 'test-region',
        bucket: 'phase9-fixture',
        accessMode: 'private',
        objectPrefix: 'phase9',
      },
    });
    const secretStore = createSecretStore(database.sqlite, config.masterKey);
    const repository = createRepositoryService(database.sqlite, configuration, secretStore, {
      repoDir: config.repoDir,
      allowLocalRepository: true,
    });
    const created = await repository.ensureScenarioBranch('main');
    assert.equal(created.created, true);

    await git(['fetch', 'origin'], fixture.sourceDir);
    await git(['checkout', '-B', 'scenario-testing', 'origin/scenario-testing'], fixture.sourceDir);
    await mkdir(join(fixture.sourceDir, 'docs', 'scenario-testing', 'scenarios'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.sourceDir, 'docs', 'scenario-testing', 'scenarios', `${SAMPLE_SCENARIO_ID}.md`),
      scenarioMarkdown(SAMPLE_SCENARIO_ID, '用户登录后刷新页面仍保持会话。'),
      'utf8',
    );
    await writeFile(
      join(fixture.sourceDir, 'docs', 'scenario-testing', 'scenarios', 'AUTH-REGISTER-001.md'),
      scenarioMarkdown('AUTH-REGISTER-001', '用户可以注册并进入登录页。'),
      'utf8',
    );
    await git(['add', '--all'], fixture.sourceDir);
    await git(['commit', '-m', 'test: seed login and registration scenarios'], fixture.sourceDir);
    await git(['push', 'origin', 'HEAD:refs/heads/scenario-testing'], fixture.sourceDir);
    const scenarioHead = (await git(['rev-parse', 'HEAD'], fixture.sourceDir)).stdout.trim();

    await git(['checkout', 'main'], fixture.sourceDir);
    await writeFile(
      join(fixture.sourceDir, 'src', 'account.ts'),
      'export const accountFlow = true;\nexport const login = true;\n',
      'utf8',
    );
    await git(['add', '--all'], fixture.sourceDir);
    await git(['commit', '-m', 'feat: improve Cynos login flow'], fixture.sourceDir);
    await git(['push', 'origin', 'main'], fixture.sourceDir);
    const productCommit = (await git(['rev-parse', 'HEAD'], fixture.sourceDir)).stdout.trim();
    const merged = await repository.mergeSourceRef('main', true);
    assert.equal(merged.alreadyIncluded, false);
    assert.ok(merged.mergeCommit);
    await git(['fetch', 'origin'], fixture.sourceDir);
    await git(['checkout', '-B', 'scenario-testing', 'origin/scenario-testing'], fixture.sourceDir);

    const indexer = createRepositoryIndexer(database.sqlite, repository);
    const sync = await indexer.sync();
    assert.equal(sync.status, 'synced');
    assert.equal(sync.scenarios, 2);
    assert.equal(indexer.getScenario(SAMPLE_SCENARIO_ID)?.commitSha, sync.commitSha);
    const runStore = createRunStore(database.sqlite);
    return {
      fixture,
      dataDir,
      reportDir,
      config,
      database,
      configuration,
      repository,
      indexer,
      runStore,
      scenarioHead,
      productCommit,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function runRepositoryProof(context: RepositoryProofContext): Promise<void> {
  const status = await context.repository.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.scenarioBranch, 'scenario-testing');
  assert.ok(status.remoteHead);
  const tree = await context.repository.listTree(status.remoteHead!);
  assert.ok(tree.some((entry) => entry.path.endsWith(`${SAMPLE_SCENARIO_ID}.md`)));

  const sourceHead = (
    await git(['rev-parse', 'origin/scenario-testing'], context.fixture.sourceDir)
  ).stdout.trim();
  assert.equal(sourceHead, status.remoteHead);
  const history = await (await context.repository.getRepository()).history(status.remoteHead!);
  assert.ok(history.some((entry) => entry.subject.includes('improve Cynos login flow')));

  await writeFile(
    join(
      context.fixture.sourceDir,
      'docs',
      'scenario-testing',
      'scenarios',
      'AUTH-REGISTER-001.md',
    ),
    scenarioMarkdown('AUTH-REGISTER-001', '用户注册后可以回到登录页。'),
    'utf8',
  );
  await git(['add', '--all'], context.fixture.sourceDir);
  await git(['commit', '-m', 'test: refine scenario wording'], context.fixture.sourceDir);
  await git(['push', 'origin', 'HEAD:refs/heads/scenario-testing'], context.fixture.sourceDir);
  await context.indexer.sync();
  assert.match(context.indexer.getScenario('AUTH-REGISTER-001')?.description ?? '', /注册/);
}

async function runRunProof(context: RepositoryProofContext): Promise<void> {
  const targetCommit = (
    await git(
      ['ls-remote', '--heads', context.fixture.remoteDir, 'refs/heads/scenario-testing'],
      context.fixture.rootDir,
    )
  ).stdout.split(/\s+/, 1)[0];
  assert.match(targetCommit, /^[0-9a-f]{40}$/);
  const sessions = new FixtureSessionFactory();
  const recoveryStore = createRunRecoveryStore(context.database.sqlite);
  const orchestrator = createRunOrchestrator({
    configuration: context.configuration,
    repository: context.repository,
    indexer: context.indexer,
    reportDir: context.reportDir,
    secretStore: createSecretStore(context.database.sqlite, SAMPLE_MASTER_KEY),
    provider: {} as ProviderAdapter,
    sessions,
    commandRunner: createControlledCommandRunner({ ...process.env, PHASE9_SECRET: SAMPLE_SECRET }),
    testData: createTestDataManager({ cleanup: async () => [] }),
    runStore: context.runStore,
    recoveryStore,
    logger: pino({ level: 'silent' }),
    browser: disabledBrowserAdapter(),
  });
  const result = await orchestrator.run({
    request: '验证 Cynos 官网登录会话保持，当前批次不需要浏览器场景',
    trigger: 'manual',
    targetCommit,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.result, 'passed');
  assert.equal(result.targetCommit, targetCommit);
  assert.equal(result.baseCommit, null);
  assert.deepEqual(result.includedCommits, []);
  assert.deepEqual(Object.keys(result.artifacts).sort(), [
    'draft-report.md',
    'execution.md',
    'plan.md',
    'report.md',
    'review.md',
  ]);
  assert.equal(sessions.created.join(','), 'main-a,runner,reviewer,main-b');
  assert.equal(sessions.disposed.join(','), 'main-a,runner,reviewer,main-b');
  assert.equal(context.runStore.get(result.runId)?.result, 'passed');
  assert.equal(context.runStore.get(result.runId)?.initialization, false);
  assert.match(result.artifacts['report.md'] ?? '', /无需场景测试/);

  const archive = createRunArchiver({
    database: context.database.sqlite,
    reportDir: context.reportDir,
    repository: context.repository,
    indexer: context.indexer,
    runStore: context.runStore,
    logger: pino({ level: 'silent' }),
  });
  const firstArchive = await archive.archive(result.runId);
  assert.equal(firstArchive.status, 'completed', JSON.stringify(firstArchive));
  assert.equal(firstArchive.progressed, true);
  assert.equal(firstArchive.reportStatus, 'published');
  assert.equal(firstArchive.issues.length, 0);
  const secondArchive = await archive.retry(result.runId);
  assert.equal(secondArchive.status, 'completed');
  assert.equal(secondArchive.reportCommitSha, firstArchive.reportCommitSha);
  assert.equal(
    context.indexer.listReports().some((report) => report.runId === result.runId),
    true,
  );
  const reportTree = await context.repository.listTree(firstArchive.reportCommitSha!);
  assert.equal(
    reportTree.filter((entry) =>
      entry.path.startsWith(`docs/scenario-testing/reports/${result.runId}/`),
    ).length,
    3,
  );
}

async function runSecurityProof(parentDirectory: string): Promise<void> {
  const missingDataDir = join(parentDirectory, 'missing-admin-data');
  const missingConfig = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: missingDataDir });
  const missingDatabase = initializeDatabase(missingConfig);
  let missingApp: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    missingApp = await createApp({
      config: missingConfig,
      database: missingDatabase,
      logger: pino({ level: 'silent' }),
      backgroundTasks: false,
    });
    const missingStatus = await missingApp.inject({ method: 'GET', url: '/api/auth/status' });
    assert.deepEqual(missingStatus.json(), { configured: false, authenticated: false });
    const anonymousSetup = await missingApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'not-configured' },
    });
    assert.equal(anonymousSetup.statusCode, 401);
  } finally {
    await missingApp?.close().catch(() => undefined);
    missingDatabase.close();
  }

  const dataDir = join(parentDirectory, 'secure-console-data');
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_ADMIN_PASSWORD: SAMPLE_ADMIN_PASSWORD,
    LUOWANG_MASTER_KEY: SAMPLE_MASTER_KEY,
  });
  const database = initializeDatabase(config);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({
      config,
      database,
      logger: pino({ level: 'silent' }),
      backgroundTasks: false,
    });
    assert.ok(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SAMPLE_ADMIN_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.includes(SAMPLE_ADMIN_PASSWORD), false);
    const cookie = firstCookie(login.headers['set-cookie']);
    assert.ok(cookie);
    const configUpdate = await app.inject({
      method: 'PUT',
      url: '/api/config/harness',
      headers: { cookie },
      payload: {
        provider: 'deepseek',
        agents: {
          main: { model: 'deepseek-v4-flash', thinking: 'medium' },
          runner: { model: 'deepseek-v4-flash', thinking: 'medium' },
          reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'medium' },
        },
        mcp: { enabled: true, browser: 'chromium', headless: true, timeoutMs: 30_000 },
        secrets: { providerApiKey: SAMPLE_SECRET },
      },
    });
    assert.equal(configUpdate.statusCode, 200);
    assert.equal(configUpdate.body.includes(SAMPLE_SECRET), false);
    assert.equal(configUpdate.json().secrets.providerApiKey.configured, true);
    assert.equal(configUpdate.json().secrets.providerApiKey.masked, '••••••••');
    const configResponse = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie },
    });
    assert.equal(configResponse.statusCode, 200);
    assert.equal(configResponse.body.includes(SAMPLE_SECRET), false);
    const storedSecret = database.sqlite
      .prepare('SELECT ciphertext FROM secret_entries WHERE key = ?')
      .get('providerApiKey') as { ciphertext: string };
    assert.ok(storedSecret);
    assert.equal(storedSecret.ciphertext.includes(SAMPLE_SECRET), false);
    const passwordHash = database.sqlite
      .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
      .get() as { password_hash: string };
    assert.match(passwordHash.password_hash, /^\$argon2id\$/);
    assert.equal(passwordHash.password_hash.includes(SAMPLE_ADMIN_PASSWORD), false);

    const wrongOrigin = await app.inject({
      method: 'PUT',
      url: '/api/config/repository',
      headers: { cookie, origin: 'https://evil.example.test' },
      payload: { repository: 'https://github.com/cynos-ai/cynos-website' },
    });
    assert.equal(wrongOrigin.statusCode, 403);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: SAMPLE_ADMIN_PASSWORD, newPassword: SAMPLE_NEW_ADMIN_PASSWORD },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/config', headers: { cookie } })).statusCode,
      401,
    );
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SAMPLE_NEW_ADMIN_PASSWORD },
    });
    assert.equal(relogin.statusCode, 200);
  } finally {
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    await app?.close().catch(() => undefined);
    database.close();
  }
  const backupPath = join(parentDirectory, 'secure-console-backup.db');
  await copyFile(config.databasePath, backupPath);
  const restoredDir = join(parentDirectory, 'restored-data');
  const restoredConfig = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: restoredDir,
    LUOWANG_DATABASE_PATH: join(restoredDir, 'luowang.db'),
  });
  await mkdir(restoredDir, { recursive: true });
  await copyFile(backupPath, restoredConfig.databasePath);
  const restoredDatabase = initializeDatabase(restoredConfig);
  try {
    const restoredRow = restoredDatabase.sqlite
      .prepare('SELECT password_hash FROM admin_credentials WHERE id = 1')
      .get() as { password_hash: string };
    assert.match(restoredRow.password_hash, /^\$argon2id\$/);
  } finally {
    restoredDatabase.close();
  }

  const envDirectory = join(parentDirectory, 'env-proof');
  await mkdir(envDirectory, { recursive: true });
  await writeFile(
    join(envDirectory, 'print-env.js'),
    'process.stdout.write(JSON.stringify(process.env));\n',
    'utf8',
  );
  const commandRunner = createControlledCommandRunner({
    ...process.env,
    LUOWANG_ADMIN_PASSWORD: SAMPLE_ADMIN_PASSWORD,
    LUOWANG_MASTER_KEY: SAMPLE_MASTER_KEY,
    PHASE9_SECRET: SAMPLE_SECRET,
  });
  const envResult = await commandRunner.run('node print-env.js', {
    cwd: envDirectory,
    runId: SAMPLE_RUN_ID,
    targetCommit: SAMPLE_TARGET,
  });
  const childEnvironment = JSON.parse(envResult.stdout) as Record<string, string>;
  assert.equal(childEnvironment.LUOWANG_ADMIN_PASSWORD, undefined);
  assert.equal(childEnvironment.LUOWANG_MASTER_KEY, undefined);
  assert.equal(childEnvironment.PHASE9_SECRET, undefined);
  assert.equal(childEnvironment.LUOWANG_RUN_ID, SAMPLE_RUN_ID);
  assert.equal(childEnvironment.LUOWANG_TARGET_COMMIT, SAMPLE_TARGET);
}

async function runAutomationProof(
  parentDirectory: string,
  context: RepositoryProofContext,
): Promise<void> {
  const queue = createTestRequestQueue(context.database.sqlite, {
    requestId: (() => {
      let index = 0;
      return () => `phase9-request-${++index}`;
    })(),
  });
  const automatic = queue.enqueue({
    request: 'Git product change',
    trigger: 'git',
    targetRef: SAMPLE_TARGET,
  });
  const merged = queue.enqueue({
    request: 'Cron product change',
    trigger: 'schedule',
    targetRef: 'b'.repeat(40),
  });
  assert.equal(merged.queueId, automatic.queueId);
  assert.deepEqual(merged.triggerSources, ['git', 'schedule']);
  const manual = queue.enqueue({
    request: '人工重测同一 target',
    trigger: 'manual',
    targetRef: 'b'.repeat(40),
  });
  assert.notEqual(manual.queueId, automatic.queueId);
  const claimed = queue.claimNext();
  assert.equal(claimed?.queueId, automatic.queueId);
  queue.markStarted(automatic.queueId, SAMPLE_RUN_ID);
  queue.markWaitingArchive(automatic.queueId, SAMPLE_RUN_ID);
  queue.complete(automatic.queueId, {
    runId: SAMPLE_RUN_ID,
    archiveStatus: 'completed',
    progressed: true,
  });
  assert.equal(queue.claimNext()?.queueId, manual.queueId);

  const pollState = createAutomationStateStore(context.database.sqlite);
  pollState.delete('git-poller.last-seen-commit');
  pollState.delete('git-poller.repository');
  pollState.delete('git-poller.branch');
  const pollQueue = createTestRequestQueue(context.database.sqlite, {
    requestId: () => `poll-request-${Date.now()}`,
  });
  const pollQueueCount = pollQueue.list().length;
  const poller = createGitPoller({
    configuration: context.configuration,
    repository: context.repository,
    state: pollState,
    runStore: context.runStore,
    submitter: {
      submitTestRequest: async (input) => ({ queue: pollQueue.enqueue(input) }),
    },
  });
  const initialized = await poller.poll('git');
  assert.equal(initialized.status, 'ignored');
  await git(['fetch', 'origin'], context.fixture.sourceDir);
  await git(
    ['checkout', '-B', 'scenario-testing', 'origin/scenario-testing'],
    context.fixture.sourceDir,
  );
  await writeFile(
    join(
      context.fixture.sourceDir,
      'docs',
      'scenario-testing',
      'scenarios',
      'AUTH-REGISTER-001.md',
    ),
    scenarioMarkdown('AUTH-REGISTER-001', '纯场景提交只更新说明。'),
    'utf8',
  );
  await git(['add', '--all'], context.fixture.sourceDir);
  await git(['commit', '-m', 'test: scenario-only update'], context.fixture.sourceDir);
  await git(['push', 'origin', 'HEAD:refs/heads/scenario-testing'], context.fixture.sourceDir);
  const ignored = await poller.poll('git');
  assert.equal(ignored.status, 'ignored');
  assert.equal(pollQueue.list().length, pollQueueCount);

  await git(['checkout', 'main'], context.fixture.sourceDir);
  await writeFile(
    join(context.fixture.sourceDir, 'src', 'account.ts'),
    'export const accountFlow = true;\nexport const login = true;\nexport const logout = true;\n',
    'utf8',
  );
  await git(['add', '--all'], context.fixture.sourceDir);
  await git(['commit', '-m', 'feat: add logout flow'], context.fixture.sourceDir);
  await git(['push', 'origin', 'main'], context.fixture.sourceDir);
  await context.repository.mergeSourceRef('main', true);
  const queued = await poller.poll('git');
  assert.equal(queued.status, 'queued');
  assert.ok(queued.includedCommits.length > 0);

  const schedulerState = createAutomationStateStore(context.database.sqlite);
  const pollCalls: string[] = [];
  const scheduler = createAutomationScheduler({
    configuration: context.configuration,
    poller: {
      poll: async (trigger) => {
        pollCalls.push(trigger);
        return {
          status: 'no_change' as const,
          trigger,
          scenarioBranch: 'scenario-testing',
          currentHead: null,
          baselineCommit: null,
          includedCommits: [],
          queue: null,
          message: 'fixture scheduler poll',
        };
      },
      reset: () => undefined,
    },
    automation: {
      state: () => schedulerState,
      scanArchives: async () => [],
      cleanupRetention: async () => ({ removedRunIds: [], skippedRunIds: [] }),
    } as never,
    indexer: { sync: async () => ({ status: 'synced' as const }) } as never,
    state: schedulerState,
    now: () => new Date('2026-08-30T00:00:00.000Z'),
    logger: pino({ level: 'silent' }),
  });
  await scheduler.tick(new Date('2026-08-30T00:01:00.000Z'));
  await scheduler.tick(new Date('2026-08-30T00:05:00.000Z'));
  assert.equal(pollCalls.includes('git'), true);
  assert.equal(pollCalls.includes('schedule'), true);
  assert.equal(matchesCron('*/5 * * * *', new Date('2026-08-30T00:05:00.000Z')), true);

  const recoveryDir = join(parentDirectory, 'recovery-data');
  const recoveryConfig = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: recoveryDir });
  const recoveryDatabase = initializeDatabase(recoveryConfig);
  try {
    const recoveryStore = createRunRecoveryStore(recoveryDatabase.sqlite);
    const workspace = await new RunWorkspaceStore(recoveryConfig.reportDir).create(SAMPLE_RUN_ID);
    await workspace.writer('main-a').writePlan('# 部分执行计划');
    const recoveryOrchestrator = createRunOrchestrator({
      configuration: createConfigurationStore(recoveryDatabase.sqlite, {
        repoDir: recoveryConfig.repoDir,
        reportDir: recoveryConfig.reportDir,
      }),
      repository: {} as RepositoryService,
      reportDir: recoveryConfig.reportDir,
      provider: {} as ProviderAdapter,
      recoveryStore,
    });
    await recoveryOrchestrator.recover();
    const interrupted = await recoveryOrchestrator.get(SAMPLE_RUN_ID);
    assert.equal(interrupted?.status, 'interrupted');
    assert.equal(interrupted?.result, null);
  } finally {
    recoveryDatabase.close();
  }
}

async function runBrowserProof(browser: Browser, sampleApp: SampleApp): Promise<void> {
  assert.equal(browser.isConnected(), true);
  assert.match(browser.version(), /^\d/);
  const context = await browser.newContext({ viewport: { width: 1_280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(sampleApp.baseUrl);
    await page.getByRole('heading', { name: 'Cynos 官网验收样例' }).waitFor();
    await page.getByLabel('用户名').fill('phase9-user');
    await page.getByLabel('密码').fill('phase9-test-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText('登录成功', { exact: true }).waitFor();
    await page.getByLabel('注册邮箱').fill('phase9@example.test');
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.getByText('注册成功', { exact: true }).waitFor();
    const responses = await page.evaluate(async () => {
      const failed = await fetch('/api/failure');
      const blocked = await fetch('/api/blocked');
      return { failed: failed.status, blocked: blocked.status };
    });
    assert.deepEqual(responses, { failed: 500, blocked: 503 });
  } finally {
    await context.close();
  }
}

async function runArchiveProof(parentDirectory: string): Promise<void> {
  const archiveDir = join(parentDirectory, 'archive-data');
  const config = loadConfig({ NODE_ENV: 'test', LUOWANG_DATA_DIR: archiveDir });
  const database = initializeDatabase(config);
  try {
    const store = createRunStore(database.sqlite);
    const repository = new ArchiveRepositoryDouble();
    const reportDir = config.reportDir;
    const archiver = createRunArchiver({
      database: database.sqlite,
      reportDir,
      repository: repository as unknown as RepositoryService,
      runStore: store,
      logger: pino({ level: 'silent' }),
    });
    const failedRunId = '01K00000000000000000000002';
    await writeCompletedRun(
      reportDir,
      failedRunId,
      reportMarkdown(failedRunId, 'failed', true, ['BUG-LOGIN-001', 'BUG-LOGIN-002']),
    );
    store.importCompleted({
      runId: failedRunId,
      trigger: 'manual',
      request: '验证多个产品问题',
      baseCommit: null,
      targetCommit: SAMPLE_TARGET,
      includedCommits: [],
      result: 'failed',
      startedAt: '2026-08-30T00:00:00Z',
      finishedAt: '2026-08-30T00:01:00Z',
      completedDirectory: join(reportDir, 'completed', failedRunId),
      artifacts: await readCompletedArtifacts(reportDir, failedRunId),
      scenarioResults: [{ id: SAMPLE_SCENARIO_ID, result: 'failed' }],
      confirmedBugs: [
        {
          key: 'BUG-LOGIN-001',
          title: '登录状态丢失',
          scenarioIds: [SAMPLE_SCENARIO_ID],
          issueAction: 'create',
        },
        {
          key: 'BUG-LOGIN-002',
          title: '注册错误提示丢失',
          scenarioIds: ['AUTH-REGISTER-001'],
          issueAction: 'create',
        },
      ],
    });
    const failedArchive = await archiver.archive(failedRunId);
    assert.equal(failedArchive.status, 'completed', JSON.stringify(failedArchive));
    assert.equal(failedArchive.progressed, true);
    assert.equal(failedArchive.issues.length, 2);
    assert.equal(repository.createdIssues, 2);
    const retry = await archiver.retry(failedRunId);
    assert.equal(retry.issues.length, 2);
    assert.equal(repository.createdIssues, 2);

    const blockedRunId = '01K00000000000000000000003';
    await writeCompletedRun(
      reportDir,
      blockedRunId,
      reportMarkdown(
        blockedRunId,
        'blocked',
        true,
        ['BUG-BLOCKED-001'],
        '2026-08-30T00:02:00Z',
        '2026-08-30T00:03:00Z',
      ),
    );
    store.importCompleted({
      runId: blockedRunId,
      trigger: 'manual',
      request: '验证被环境阻塞但记录问题',
      baseCommit: null,
      targetCommit: 'b'.repeat(40),
      includedCommits: [],
      result: 'blocked',
      startedAt: '2026-08-30T00:02:00Z',
      finishedAt: '2026-08-30T00:03:00Z',
      completedDirectory: join(reportDir, 'completed', blockedRunId),
      artifacts: await readCompletedArtifacts(reportDir, blockedRunId),
      scenarioResults: [{ id: SAMPLE_SCENARIO_ID, result: 'blocked' }],
      confirmedBugs: [
        {
          key: 'BUG-BLOCKED-001',
          title: '环境不可用',
          scenarioIds: [SAMPLE_SCENARIO_ID],
          issueAction: 'create',
        },
      ],
    });
    const blockedArchive = await archiver.archive(blockedRunId);
    assert.equal(blockedArchive.status, 'completed');
    assert.equal(blockedArchive.progressed, false);

    const retryRunId = '01K00000000000000000000004';
    repository.failNextIssue = true;
    await writeCompletedRun(
      reportDir,
      retryRunId,
      reportMarkdown(
        retryRunId,
        'failed',
        true,
        ['BUG-RETRY-001'],
        '2026-08-30T00:04:00Z',
        '2026-08-30T00:05:00Z',
      ),
    );
    store.importCompleted({
      runId: retryRunId,
      trigger: 'manual',
      request: '验证归档重试',
      baseCommit: null,
      targetCommit: 'c'.repeat(40),
      includedCommits: [],
      result: 'failed',
      startedAt: '2026-08-30T00:04:00Z',
      finishedAt: '2026-08-30T00:05:00Z',
      completedDirectory: join(reportDir, 'completed', retryRunId),
      artifacts: await readCompletedArtifacts(reportDir, retryRunId),
      scenarioResults: [{ id: SAMPLE_SCENARIO_ID, result: 'failed' }],
      confirmedBugs: [
        {
          key: 'BUG-RETRY-001',
          title: '可重试问题',
          scenarioIds: [SAMPLE_SCENARIO_ID],
          issueAction: 'create',
        },
      ],
    });
    const partial = await archiver.archive(retryRunId);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.progressed, false);
    repository.failNextIssue = false;
    const recovered = await archiver.retry(retryRunId);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.progressed, true);

    const specialRunId = '01K00000000000000000000005';
    const specialPatch = unifiedPatch(
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
      'updated scenario',
    );
    await writeSpecialRun(
      reportDir,
      specialRunId,
      reportMarkdown(
        specialRunId,
        'blocked',
        false,
        undefined,
        '2026-08-30T00:06:00Z',
        '2026-08-30T00:07:00Z',
      ),
      specialPatch,
    );
    store.importCompleted({
      runId: specialRunId,
      trigger: 'manual',
      request: '审核场景变更',
      baseCommit: null,
      targetCommit: 'd'.repeat(40),
      includedCommits: [],
      result: 'blocked',
      startedAt: '2026-08-30T00:06:00Z',
      finishedAt: '2026-08-30T00:07:00Z',
      completedDirectory: join(reportDir, 'completed', specialRunId),
      artifacts: await readCompletedArtifacts(reportDir, specialRunId),
      scenarioResults: [],
      confirmedBugs: [],
      specialRun: true,
      scenarioMode: 'review-all',
    });
    const special = await archiver.archive(specialRunId);
    assert.equal(special.status, 'completed');
    assert.equal(special.progressed, false);
    assert.equal(special.scenarioStatus, 'pull_request');
    assert.ok(special.scenarioPrUrl);
    assert.equal(repository.scenarioIssueCount, 0);
  } finally {
    database.close();
  }
}

class FixtureSessionFactory implements AgentSessionFactory {
  readonly created: string[] = [];
  readonly disposed: string[] = [];

  async create(input: AgentSessionInput) {
    this.created.push(input.role);
    return {
      prompt: async () => {
        const target = extractTarget(input.systemPrompt);
        if (input.role === 'main-a') {
          await invokeTool(input, 'get_run_context', {});
          await invokeTool(input, 'write_plan', {
            content: '# 测试计划\n\n无需场景测试：本批只确认文档工件流转和固定 target。\n',
          });
          return;
        }
        if (input.role === 'runner') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'get_test_data_prefix', {});
          await invokeTool(input, 'register_test_data', {
            id: 'phase9-login-fixture',
            description: '本地样例登录数据',
          });
          const command = await invokeTool(input, 'run_fixture_command', {
            command: 'node --version',
          });
          await invokeTool(input, 'write_execution', {
            content: `# 执行记录\n\n固定 target：${target}\n\n${toolText(command)}\n`,
          });
          await invokeTool(input, 'write_draft_report', { content: '# Draft\n\n无需场景测试。\n' });
          return;
        }
        if (input.role === 'reviewer') {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'execution.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'draft-report.md' });
          await invokeTool(input, 'write_review', {
            content: '# Review\n\n独立确认无需场景测试。\n',
          });
          return;
        }
        for (const name of ['plan.md', 'execution.md', 'draft-report.md', 'review.md']) {
          await invokeTool(input, 'read_run_artifact', { name });
        }
        await invokeTool(input, 'write_report', {
          content: reportForContext(input.systemPrompt, target),
        });
      },
      dispose: () => {
        this.disposed.push(input.role);
      },
    };
  }
}

class ArchiveRepositoryDouble {
  readonly issues = new Map<string, RepositoryIssue>();
  createdIssues = 0;
  scenarioIssueCount = 0;
  failNextIssue = false;

  getRepositoryUrl(): string {
    return 'https://github.com/cynos-ai/cynos-website';
  }

  async publishRunReports() {
    return {
      status: 'published' as const,
      commitSha: 'e'.repeat(40),
      scenarioBranchHead: 'e'.repeat(40),
    };
  }

  async findIssuesByMarkers(markers: readonly string[]): Promise<RepositoryIssue[]> {
    return [...this.issues.values()].filter((issue) =>
      markers.every((marker) => issue.title.includes(marker)),
    );
  }

  async createIssue(title: string, body: string): Promise<RepositoryIssue> {
    if (this.failNextIssue) {
      this.failNextIssue = false;
      throw new Error('fixture issue endpoint temporarily unavailable');
    }
    const number = ++this.createdIssues;
    const runMarker = body.match(/- (luowang-run:[^\n]+)/)?.[1] ?? '';
    const bugMarker = body.match(/- (luowang-bug:[^\n]+)/)?.[1] ?? '';
    const issue = {
      number,
      title: `${title} ${runMarker} ${bugMarker}`.trim(),
      state: 'open' as const,
      url: `https://github.com/cynos-ai/cynos-website/issues/${number}`,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    };
    this.issues.set(`${number}`, issue);
    return issue;
  }

  async getIssueByUrl(url: string): Promise<RepositoryIssue> {
    const issue = [...this.issues.values()].find((item) => item.url === url);
    if (!issue) throw new Error('fixture issue not found');
    return issue;
  }

  async validateScenarioPatch() {
    return {
      changes: [],
      changedPaths: ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'],
      addedPaths: [],
      modifiedPaths: ['docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'],
      renamedPaths: [],
      onlyAdds: false,
    };
  }

  async publishScenarioChanges(_runId: string, _patch: string, mode: 'direct' | 'pull-request') {
    if (mode === 'pull-request') {
      return {
        status: 'pull_request' as const,
        commitSha: 'f'.repeat(40),
        scenarioBranchHead: 'f'.repeat(40),
        scenarioPrUrl: 'https://github.com/cynos-ai/cynos-website/pull/9',
      };
    }
    return {
      status: 'published' as const,
      commitSha: 'f'.repeat(40),
      scenarioBranchHead: 'f'.repeat(40),
      scenarioPrUrl: null,
    };
  }
}

function disabledBrowserAdapter() {
  return {
    isEnabled: () => false,
    serverDefinition: () => ({
      command: 'npx',
      args: [],
      env: {},
      lifecycle: 'lazy' as const,
      directTools: false as const,
      excludeTools: [],
      requestTimeoutMs: 30_000,
    }),
    extension: () => ({ name: 'disabled-browser', hidden: true, factory: async () => undefined }),
    checkConnectivity: async () => ({
      status: 'not_configured' as const,
      message: 'fixture browser disabled',
      checkedAt: null,
      latencyMs: null,
    }),
  };
}

async function startSampleApp(): Promise<SampleApp> {
  const server = createHttpServer((request, response) => {
    void handleSampleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function handleSampleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Cynos 官网验收样例</title></head>
<body><main><h1>Cynos 官网验收样例</h1>
<form id="login"><label>用户名<input aria-label="用户名" name="username"></label><label>密码<input aria-label="密码" type="password" name="password"></label><button type="submit">登录</button></form>
<form id="register"><label>注册邮箱<input aria-label="注册邮箱" name="email"></label><button type="submit">注册</button></form>
<p id="result" aria-live="polite"></p></main>
<script>
const result = document.querySelector('#result');
document.querySelector('#login').addEventListener('submit', async (event) => { event.preventDefault(); const response = await fetch('/api/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ok:true}) }); result.textContent = response.ok ? '登录成功' : '登录失败'; });
document.querySelector('#register').addEventListener('submit', async (event) => { event.preventDefault(); const response = await fetch('/api/register', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ok:true}) }); result.textContent = response.ok ? '注册成功' : '注册失败'; });
</script></body></html>`);
    return;
  }
  if (
    request.method === 'POST' &&
    (url.pathname === '/api/login' || url.pathname === '/api/register')
  ) {
    await readRequestBody(request);
    response.writeHead(url.pathname.endsWith('login') ? 200 : 201, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/api/failure') {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'synthetic product error' }));
    return;
  }
  if (url.pathname === '/api/blocked') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'synthetic environment blocked' }));
    return;
  }
  response.writeHead(404);
  response.end();
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeCompletedRun(reportDir: string, runId: string, report: string): Promise<void> {
  const directory = join(reportDir, 'completed', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'plan.md'), '# Plan\n无需场景测试。\n', 'utf8');
  await writeFile(join(directory, 'execution.md'), '# Execution\nfixture execution\n', 'utf8');
  await writeFile(join(directory, 'draft-report.md'), '# Draft\nfixture draft\n', 'utf8');
  await writeFile(join(directory, 'review.md'), '# Review\nfixture review\n', 'utf8');
  await writeFile(join(directory, 'report.md'), report, 'utf8');
}

async function writeSpecialRun(
  reportDir: string,
  runId: string,
  report: string,
  patch: string,
): Promise<void> {
  const directory = join(reportDir, 'completed', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.md'), report, 'utf8');
  await writeFile(join(directory, 'scenario-changes.patch'), patch, 'utf8');
}

async function readCompletedArtifacts(
  reportDir: string,
  runId: string,
): Promise<Record<string, string>> {
  const directory = join(reportDir, 'completed', runId);
  const names = [
    'plan.md',
    'execution.md',
    'draft-report.md',
    'review.md',
    'report.md',
    'scenario-changes.patch',
  ];
  const artifacts: Record<string, string> = {};
  for (const name of names) {
    try {
      artifacts[name] = await readFile(join(directory, name), 'utf8');
    } catch {
      // The special scenario review Run intentionally has only two files.
    }
  }
  return artifacts;
}

function reportMarkdown(
  runId: string,
  result: RunResult,
  withBug: boolean,
  bugKeys: string[] = [`BUG-${runId.slice(-3)}-001`],
  startedAt = '2026-08-30T00:00:00Z',
  finishedAt = '2026-08-30T00:01:00Z',
): string {
  const scenarioResults =
    result === 'passed' ? '[]' : `\n  - id: ${SAMPLE_SCENARIO_ID}\n    result: ${result}`;
  const bugs = withBug
    ? bugKeys
        .map(
          (key) =>
            `\n  - key: ${key}\n    title: fixture confirmed bug\n    scenario_ids:\n      - ${SAMPLE_SCENARIO_ID}\n    issue_action: create`,
        )
        .join('')
    : '[]';
  return `---
run_id: ${runId}
trigger: manual
base_commit: null
target_commit: ${runId === '01K00000000000000000000003' ? 'b'.repeat(40) : runId === '01K00000000000000000000004' ? 'c'.repeat(40) : runId === '01K00000000000000000000005' ? 'd'.repeat(40) : SAMPLE_TARGET}
included_commits: []
result: ${result}
started_at: ${startedAt}
finished_at: ${finishedAt}
scenario_results: ${scenarioResults}
confirmed_bugs: ${bugs}
---

# Fixture report

${result === 'passed' ? '无需场景测试。' : 'fixture evidence recorded.'}
`;
}

function scenarioMarkdown(id: string, description: string): string {
  return `---
id: ${id}
name: ${id} 场景
description: ${description}
status: approved
tags:
  - core
---

## 期望

${description}
`;
}

function unifiedPatch(oldPath: string, newPath: string, body: string): string {
  return `diff --git a/${oldPath} b/${newPath}
index 1111111..2222222 100644
--- a/${oldPath}
+++ b/${newPath}
@@ -1,1 +1,1 @@
-old
+${body}
`;
}

function reportForContext(systemPrompt: string, targetCommit: string): string {
  const runId = systemPrompt.match(/"runId"\s*:\s*"([^"]+)"/)?.[1] ?? SAMPLE_RUN_ID;
  const trigger = systemPrompt.match(/"trigger"\s*:\s*"([^"]+)"/)?.[1] ?? 'manual';
  const baseCommit = systemPrompt.match(/"baseCommit"\s*:\s*(null|"[^"]+")/)?.[1] ?? 'null';
  return `---
run_id: ${runId}
trigger: ${trigger}
base_commit: ${baseCommit === 'null' ? 'null' : baseCommit.replaceAll('"', '')}
target_commit: ${targetCommit}
included_commits: []
result: passed
started_at: 2026-08-30T00:00:00Z
finished_at: 2026-08-30T00:01:00Z
scenario_results: []
confirmed_bugs: []
---

# Final report

无需场景测试：独立 Reviewer 已确认本批无产品行为影响。
`;
}

function extractTarget(systemPrompt: string): string {
  return systemPrompt.match(/"targetCommit"\s*:\s*"([^"]+)"/)?.[1] ?? SAMPLE_TARGET;
}

async function invokeTool(
  input: AgentSessionInput,
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = input.customTools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing fixture tool ${name}`);
  return tool.execute(
    'phase9-fixture-call',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

function toolText(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => ('text' in item ? item.text : '')).join('');
}

function firstCookie(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(';', 1)[0] ?? '';
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

async function runCommand(
  executable: string,
  args: string[],
  overrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, args, {
    cwd: process.cwd(),
    env: { ...sanitizedEnvironment(process.env), ...overrides },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function npmCommand(): { executable: string; prefix: string[] } {
  if (process.platform !== 'win32') return { executable: 'npm', prefix: [] };
  const npmScript = process.env.npm_execpath;
  return npmScript
    ? { executable: process.execPath, prefix: [npmScript] }
    : { executable: 'npm.cmd', prefix: [] };
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      /(?:PASSWORD|TOKEN|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)/i.test(key) ||
      /^(?:GITHUB|DEEPSEEK|OSS)_/i.test(key)
    ) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

function commandErrorDetails(error: unknown): string {
  const details = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [details.message, details.stdout, details.stderr].filter(Boolean).join('\n');
}

function summarizeOutput(value: string): string {
  const lines = redact(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join(' | ').slice(-1_000) || 'completed';
}

function redact(value: string): string {
  let result = value;
  for (const secret of [
    process.env.LUOWANG_ADMIN_PASSWORD,
    process.env.LUOWANG_MASTER_KEY,
    process.env.GITHUB_TOKEN,
    process.env.DEEPSEEK_API_KEY,
    process.env.OSS_ACCESS_KEY_SECRET,
  ]) {
    if (secret) result = result.split(secret).join('<redacted>');
  }
  return result.replace(
    /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,}]+/gi,
    '$1<redacted>',
  );
}

function safeErrorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function acceptanceTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function renderMarkdownReport(report: {
  status: string;
  targetProject: string;
  startedAt: string;
  finishedAt: string;
  cases: AcceptanceCase[];
  commands: CommandEvidence[];
  liveSmoke: { status: string; reason?: string };
}): string {
  const caseLines = report.cases
    .map(
      (item) => `| ${item.id} | ${item.status} | ${item.title} | ${item.evidence.join('<br>')} |`,
    )
    .join('\n');
  const commandLines = report.commands
    .map(
      (item) =>
        `| ${item.status} | \`${item.command}\` | ${item.durationMs} ms | ${item.summary} |`,
    )
    .join('\n');
  return `# LuoWang Phase 9 acceptance report

- Status: **${report.status}**
- Target project: \`${report.targetProject}\`
- Started: ${report.startedAt}
- Finished: ${report.finishedAt}
- Mode: local fixture; temporary repository and sample application are removed after the run
- Live smoke: **${report.liveSmoke.status}**${report.liveSmoke.reason ? ` — ${report.liveSmoke.reason}` : ''}

## AC matrix

| AC | Status | Description | Evidence |
|---|---|---|---|
${caseLines}

## Commands

| Status | Command | Duration | Summary |
|---|---|---:|---|
${commandLines}

真实 GitHub、DeepSeek、Playwright MCP、OSS 和非生产测试环境的外部 smoke 需要显式凭据和测试环境；未启用时保持 blocked。
`;
}

await main();
