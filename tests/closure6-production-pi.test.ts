import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import { loadConfig } from '../src/server/config.js';
import { createConfigurationStore } from '../src/server/configuration.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { createRepositoryService } from '../src/server/repository/service.js';
import type { RepositoryService } from '../src/server/repository/service.js';
import { createRunArchiver } from '../src/server/runs/archiver.js';
import { createControlledCommandRunner } from '../src/server/runs/command-runner.js';
import { createRunOrchestrator } from '../src/server/runs/orchestrator.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import { createRunStore, type RunStore } from '../src/server/runs/store.js';
import { createSecretStore } from '../src/server/security/secret-store.js';
import {
  startLocalModelProtocol,
  type LocalModelBehavior,
  type LocalModelProtocol,
} from './acceptance/local-model-protocol.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Closure 6 local production Pi path', () => {
  it('runs an ordinary four-session Run through createAgentSession and custom tool loops', async () => {
    const context = await createContext('review-all', 'normal');
    const result = await context.orchestrator.run({
      request: '验证固定 target 的生产 Pi Session 工件交接',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.deepEqual(Object.keys(result.artifacts).sort(), [
      'draft-report.md',
      'execution.md',
      'plan.md',
      'report.md',
      'review.md',
    ]);
    assertSessionSequence(context.model, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.ok(context.model.requestCount > context.model.sessions.length);
    assert.equal(context.model.sessions[0]?.model, context.model.sessions[3]?.model);
    assert.notDeepEqual(context.model.sessions[0]?.tools, context.model.sessions[3]?.tools);
    assert.match(result.artifacts['report.md'] ?? '', /Reviewer 已独立确认/);
  });

  it('runs unfamiliar-project direct initialization through six isolated production Pi Sessions', async () => {
    const context = await createContext('autonomous', 'normal');
    const result = await context.orchestrator.run({
      request: '初始化陌生项目并直接新增一个高价值场景',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assertSessionSequence(context.model, [
      'main-a',
      'runner',
      'main-a',
      'runner',
      'reviewer',
      'main-b',
    ]);
    assert.equal(new Set(context.model.sessions.map((session) => session.id)).size, 6);
    assert.deepEqual(Object.keys(result.artifacts).sort(), [
      'draft-report.md',
      'execution.md',
      'plan.md',
      'report.md',
      'review.md',
      'scenario-changes.patch',
    ]);
    assert.match(result.artifacts['scenario-changes.patch'] ?? '', /ONBOARD-SMOKE-001/);
    assert.equal(context.model.sessions.filter((session) => session.role === 'main-a').length, 2);
    assert.equal(context.model.sessions.filter((session) => session.role === 'runner').length, 2);
  });

  it('stops review-required initialization after three Sessions and selectively finalizes two artifacts', async () => {
    const context = await createContext('review-all', 'normal');
    const result = await context.orchestrator.run({
      request: '初始化陌生项目但场景变更必须人工审核',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'blocked');
    assertSessionSequence(context.model, ['main-a', 'runner', 'main-a']);
    assert.deepEqual(Object.keys(result.artifacts).sort(), ['report.md', 'scenario-changes.patch']);
    assert.match(result.artifacts['report.md'] ?? '', /等待场景变更人工审核/);
    assert.equal(
      context.model.sessions.some((session) => session.role === 'reviewer'),
      false,
    );
    assert.equal(
      context.model.sessions.some((session) => session.role === 'main-b'),
      false,
    );

    const publicationModes: string[] = [];
    const archiveRepository = {
      validateScenarioPatch: (target: string, patch: string) =>
        context.repository.validateScenarioPatch(target, patch),
      publishScenarioChanges: async (
        _runId: string,
        _patch: string,
        mode: 'direct' | 'pull-request',
      ) => {
        publicationModes.push(mode);
        return {
          status: 'pull_request' as const,
          commitSha: 'f'.repeat(40),
          scenarioBranchHead: result.targetCommit,
          scenarioPrUrl: 'https://github.com/example/target/pull/17',
        };
      },
    } as unknown as RepositoryService;
    const archiver = createRunArchiver({
      database: context.database.sqlite,
      reportDir: context.reportDir,
      repository: archiveRepository,
      runStore: context.runStore,
      logger: pino({ level: 'silent' }),
    });
    const archived = await archiver.archive(result.runId);
    assert.equal(archived.status, 'completed', JSON.stringify(archived));
    assert.equal(archived.scenarioStatus, 'pull_request');
    assert.equal(archived.scenarioPrUrl, 'https://github.com/example/target/pull/17');
    assert.deepEqual(publicationModes, ['pull-request']);
  });

  it('keeps finalization revisions blocked when no new Runner Session re-executes them', async () => {
    const context = await createContext('autonomous', 'revise-final-patch');
    const result = await context.orchestrator.run({
      request: '初始化后按 Reviewer 意见修订候选场景但不重跑',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'blocked');
    assertSessionSequence(context.model, [
      'main-a',
      'runner',
      'main-a',
      'runner',
      'reviewer',
      'main-b',
    ]);
    assert.match(result.artifacts['scenario-changes.patch'] ?? '', /ONBOARD-REVISED-001/);
    assert.match(result.artifacts['report.md'] ?? '', /修订内容未重新执行/);
    assert.equal(context.model.sessions.filter((session) => session.role === 'runner').length, 2);
  });

  it('fails closed when the local model requests a tool outside the production allowlist', async () => {
    const context = await createContext('review-all', 'invalid-tool');
    const result = await context.orchestrator.run({
      request: '模型越权工具调用必须失败',
      trigger: 'manual',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.result, null);
    assert.deepEqual(result.artifacts, {});
    assert.equal(context.model.sessions.length, 1);
    assert.equal(context.model.sessions[0]?.disposed, true);
  });
});

interface ProductionContext {
  orchestrator: ReturnType<typeof createRunOrchestrator>;
  model: LocalModelProtocol;
  database: ReturnType<typeof initializeDatabase>;
  reportDir: string;
  repository: ReturnType<typeof createRepositoryService>;
  runStore: RunStore;
}

async function createContext(
  scenarioMode: 'autonomous' | 'review-all',
  behavior: LocalModelBehavior,
): Promise<ProductionContext> {
  const root = await mkdtemp(join(tmpdir(), 'luowang-closure6-'));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const clone = join(root, 'clone');
  const dataDir = join(root, 'data');
  const reportDir = join(dataDir, 'report');
  await mkdir(source, { recursive: true });
  await git(['init', '--bare', remote], root);
  await git(['init', '--initial-branch=main'], source);
  await git(['config', 'user.name', 'LuoWang Closure 6'], source);
  await git(['config', 'user.email', 'luowang-closure6@example.test'], source);
  await writeFile(join(source, 'README.md'), '# Local Pi target\n', 'utf8');
  await git(['add', 'README.md'], source);
  await git(['commit', '-m', 'fixture: initialize target'], source);
  await git(['remote', 'add', 'origin', remote], source);
  await git(['push', '-u', 'origin', 'main'], source);
  await git(['checkout', '-b', 'scenario-testing'], source);
  await git(['push', '-u', 'origin', 'scenario-testing'], source);

  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: clone,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_ADMIN_PASSWORD: 'closure6-local-admin-password!',
    LUOWANG_MASTER_KEY: 'closure6-local-master-key',
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateRepository({
    repository: remote,
    scenarioBranch: 'scenario-testing',
    scenarioMode,
    baseUrl: 'http://127.0.0.1:4173',
  });
  configuration.updateHarness({
    provider: 'luowang-local',
    agents: {
      main: { model: 'deterministic-tool-model', thinking: 'off' },
      runner: { model: 'deterministic-tool-model', thinking: 'off' },
      reviewer: { model: 'deterministic-tool-model', thinking: 'off' },
    },
    mcp: { enabled: false },
  });
  const secretStore = createSecretStore(database.sqlite, config.masterKey);
  secretStore.set('testUsername', 'local-synthetic-user');
  secretStore.set('testPassword', 'local-synthetic-password');
  const repository = createRepositoryService(database.sqlite, configuration, secretStore, {
    repoDir: config.repoDir,
    allowLocalRepository: true,
  });
  const runStore = createRunStore(database.sqlite);
  const model = await startLocalModelProtocol(behavior);
  cleanup.push(() => model.close());
  const orchestrator = createRunOrchestrator({
    configuration,
    repository,
    reportDir,
    secretStore,
    provider: {} as ProviderAdapter,
    sessions: model.sessionFactory,
    commandRunner: createControlledCommandRunner(process.env),
    runStore,
    logger: pino({ level: 'silent' }),
    browser: disabledBrowser(),
  });
  return { orchestrator, model, database, reportDir, repository, runStore };
}

function assertSessionSequence(model: LocalModelProtocol, expected: string[]): void {
  assert.deepEqual(
    model.sessions.map((session) => session.role),
    expected,
  );
  assert.equal(
    model.sessions.every((session) => session.disposed),
    true,
  );
  assert.equal(
    model.sessions.every((session) => session.prompts.length === 1),
    true,
  );
  assert.equal(new Set(model.sessions.map((session) => session.id)).size, expected.length);
  if (model.sessions.some((session) => session.roleInstructionVersions.length > 0)) {
    const roleIds: Record<string, string> = {
      'main-planning': 'main-planning',
      'runner-execution': 'runner-execution',
      'reviewer-audit': 'reviewer-audit',
      'main-finalization': 'main-finalization',
    };
    for (const session of model.sessions) {
      assert.ok(session.sessionKind, 'integrated production Session must expose its session kind');
      const ids = session.roleInstructionVersions.map((version) => version.id);
      const initialization = session.prompts.some((prompt) =>
        /"initialization"\s*:\s*true/.test(prompt),
      );
      const expectsInitialization =
        initialization &&
        (session.sessionKind === 'main-planning' || session.sessionKind === 'main-finalization');
      const expectedIds = [
        'common',
        roleIds[session.sessionKind as string] as string,
        ...(expectsInitialization ? ['scenario-initialization'] : []),
      ];
      assert.deepEqual(ids, expectedIds);
      assert.doesNotMatch(session.systemPrompt, /"initialization"\s*:/);
      assert.equal(
        session.roleInstructionVersions.every(
          (version) =>
            version.formatVersion !== '' &&
            version.applicationVersion !== '' &&
            /^[0-9a-f]{64}$/.test(version.sha256),
        ),
        true,
      );
      for (const roleId of [
        'common',
        'main-planning',
        'runner-execution',
        'reviewer-audit',
        'main-finalization',
        'scenario-initialization',
      ]) {
        assert.equal(
          session.systemPrompt.includes(`luowang-role-id: ${roleId};`),
          expectedIds.includes(roleId),
          `${session.sessionKind} system prompt role marker mismatch: ${roleId}`,
        );
      }
    }
  }
}

function disabledBrowser() {
  return {
    isEnabled: () => false,
    serverDefinition: () => ({
      command: 'node',
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
      message: '本地验收不需要浏览器',
      checkedAt: null,
      latencyMs: null,
    }),
  };
}

function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}
