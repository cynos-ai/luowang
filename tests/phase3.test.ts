import { strict as assert } from 'node:assert';
import { localEvidenceTransport } from './acceptance/local-evidence.js';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pino from 'pino';
import { afterEach, describe, it } from 'vitest';

import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createConfigurationStore } from '../src/server/configuration.js';
import { DEFAULT_VERSION, loadConfig } from '../src/server/config.js';
import { initializeDatabase } from '../src/server/db/migrate.js';
import { createRunOrchestrator, type RunOrchestrator } from '../src/server/runs/orchestrator.js';
import { createControlledCommandRunner } from '../src/server/runs/command-runner.js';
import type { ProviderAdapter } from '../src/server/runs/provider.js';
import type { AgentSessionFactory, AgentSessionInput } from '../src/server/runs/types.js';
import { RunWorkspace } from '../src/server/runs/workspace.js';
import { parseExecutionScenarioPlan } from '../src/server/runs/execution-plan.js';
import { parseScenarioMarkdown } from '../src/server/repository/markdown.js';
import type { SelectedScenarioSnapshot } from '../src/server/runs/selected-scenarios.js';
import { createRepositoryService } from '../src/server/repository/service.js';
import type { RepositoryIndexer } from '../src/server/repository/indexer.js';
import type { SecretStore } from '../src/server/security/secret-store.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe('Phase 3 agent run', () => {
  it('delivers only selected original definitions to Reviewer, not final Main', async () => {
    const fixture = await createGitFixture(true);
    const context = await createRunContext(fixture, ['passed'], undefined, {
      scenarioIds: ['AUTH-LOGIN-001'],
      checkpoint: async () => undefined,
    });
    const result = await context.orchestrator.run({
      request: '验证选中场景原文',
      trigger: 'manual',
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    const reviewer = context.sessions.inputs.find((input) => input.role === 'reviewer')!;
    assert.match(reviewer.userMessage, /登录状态恢复/);
    assert.ok(!reviewer.userMessage.includes('安全退出'));
    assert.ok(!reviewer.customTools.some((tool) => tool.name === 'read_working_scenario'));
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.deepEqual(context.sessions.disposed, context.sessions.created);
  });

  it.each(['oversize', 'secret-failure'] as const)(
    'keeps a normal Run blocked when original input is unavailable: %s',
    async (failure) => {
      const fixture = await createGitFixture(true);
      if (failure === 'oversize') {
        await writeFile(
          join(fixture.sourceDir, 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md'),
          scenarioMarkdown('AUTH-LOGIN-001', '登录状态恢复') + 'x'.repeat(256 * 1024),
        );
        await commitAndPush(fixture.sourceDir, 'oversized scenario fixture', 'scenario-testing');
      }
      const context = await createRunContext(
        fixture,
        ['passed'],
        undefined,
        { scenarioIds: ['AUTH-LOGIN-001'], checkpoint: async () => undefined },
        '',
        '\n',
        false,
        false,
        failure === 'secret-failure'
          ? {
              secretStore: {
                get: () => {
                  throw new Error('private-secret-store-diagnostic');
                },
              } as unknown as SecretStore,
            }
          : {},
      );
      const create = context.sessions.create.bind(context.sessions);
      context.sessions.create = async (input) => {
        const session = await create(input);
        if (input.role !== 'reviewer') return session;
        return {
          ...session,
          prompt: async () => {
            const data = JSON.parse(input.userMessage.slice(input.userMessage.indexOf('{')));
            assert.equal(data.selectedScenarioSnapshot, null);
            assert.ok(!input.userMessage.includes('private-secret-store-diagnostic'));
            for (const name of ['plan.md', 'execution.md'])
              await invokeTool(input, 'read_run_artifact', { name });
            await invokeTool(input, 'write_review', {
              content: '# Review\n必要原文不可用，blocked。\n',
            });
          },
        };
      };
      const result = await context.orchestrator.run({
        request: '验证输入失败边界',
        trigger: 'manual',
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.result, 'blocked', JSON.stringify(result));
      assert.ok(result.blockingReasons?.some((reason) => reason.includes('选定场景原文')));
    },
  );

  it.each(['passed', 'failed', 'blocked'] as const)(
    'cleans after final Main disposal without changing %s',
    async (outcome) => {
      const { createTestDataManager } = await import('../src/server/runs/test-data.js');
      let calls = 0;
      const manager = createTestDataManager({
        cleanupAdapter: {
          id: 'late-cleanup',
          async cleanupAndVerify() {
            calls++;
            assert.deepEqual(context.sessions.disposed, ['main-a', 'runner', 'reviewer', 'main-b']);
            return { absent: false, content: 'still present', exitCode: 0 };
          },
        },
      });
      const fixture = await createGitFixture(outcome === 'blocked');
      const context: TestContext = await createRunContext(
        fixture,
        [outcome],
        async () => {
          const runner = context.sessions.inputs.find((input) => input.role === 'runner')!;
          const runId = parsePromptContext(runner.userMessage).runId;
          await manager.register(runId, { id: `${manager.prefix(runId)}temporary-account` });
        },
        outcome === 'blocked'
          ? { scenarioIds: ['AUTH-LOGIN-001'], checkpoint: async () => undefined }
          : undefined,
        '',
        '\n',
        false,
        false,
        { testData: manager },
      );
      const result = await context.orchestrator.run({
        request: '验证单向交接与收尾',
        trigger: 'manual',
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.result, outcome);
      assert.equal(calls, 1);
      assert.match(
        result.artifacts['report.md']!,
        /Harness 清理收尾[\s\S]*未完成[\s\S]*temporary-account/,
      );
      assert.ok(!result.blockingReasons?.some((reason) => reason.includes('清理')));
      if (outcome === 'failed') assert.match(result.artifacts['report.md']!, /BUG-LOGIN-001/);
    },
  );

  it('cleans registered data after Runner failure and preserves the original error', async () => {
    const { createTestDataManager } = await import('../src/server/runs/test-data.js');
    let calls = 0;
    const manager = createTestDataManager({
      cleanupAdapter: {
        id: 'exception-cleanup',
        async cleanupAndVerify() {
          calls++;
          throw new Error('token=private-fixture-secret');
        },
      },
    });
    const context: TestContext = await createRunContext(
      await createGitFixture(),
      ['passed'],
      async () => {
        const runId = parsePromptContext(
          context.sessions.inputs.find((input) => input.role === 'runner')!.userMessage,
        ).runId;
        await manager.register(runId, { id: `${manager.prefix(runId)}temporary-account` });
        throw new Error('Runner stopped');
      },
      undefined,
      '',
      '\n',
      false,
      false,
      { testData: manager },
    );
    const result = await context.orchestrator.run({ request: '异常仍收尾', trigger: 'manual' });
    assert.equal(result.status, 'failed');
    assert.equal(result.result, null);
    assert.equal(calls, 1);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner']);
    assert.match(result.artifacts['execution.md']!, /temporary-account/);
    assert.equal(result.artifacts['report.md'], undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-secret/);
  });
  it('runs four independent sessions, fixes target SHA, writes four artifacts, and atomically completes', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);

    const result = await context.orchestrator.run({
      request: '验证最新版本中无需 UI 场景的文档变化',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.equal(result.baseCommit, null);
    assert.equal(result.targetCommit, fixture.initialHead);
    assert.deepEqual(result.includedCommits, []);
    assert.deepEqual(Object.keys(result.artifacts).sort(), [
      'execution.md',
      'plan.md',
      'report.md',
      'review.md',
    ]);
    assert.match(result.artifacts['plan.md'] ?? '', /无需场景测试/);
    assert.match(result.artifacts['review.md'] ?? '', /无需场景测试/);
    assert.equal(await pathExists(join(context.reportDir, 'running', result.runId)), false);
    assert.equal(await pathExists(join(context.reportDir, 'completed', result.runId)), true);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.deepEqual(context.sessions.disposed, ['main-a', 'runner', 'reviewer', 'main-b']);
    assert.equal(new Set(context.sessions.sessionObjects).size, 4);
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.sessionKind),
      ['main-planning', 'runner-execution', 'reviewer-audit', 'main-finalization'],
    );
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.roleInstructionVersions.map((item) => item.id)),
      [
        ['common', 'main-planning'],
        ['common', 'runner-execution'],
        ['common', 'reviewer-audit'],
        ['common', 'main-finalization'],
      ],
    );
    assert.deepEqual(
      context.sessions.messages,
      context.sessions.inputs.map((input) => input.userMessage),
    );
    assert.equal(
      context.sessions.inputs[0]?.config.model,
      context.sessions.inputs[3]?.config.model,
    );
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.config.thinking),
      ['low', 'off', 'low', 'off'],
    );
    for (const input of context.sessions.inputs) {
      assert.match(input.systemPrompt, /luowang-role-id: common/);
      assert.doesNotMatch(input.userMessage, /luowang-role-id:/);
      assert.doesNotMatch(input.systemPrompt, new RegExp(fixture.initialHead));
      assert.match(input.userMessage, new RegExp(fixture.initialHead));
      assert.equal(
        input.customTools.some((tool) => tool.name === 'read'),
        false,
      );
      for (const version of input.roleInstructionVersions) {
        assert.match(version.sha256, /^[a-f0-9]{64}$/);
        assert.equal(version.applicationVersion, DEFAULT_VERSION);
        assert.equal(version.formatVersion, '1');
      }
    }
    assert.match(context.sessions.inputs[0]?.systemPrompt ?? '', /luowang-role-id: main-planning/);
    assert.doesNotMatch(context.sessions.inputs[0]?.systemPrompt ?? '', /runner-execution/);
    assert.match(
      context.sessions.inputs[1]?.systemPrompt ?? '',
      /luowang-role-id: runner-execution/,
    );
    assert.match(context.sessions.inputs[2]?.systemPrompt ?? '', /luowang-role-id: reviewer-audit/);
    assert.match(
      context.sessions.inputs[3]?.systemPrompt ?? '',
      /luowang-role-id: main-finalization/,
    );
    const mainToolContext = commandText(
      await invokeTool(context.sessions.inputs[0] as AgentSessionInput, 'get_run_context', {}),
    );
    const runnerToolContext = commandText(
      await invokeTool(context.sessions.inputs[1] as AgentSessionInput, 'get_run_context', {}),
    );
    assert.match(mainToolContext, /historyIssuesAvailable/);
    assert.match(mainToolContext, /indexedReports/);
    assert.doesNotMatch(runnerToolContext, /historyIssues|indexedReports|indexedScenarios/);
  });

  it('moves one recognizable final report frontmatter block before an agent preamble', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '# Final Report\n\n',
    );

    const result = await context.orchestrator.run({
      request: '验证最终报告 frontmatter 位置',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.match(result.artifacts['report.md'] ?? '', /^---\nrun_id:/);
    assert.match(result.artifacts['report.md'] ?? '', /# Final Report/);
  });

  it('preserves CRLF content while moving final report frontmatter', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '# Final Report\n\n',
      '\r\n',
    );

    const result = await context.orchestrator.run({
      request: '验证 CRLF 最终报告 frontmatter 位置',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    const report = result.artifacts['report.md'] ?? '';
    assert.match(report, /^---\r\nrun_id:/);
    assert.equal(report.replaceAll('\r\n', '').includes('\n'), false);
  });

  it('rejects malformed report writes so the same Session can correct them', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '',
      '\n',
      true,
    );

    const result = await context.orchestrator.run({
      request: '验证最终报告写入时校验与重试',
      trigger: 'manual',
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.result, 'passed');
    assert.match(result.artifacts['report.md'] ?? '', /^---\nrun_id:/);
  });

  it('rejects malformed scenario patches so the same Session can correct them', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed', 'passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      true,
    );

    const result = await context.orchestrator.run({
      request: '初始化并验证候选场景 patch 写入时校验与重试',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.match(result.artifacts['scenario-changes.patch'] ?? '', /^diff --git /);
    assert.doesNotMatch(result.artifacts['scenario-changes.patch'] ?? '', /not a git patch/);
    assert.deepEqual(context.sessions.created, [
      'main-a',
      'runner',
      'main-a',
      'runner',
      'reviewer',
      'main-b',
    ]);
  });

  it('does not reuse the static plan when candidate plan writing fails', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      false,
      {
        candidate: { planWriteFailureOnly: true },
      },
    );

    const result = await context.orchestrator.run({
      request: '初始化候选计划写入失败时不得继续使用旧计划',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.result, null);
    assert.match(result.errorMessage ?? '', /未成功更新 plan\.md/);
    assert.doesNotMatch(result.artifacts['plan.md'] ?? '', /INIT-HOME-001/);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'main-a']);
  });

  it('does not continue initialization after candidate patch validation fails', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      false,
      {
        candidate: { patchValidationFailureOnly: true },
      },
    );

    const result = await context.orchestrator.run({
      request: '初始化候选场景 patch 校验失败时不得继续验证',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.result, null);
    assert.match(result.errorMessage ?? '', /patch 未成功写入/);
    assert.equal(result.artifacts['scenario-changes.patch'], undefined);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'main-a']);
  });

  it('fails with the plan/worktree mismatch instead of executing an old scenario set', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      false,
      {
        candidate: {
          planScenarioId: 'INIT-MISMATCH-001',
          patchScenarioId: 'INIT-HOME-001',
        },
      },
    );

    const result = await context.orchestrator.run({
      request: '初始化候选计划与工作场景不一致时必须失败',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.result, null);
    assert.match(result.errorMessage ?? '', /未知场景 ID：INIT-MISMATCH-001/);
    assert.deepEqual(context.sessions.created, ['main-a', 'runner', 'main-a']);
    assert.equal(context.sessions.created.includes('reviewer'), false);
  });

  it('repairs a rejected candidate plan inside the same Main Session before Runner starts', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(
      fixture,
      ['passed', 'passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      false,
      {
        candidate: { repairPlanOnce: true },
      },
    );
    const result = await context.orchestrator.run({
      request: '修正候选清单后再验证',
      trigger: 'manual',
      initialization: true,
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(context.sessions.created, [
      'main-a',
      'runner',
      'main-a',
      'runner',
      'reviewer',
      'main-b',
    ]);
    assert.equal(
      context.sessions.messages.filter((message) => message.includes('规划工件联合校验失败'))
        .length,
      1,
    );
    assert.doesNotMatch(result.artifacts['plan.md'] ?? '', /INIT-MISSING-001/);
    assert.match(result.artifacts['plan.md'] ?? '', /INIT-HOME-001/);
  });

  it('isolates repeated Main and Runner Sessions during initialization', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed', 'passed']);

    const result = await context.orchestrator.run({
      request: '初始化陌生项目的长期场景',
      trigger: 'manual',
      initialization: true,
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(
      context.sessions.created,
      ['main-a', 'runner', 'main-a', 'runner', 'reviewer', 'main-b'],
      JSON.stringify(result),
    );
    assert.equal(new Set(context.sessions.sessionObjects).size, 6);
    assert.deepEqual(
      context.sessions.inputs.map((input) => input.sessionKind),
      [
        'main-planning',
        'runner-execution',
        'main-planning',
        'runner-execution',
        'reviewer-audit',
        'main-finalization',
      ],
    );
    for (const index of [0, 2, 5]) {
      assert.equal(
        context.sessions.inputs[index]?.roleInstructionVersions.some(
          (item) => item.id === 'scenario-initialization',
        ),
        true,
      );
      assert.equal(
        context.sessions.inputs[index]?.config.model,
        context.sessions.inputs[0]?.config.model,
      );
      assert.equal(context.sessions.inputs[index]?.config.thinking, index === 5 ? 'off' : 'low');
    }
    for (const index of [1, 3, 4]) {
      assert.equal(
        context.sessions.inputs[index]?.roleInstructionVersions.some(
          (item) => item.id === 'scenario-initialization',
        ),
        false,
      );
    }
    assert.deepEqual(context.sessions.inputs[1]?.config, context.sessions.inputs[3]?.config);
    assert.notEqual(context.sessions.messages[0], context.sessions.messages[2]);
    assert.notEqual(context.sessions.messages[1], context.sessions.messages[3]);
  });

  it('rejects a second start while the first Run is still being prepared', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);

    const firstStart = context.orchestrator.start({
      request: '执行一次人工回归',
      trigger: 'manual',
    });
    await assert.rejects(
      () =>
        context.orchestrator.start({
          request: '不应并发执行',
          trigger: 'api',
        }),
      (error: unknown) => error instanceof Error && error.message.includes('已有一个 Run 正在执行'),
    );
    const first = await firstStart;
    const completed = await context.orchestrator.wait(first.runId);
    assert.equal(completed?.status, 'completed', JSON.stringify(completed));
  });

  it('passes read-only historical Issue context to Main planning', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed']);
    context.repository.listIssues = async () => [
      {
        number: 42,
        title: '历史登录问题',
        state: 'open',
        url: 'https://github.com/example/fixture/issues/42',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    ];

    await context.orchestrator.run({
      request: '结合历史 Issue 复核文档变化',
      trigger: 'manual',
    });

    assert.equal(context.sessions.inputs[0]?.role, 'main-a');
    assert.doesNotMatch(context.sessions.inputs[0]?.systemPrompt ?? '', /历史登录问题/);
    assert.match(context.sessions.inputs[0]?.userMessage ?? '', /历史登录问题/);
    assert.match(context.sessions.inputs[0]?.userMessage ?? '', /historyIssuesAvailable/);
    for (const input of context.sessions.inputs.slice(1)) {
      assert.doesNotMatch(input.userMessage, /历史登录问题/);
      assert.doesNotMatch(input.userMessage, /historyIssues/);
    }
    const runnerToolContext = commandText(
      await invokeTool(context.sessions.inputs[1] as AgentSessionInput, 'get_run_context', {}),
    );
    assert.doesNotMatch(runnerToolContext, /历史登录问题|historyIssues|indexedReports/);
    const [planning, runner, reviewer, finalization] = context.sessions.inputs;
    assert.ok(planning?.customTools.some((tool) => tool.name === 'query_run_history'));
    assert.equal(
      planning?.customTools.some((tool) => tool.name === 'query_issue_candidates'),
      false,
    );
    for (const input of [runner, reviewer]) {
      assert.equal(
        input?.customTools.some((tool) => tool.name === 'query_run_history'),
        false,
      );
      assert.equal(
        input?.customTools.some((tool) => tool.name === 'query_issue_candidates'),
        false,
      );
    }
    assert.ok(finalization?.customTools.some((tool) => tool.name === 'query_issue_candidates'));
    assert.equal(
      finalization?.customTools.some((tool) => tool.name === 'query_run_history'),
      false,
    );
  });

  it('passes scenario descriptions, index freshness, language, and labels only to Main', async () => {
    const fixture = await createGitFixture();
    const indexer = {
      sync: async () => {
        throw new Error('not used');
      },
      listScenarios: () => [
        {
          id: 'AUTH-LOGIN-001',
          path: 'docs/scenario-testing/scenarios/AUTH-LOGIN-001.md',
          name: '登录状态恢复',
          description: '验证刷新后的登录状态保持。',
          status: 'approved' as const,
          tags: ['core'],
          content: 'not injected',
          commitSha: fixture.initialHead,
          indexedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
      getScenario: () => null,
      listReports: () => [],
      getReport: () => null,
      indexState: () => ({
        commitSha: fixture.initialHead,
        syncedAt: '2026-09-05T00:00:00.000Z',
        errors: [],
      }),
    } satisfies RepositoryIndexer;
    const context = await createRunContext(
      fixture,
      ['passed'],
      undefined,
      undefined,
      '',
      '\n',
      false,
      false,
      {
        indexer,
      },
    );
    context.configuration.updateRepository({ scenarioLabels: ['core', 'security'] });
    const result = await context.orchestrator.run({
      request: '验证 Main 规划上下文中的场景索引摘要',
      trigger: 'manual',
    });

    assert.equal(result.result, 'passed', JSON.stringify(result));
    const mainInput = context.sessions.inputs[0] as AgentSessionInput;
    const runnerInput = context.sessions.inputs[1] as AgentSessionInput;
    const mainContext = commandText(await invokeTool(mainInput, 'get_run_context', {}));
    assert.match(mainContext, /验证刷新后的登录状态保持/);
    assert.match(mainContext, new RegExp(`"indexCommit":"${fixture.initialHead}"`));
    assert.match(mainContext, /"scenarioLanguage":"zh-CN"/);
    assert.match(mainContext, /"scenarioLabels":\["core","security"\]/);
    assert.match(mainContext, /"stale":false/);
    assert.equal(
      mainInput.customTools.some((tool) => tool.name === 'list_target_changes'),
      true,
    );
    assert.equal(
      mainInput.customTools.some((tool) => tool.name === 'read_target_diff'),
      true,
    );
    assert.equal(
      mainInput.customTools.some((tool) => tool.name === 'read_target_file_version'),
      true,
    );
    assert.equal(
      runnerInput.customTools.some((tool) => tool.name === 'list_target_changes'),
      false,
    );
    assert.equal(
      runnerInput.customTools.some((tool) => tool.name === 'read_target_diff'),
      false,
    );
  });

  it('rejects sensitive rename endpoints through Main diff tools', async () => {
    const fixture = await createGitFixture();
    const common = Array.from({ length: 40 }, (_, i) => `ordinary line ${i}\n`).join('');
    await writeFile(
      join(fixture.sourceDir, 'credentials.txt'),
      common + 'SYNTHETIC_PRIVATE_VALUE\n',
    );
    await writeFile(join(fixture.sourceDir, 'public-old.txt'), common + 'ordinary\n');
    await commitAndPush(fixture.sourceDir, 'base for rename checks', 'scenario-testing');
    const context = await createRunContext(fixture, ['passed']);
    assert.equal(
      (await context.orchestrator.run({ request: 'base', trigger: 'manual' })).result,
      'passed',
    );
    await git(['mv', 'credentials.txt', 'public-new.txt'], fixture.sourceDir);
    await git(['mv', 'public-old.txt', 'secret-new.txt'], fixture.sourceDir);
    await writeFile(join(fixture.sourceDir, 'public-new.txt'), common + 'replacement\n');
    await commitAndPush(fixture.sourceDir, 'rename checks', 'scenario-testing');
    assert.equal(
      (await context.orchestrator.run({ request: 'target', trigger: 'manual' })).result,
      'passed',
    );
    const main = context.sessions.inputs[4] as AgentSessionInput;
    for (const path of ['public-new.txt', 'credentials.txt', 'public-old.txt', 'secret-new.txt']) {
      const response = commandText(await invokeTool(main, 'read_target_diff', { path }));
      assert.match(response, /"status":"unreadable"/);
      assert.doesNotMatch(response, /SYNTHETIC_PRIVATE_VALUE/);
    }
  });

  it('publishes a real two-scenario Runner progression from 0/2 to 2/2', async () => {
    const fixture = await createGitFixture(true);
    const gate = new ProgressGate();
    const scenarioIds = ['AUTH-LOGIN-001', 'AUTH-LOGOUT-001'];
    const context = await createRunContext(fixture, ['passed'], undefined, {
      scenarioIds,
      checkpoint: (name) => gate.checkpoint(name),
    });

    const started = await context.orchestrator.start({
      request: '顺序执行登录与退出场景',
      trigger: 'manual',
    });

    await assertProgress(gate, context.orchestrator, 'declared', null, 0, 2);
    await assertProgress(
      gate,
      context.orchestrator,
      'started:AUTH-LOGIN-001',
      'AUTH-LOGIN-001 · 登录状态恢复',
      0,
      2,
    );
    await assertProgress(gate, context.orchestrator, 'finished:AUTH-LOGIN-001', null, 1, 2);
    await assertProgress(
      gate,
      context.orchestrator,
      'started:AUTH-LOGOUT-001',
      'AUTH-LOGOUT-001 · 安全退出',
      1,
      2,
    );
    await assertProgress(gate, context.orchestrator, 'finished:AUTH-LOGOUT-001', null, 2, 2);

    const result = await context.orchestrator.wait(started.runId);
    assert.equal(result?.result, 'passed', JSON.stringify(result));
    assert.deepEqual(result?.scenarioProgress, { completed: 2, total: 2 });
    assert.equal(result?.currentScenario, null);
    assert.ok(result?.activities?.some((activity) => activity.message.includes('完成场景')));
  });

  it('preserves the active scenario when the Runner session fails', async () => {
    const fixture = await createGitFixture(true);
    const context = await createRunContext(fixture, ['passed'], undefined, {
      scenarioIds: ['AUTH-LOGIN-001'],
      checkpoint: async () => undefined,
      failAfterFirstStart: true,
    });

    const result = await context.orchestrator.run({
      request: '验证 Runner 异常时保留现场',
      trigger: 'manual',
    });

    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.currentScenario, 'AUTH-LOGIN-001 · 登录状态恢复');
    assert.deepEqual(result.scenarioProgress, { completed: 0, total: 1 });
    assert.ok(result.activities?.some((activity) => activity.message.includes('执行失败')));
    assert.ok(result.activities?.at(-1)?.message.includes('测试数据清理'));
  });

  it('preserves failed and blocked result precedence from the independent report', async () => {
    const fixture = await createGitFixture();
    const failedContext = await createRunContext(fixture, ['failed']);
    const failed = await failedContext.orchestrator.run({
      request: '验证确定的登录回归',
      trigger: 'api',
    });
    assert.equal(failed.status, 'completed', JSON.stringify(failed));
    assert.equal(failed.result, 'failed');
    assert.match(failed.artifacts['report.md'] ?? '', /confirmed_bugs/);

    const blockedFixture = await createGitFixture(true);
    const blockedContext = await createRunContext(blockedFixture, ['blocked'], undefined, {
      scenarioIds: ['AUTH-LOGIN-001'],
      checkpoint: async () => undefined,
    });
    const blocked = await blockedContext.orchestrator.run({
      request: '验证当前测试命令',
      trigger: 'manual',
    });
    assert.equal(blocked.status, 'completed');
    assert.equal(blocked.result, 'blocked');
  });

  it('does not let a new remote commit change the fixed target during a run', async () => {
    const fixture = await createGitFixture();
    const context = await createRunContext(fixture, ['passed'], async () => {
      await writeFile(join(fixture.sourceDir, 'new-product-file.txt'), 'arrived later\n');
      await commitAndPush(fixture.sourceDir, 'late product commit', 'scenario-testing');
    });

    const result = await context.orchestrator.run({
      request: '执行固定版本回归',
      trigger: 'manual',
    });
    assert.equal(result.targetCommit, fixture.initialHead);
    assert.equal(
      (await git(['rev-parse', 'scenario-testing'], fixture.sourceDir)).stdout.trim() ===
        fixture.initialHead,
      false,
    );
    assert.match(result.artifacts['execution.md'] ?? '', new RegExp(fixture.initialHead));
  });

  it('only exposes an explicit non-sensitive environment to fixture commands', async () => {
    const scriptDirectory = await mkdtemp(join(tmpdir(), 'luowang-phase3-env-'));
    cleanup.push(async () => rm(scriptDirectory, { recursive: true, force: true }));
    await writeFile(
      join(scriptDirectory, 'print-env.js'),
      'console.log(JSON.stringify(process.env));\n',
    );
    const runner = createControlledCommandRunner({
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      GIT_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      OSS_ACCESS_KEY_SECRET: 'must-not-leak',
      LUOWANG_ADMIN_PASSWORD: 'must-not-leak',
      LUOWANG_MASTER_KEY: 'must-not-leak',
    });
    const result = await runner.run('node print-env.js', {
      cwd: scriptDirectory,
      runId: '01K00000000000000000000001',
      targetCommit: 'a'.repeat(40),
    });
    const childEnvironment = JSON.parse(result.stdout) as Record<string, string>;
    assert.equal(childEnvironment.GIT_TOKEN, undefined);
    assert.equal(childEnvironment.OPENAI_API_KEY, undefined);
    assert.equal(childEnvironment.OSS_ACCESS_KEY_SECRET, undefined);
    assert.equal(childEnvironment.LUOWANG_ADMIN_PASSWORD, undefined);
    assert.equal(childEnvironment.LUOWANG_MASTER_KEY, undefined);
    assert.equal(childEnvironment.LUOWANG_RUN_ID, '01K00000000000000000000001');
    assert.ok(result.environmentKeys.includes('LUOWANG_TARGET_COMMIT'));
  });

  it('rejects executable paths, inline interpreter code, and mutating Git forms', async () => {
    const runner = createControlledCommandRunner({ PATH: process.env.PATH });
    const options = {
      cwd: process.cwd(),
      runId: '01K00000000000000000000001',
      targetCommit: 'a'.repeat(40),
    };
    for (const command of [
      './node --version',
      'node -e "console.log(1)"',
      'git branch new-branch',
    ]) {
      await assert.rejects(
        () => runner.run(command, options),
        (error: unknown) => error instanceof Error && error.message.includes('Runner'),
      );
    }
  });

  it('does not allow a role writer to write another role artifact', async () => {
    const reportDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-workspace-'));
    cleanup.push(async () => rm(reportDir, { recursive: true, force: true }));
    const workspace = new RunWorkspace('01K00000000000000000000001', reportDir);
    await workspace.create();
    await assert.rejects(
      () => workspace.writer('main-a').writeReport('# not allowed'),
      (error: unknown) => error instanceof Error && error.message.includes('不能写入'),
    );
  });
});

interface Fixture {
  rootDir: string;
  remoteDir: string;
  sourceDir: string;
  cloneDir: string;
  initialHead: string;
}

interface TestContext {
  orchestrator: RunOrchestrator;
  reportDir: string;
  repository: ReturnType<typeof createRepositoryService>;
  configuration: ReturnType<typeof createConfigurationStore>;
  sessions: RecordingSessionFactory;
}

interface ProgressFixture {
  scenarioIds: string[];
  checkpoint(name: string): Promise<void>;
  failAfterFirstStart?: boolean;
}

interface CandidateTestOptions {
  planWriteFailureOnly?: boolean;
  patchValidationFailureOnly?: boolean;
  planScenarioId?: string;
  repairPlanOnce?: boolean;
  patchScenarioId?: string;
}

class ProgressGate {
  private readonly reached = new Set<string>();
  private readonly reachedWaiters = new Map<string, () => void>();
  private readonly releases = new Map<string, () => void>();

  async checkpoint(name: string): Promise<void> {
    this.reached.add(name);
    this.reachedWaiters.get(name)?.();
    await new Promise<void>((resolve) => this.releases.set(name, resolve));
  }

  async wait(name: string): Promise<void> {
    if (this.reached.has(name)) return;
    await new Promise<void>((resolve) => this.reachedWaiters.set(name, resolve));
  }

  release(name: string): void {
    const release = this.releases.get(name);
    assert.ok(release, `checkpoint not waiting: ${name}`);
    release();
  }
}

async function assertProgress(
  gate: ProgressGate,
  orchestrator: RunOrchestrator,
  checkpoint: string,
  currentScenario: string | null,
  completed: number,
  total: number,
): Promise<void> {
  await gate.wait(checkpoint);
  const current = await orchestrator.current();
  assert.equal(current?.currentScenario, currentScenario);
  assert.deepEqual(current?.scenarioProgress, { completed, total });
  gate.release(checkpoint);
}

async function createRunContext(
  fixture: Fixture,
  outcomes: Array<'passed' | 'failed' | 'blocked'>,
  beforeReport?: () => Promise<void>,
  progress?: ProgressFixture,
  reportPreamble = '',
  reportLineEnding: '\n' | '\r\n' = '\n',
  invalidReportFirst = false,
  invalidScenarioPatchFirst = false,
  options: {
    indexer?: RepositoryIndexer;
    candidate?: CandidateTestOptions;
    testData?: import('../src/server/runs/test-data.js').TestDataManager;
    secretStore?: SecretStore;
  } = {},
): Promise<TestContext> {
  const dataDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-data-'));
  const reportDir = join(dataDir, 'report');
  cleanup.push(async () => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    LUOWANG_DATA_DIR: dataDir,
    LUOWANG_REPO_DIR: fixture.cloneDir,
    LUOWANG_REPORT_DIR: reportDir,
    LUOWANG_ADMIN_PASSWORD: 'phase3-test-password!',
    LUOWANG_MASTER_KEY: 'phase3-test-master-key',
  });
  const database = initializeDatabase(config);
  cleanup.push(async () => database.close());
  const configuration = createConfigurationStore(database.sqlite, {
    repoDir: config.repoDir,
    reportDir: config.reportDir,
  });
  configuration.updateRepository({
    repository: fixture.remoteDir,
    scenarioBranch: 'scenario-testing',
    scenarioMode: 'autonomous',
  });
  configuration.updateHarness({
    agents: {
      main: { model: 'fixture-main', thinking: 'off' },
      runner: { model: 'fixture-runner', thinking: 'off' },
      reviewer: { model: 'fixture-reviewer', thinking: 'off' },
    },
  });
  const secretStore = fakeSecretStore();
  const repository = createRepositoryService(database.sqlite, configuration, secretStore, {
    repoDir: config.repoDir,
    allowLocalRepository: true,
  });
  const sessions = new RecordingSessionFactory(
    outcomes,
    beforeReport,
    progress,
    reportPreamble,
    reportLineEnding,
    invalidReportFirst,
    invalidScenarioPatchFirst,
    options.candidate,
  );
  const orchestrator = createRunOrchestrator({
    configuration,
    repository,
    indexer: options.indexer,
    testData: options.testData,
    secretStore: options.secretStore,
    reportDir,
    sessions,
    provider: {} as ProviderAdapter,
    oss: localEvidenceTransport().oss,
    logger: pino({ level: 'silent' }),
  });
  return { orchestrator, reportDir, repository, configuration, sessions };
}

class RecordingSessionFactory implements AgentSessionFactory {
  readonly created: string[] = [];
  readonly disposed: string[] = [];
  readonly inputs: AgentSessionInput[] = [];
  readonly messages: string[] = [];
  readonly sessionObjects: object[] = [];
  private outcomeIndex = 0;
  private readonly executedSources = new Map<string, string>();

  constructor(
    private readonly outcomes: Array<'passed' | 'failed' | 'blocked'>,
    private readonly beforeReport?: () => Promise<void>,
    private readonly progress?: ProgressFixture,
    private readonly reportPreamble = '',
    private readonly reportLineEnding: '\n' | '\r\n' = '\n',
    private readonly invalidReportFirst = false,
    private readonly invalidScenarioPatchFirst = false,
    private readonly candidateOptions: CandidateTestOptions = {},
  ) {}

  async create(input: AgentSessionInput) {
    this.created.push(input.role);
    this.inputs.push(input);
    const session = {
      prompt: async (message: string) => {
        this.messages.push(message);
        const candidateMain =
          input.role === 'main-a' &&
          hasTool(input, 'write_plan') &&
          hasTool(input, 'read_run_artifact') &&
          hasTool(input, 'write_scenario_patch');
        if (candidateMain) {
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'execution.md' });
          if (this.candidateOptions.planWriteFailureOnly) {
            const rejected = await invokeTool(input, 'write_plan', {
              content: '',
              requiresBrowser: false,
            });
            assert.equal(rejected.details.error, true);
            return;
          }
          const planScenarioId =
            this.candidateOptions.repairPlanOnce && !message.includes('规划工件联合校验失败')
              ? 'INIT-MISSING-001'
              : (this.candidateOptions.planScenarioId ?? 'INIT-HOME-001');
          await invokeTool(input, 'write_plan', {
            requiresBrowser: false,
            content: `# Initialization candidate plan\n\n侦察发现首页入口需要正式验证。\n\n## execution_scenarios\n\n- ${planScenarioId}\n`,
          });
          if (this.candidateOptions.patchValidationFailureOnly) {
            const rejected = await invokeTool(input, 'write_scenario_patch', {
              content: 'not a git patch',
            });
            assert.equal(rejected.details.error, true);
            return;
          }
          if (this.invalidScenarioPatchFirst) {
            const rejected = await invokeTool(input, 'write_scenario_patch', {
              content: 'not a git patch',
            });
            assert.equal(rejected.details.error, true);
            const missingNewline = await invokeTool(input, 'write_scenario_patch', {
              content: initializationScenarioPatch(this.candidateOptions.patchScenarioId).trimEnd(),
            });
            assert.equal(missingNewline.details.error, true);
            assert.match(commandText(missingNewline), /缺少末尾换行/);
          }
          await invokeTool(input, 'write_scenario_patch', {
            content: initializationScenarioPatch(this.candidateOptions.patchScenarioId),
          });
        } else if (input.role === 'main-a' && hasTool(input, 'write_plan')) {
          await invokeTool(input, 'get_run_context', {});
          await invokeTool(input, 'write_plan', {
            requiresBrowser: false,
            content: this.progress
              ? `# Plan\n\n按顺序执行场景。\n\n## execution_scenarios\n\n${this.progress.scenarioIds.map((id) => `- ${id}`).join('\n')}\n`
              : '# Plan\n\n## execution_scenarios\n\n无需场景测试：本次请求只验证文档事实，不影响产品行为。\n',
          });
        } else if (input.role === 'main-a') {
          throw new Error('fixture Main received an unexpected tool boundary');
        } else if (input.role === 'runner') {
          assert.ok(!hasTool(input, 'write_draft_report'));
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          const progressAvailable = hasTool(input, 'begin_scenario_execution');
          const scenarioIds =
            this.progress?.scenarioIds ??
            (progressAvailable && /候选场景顺序/.test(input.userMessage) ? ['INIT-HOME-001'] : []);
          if (progressAvailable) {
            const files = commandText(await invokeTool(input, 'list_working_scenarios', {}));
            this.executedSources.clear();
            for (const path of files.split('\n').filter(Boolean)) {
              const content = commandText(
                await invokeTool(input, 'read_working_scenario', { path }),
              );
              const parsed = parseScenarioMarkdown(content, path);
              if (scenarioIds.includes(parsed.id)) this.executedSources.set(parsed.id, content);
            }
            await invokeTool(input, 'begin_scenario_execution', { scenarioIds });
          }
          assert.ok(!input.userMessage.includes('selectedScenarioSnapshot'));
          await this.progress?.checkpoint('declared');
          for (const [index, scenarioId] of scenarioIds.entries()) {
            await invokeTool(input, 'start_scenario', { scenarioId });
            await this.progress?.checkpoint(`started:${scenarioId}`);
            if (index === 0 && this.progress?.failAfterFirstStart) {
              throw new Error('fixture Runner session failed');
            }
            await invokeTool(input, 'finish_scenario', { scenarioId });
            await this.progress?.checkpoint(`finished:${scenarioId}`);
          }
          if (this.beforeReport) await this.beforeReport();
          const outcome =
            this.outcomes[Math.min(this.outcomeIndex++, this.outcomes.length - 1)] ?? 'passed';
          const command = await invokeTool(input, 'run_fixture_command', {
            command: 'node --version',
          });
          await invokeTool(input, 'write_execution', {
            content: `# Execution\n\n固定 target ${extractTarget(input)}\n\n${commandText(command)}\n观察：${outcome}\n`,
          });
        } else if (input.role === 'reviewer') {
          const data = JSON.parse(input.userMessage.slice(input.userMessage.indexOf('{'))) as {
            targetCommit: string;
            selectedScenarioSnapshot: SelectedScenarioSnapshot;
          };
          const snapshot = data.selectedScenarioSnapshot;
          assert.ok(snapshot);
          assert.equal(snapshot.targetCommit, data.targetCommit);
          const selected = parseExecutionScenarioPlan(
            await readFile(join(input.cwd, 'plan.md'), 'utf8'),
          );
          assert.deepEqual(
            snapshot.scenarios.map((s) => s.id),
            selected.scenarioIds,
          );
          for (const source of snapshot.scenarios) {
            assert.equal(source.content, this.executedSources.get(source.id));
            assert.equal(
              source.sourceSha256,
              createHash('sha256').update(source.content).digest('hex'),
            );
            assert.equal(source.redacted, false);
          }
          const patch = await readFile(join(input.cwd, 'scenario-changes.patch'), 'utf8').catch(
            () => undefined,
          );
          assert.equal(
            snapshot.patchSha256,
            patch === undefined ? null : createHash('sha256').update(patch).digest('hex'),
          );
          const premature = await invokeTool(input, 'read_run_artifact', {
            name: 'execution.md',
          });
          assert.equal(premature.details.error, true);
          assert.doesNotMatch(commandText(premature), /# Draft/);
          await invokeTool(input, 'read_run_artifact', { name: 'plan.md' });
          await invokeTool(input, 'read_run_artifact', { name: 'scenario-changes.patch' });
          await invokeTool(input, 'read_run_artifact', { name: 'execution.md' });
          await invokeTool(input, 'write_review', {
            content: this.progress
              ? '# Review\n\n独立确认两个场景均按顺序执行并完成。\n'
              : '# Review\n\n独立确认无需场景测试：计划中的影响判断有依据。\n',
          });
        } else {
          assert.ok(!input.userMessage.includes('selectedScenarioSnapshot'));
          const context = parsePromptContext(input.userMessage);
          for (const name of ['execution.md', 'draft-report.md']) {
            const denied = await invokeTool(input, 'read_run_artifact', { name });
            assert.equal(denied.details.error, true);
          }
          for (const name of ['plan.md', 'review.md']) {
            await invokeTool(input, 'read_run_artifact', { name });
          }
          const outcome =
            this.outcomes[Math.min(this.outcomeIndex - 1, this.outcomes.length - 1)] ?? 'passed';
          if (outcome === 'failed') {
            await invokeTool(input, 'query_issue_candidates', { bug_key: 'BUG-LOGIN-001' });
          }
          if (this.invalidReportFirst) {
            const rejected = await invokeTool(input, 'write_report', {
              content: '# Final Report\n\n缺少 frontmatter。\n',
            });
            assert.equal(rejected.details.error, true);
          }
          if (outcome === 'passed') {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(
                this.progress
                  ? progressReportFor(context, this.progress.scenarioIds)
                  : /"initialization"\s*:\s*true/.test(input.userMessage)
                    ? progressReportFor(context, ['INIT-HOME-001'])
                    : reportFor(context, 'passed', false),
              ),
            });
          } else if (outcome === 'failed') {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(
                reportFor(context, 'failed', true, this.progress?.scenarioIds ?? []),
              ),
            });
          } else {
            await invokeTool(input, 'write_report', {
              content: this.formatReport(
                reportFor(context, 'blocked', false, this.progress?.scenarioIds ?? []),
              ),
            });
          }
        }
      },
      dispose: () => {
        this.disposed.push(input.role);
      },
    };
    this.sessionObjects.push(session);
    return session;
  }

  private formatReport(content: string): string {
    return `${this.reportPreamble}${content}`.replaceAll('\n', this.reportLineEnding);
  }
}

function hasTool(input: AgentSessionInput, name: string): boolean {
  return input.customTools.some((tool) => tool.name === name);
}

async function invokeTool(
  input: AgentSessionInput,
  name: string,
  params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const tool = input.customTools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(
    'test-tool-call',
    params as never,
    undefined,
    undefined,
    {} as never,
  ) as Promise<AgentToolResult<Record<string, unknown>>>;
}

function initializationScenarioPatch(id = 'INIT-HOME-001'): string {
  const content = `---
id: ${id}
name: 首页可访问
description: 验证项目首页可访问
status: approved
tags:
  - core
---

## 目的

验证首页基础可用性。

## 前置条件

非生产环境可访问。

## 步骤

1. 打开首页。

## 期望

首页成功显示。

## 需要记录

状态码和页面标题。
`;
  const additions = content
    .split('\n')
    .slice(0, -1)
    .map((line) => `+${line}`)
    .join('\n');
  const lines = content.trimEnd().split('\n').length;
  return `diff --git a/docs/scenario-testing/scenarios/${id}.md b/docs/scenario-testing/scenarios/${id}.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/docs/scenario-testing/scenarios/${id}.md
@@ -0,0 +1,${lines} @@
${additions}
`;
}

function commandText(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map((item) => ('text' in item ? item.text : '')).join('');
}

function parsePromptContext(prompt: string): {
  runId: string;
  trigger: 'manual' | 'api';
  baseCommit: string | null;
  targetCommit: string;
  includedCommits: string[];
  startedAt: string;
  finishedAt: string;
} {
  const match = prompt.match(/动态 Run 上下文：\s*([\s\S]+)$/);
  const json = match?.[1];
  assert.ok(json, 'missing prompt context');
  return JSON.parse(json) as ReturnType<typeof parsePromptContext>;
}

function extractTarget(input: AgentSessionInput): string {
  return parsePromptContext(input.userMessage).targetCommit;
}

function reportFor(
  context: ReturnType<typeof parsePromptContext>,
  result: 'passed' | 'failed' | 'blocked',
  failedBug: boolean,
  scenarioIds: readonly string[] = [],
): string {
  const scenarioResults = scenarioIds.length
    ? `\n${scenarioIds.map((id) => `  - id: ${id}\n    result: ${result}`).join('\n')}`
    : '[]';
  const bugs = failedBug
    ? `\n  - key: BUG-LOGIN-001\n    title: 登录状态丢失\n    scenario_ids:\n      - AUTH-LOGIN-001\n    issue_action: create`
    : '[]';
  const included = context.includedCommits.length
    ? `\n${context.includedCommits.map((sha) => `  - ${sha}`).join('\n')}`
    : ' []';
  return `---
run_id: ${context.runId}
trigger: ${context.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits:${included}
result: ${result}
started_at: ${context.startedAt}
finished_at: ${context.finishedAt}
scenario_results: ${scenarioResults}
confirmed_bugs: ${bugs}
---

# Report

${
  result === 'passed'
    ? '无需场景测试：Reviewer 已独立确认本批不影响产品行为。'
    : `证据记录见 execution.md 和 review.md。${failedBug ? '\n\n## Issue 查询覆盖缺口\n\n- BUG-LOGIN-001：unavailable' : ''}`
}
`;
}

function progressReportFor(
  context: ReturnType<typeof parsePromptContext>,
  scenarioIds: readonly string[],
): string {
  return `---
run_id: ${context.runId}
trigger: ${context.trigger}
base_commit: ${context.baseCommit ?? 'null'}
target_commit: ${context.targetCommit}
included_commits: []
result: passed
started_at: ${context.startedAt}
finished_at: ${context.finishedAt}
scenario_results:
${scenarioIds.map((id) => `  - id: ${id}\n    result: passed`).join('\n')}
confirmed_bugs: []
---

# Report

两个场景均已执行完成。
`;
}

function scenarioMarkdown(id: string, name: string): string {
  return `---
id: ${id}
name: ${name}
description: 验证 ${name} 的业务结果
status: approved
tags:
  - core
---

## 目的

验证 ${name}。
`;
}

async function createGitFixture(withScenarios = false): Promise<Fixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'luowang-phase3-git-'));
  cleanup.push(async () => rm(rootDir, { recursive: true, force: true }));
  const remoteDir = join(rootDir, 'remote.git');
  const sourceDir = join(rootDir, 'source');
  const cloneDir = join(rootDir, 'clone');
  await mkdir(sourceDir, { recursive: true });
  await git(['init', '--bare', remoteDir], rootDir);
  await git(['init', '--initial-branch=main'], sourceDir);
  await git(['config', 'user.name', 'LuoWang Phase 3 Test'], sourceDir);
  await git(['config', 'user.email', 'luowang-phase3@example.test'], sourceDir);
  await writeFile(join(sourceDir, 'README.md'), 'fixture product\n');
  if (withScenarios) {
    const scenarioDirectory = join(sourceDir, 'docs', 'scenario-testing', 'scenarios');
    await mkdir(scenarioDirectory, { recursive: true });
    await writeFile(
      join(scenarioDirectory, 'AUTH-LOGIN-001.md'),
      scenarioMarkdown('AUTH-LOGIN-001', '登录状态恢复'),
    );
    await writeFile(
      join(scenarioDirectory, 'AUTH-LOGOUT-001.md'),
      scenarioMarkdown('AUTH-LOGOUT-001', '安全退出'),
    );
  }
  await git(['add', '-A'], sourceDir);
  await git(['commit', '-m', 'initial product'], sourceDir);
  await git(['remote', 'add', 'origin', remoteDir], sourceDir);
  await git(['push', '-u', 'origin', 'main'], sourceDir);
  await git(['checkout', '-b', 'scenario-testing', 'main'], sourceDir);
  await git(['push', '-u', 'origin', 'scenario-testing'], sourceDir);
  return {
    rootDir,
    remoteDir,
    sourceDir,
    cloneDir,
    initialHead: (await git(['rev-parse', 'scenario-testing'], sourceDir)).stdout.trim(),
  };
}

async function commitAndPush(directory: string, message: string, branch: string): Promise<void> {
  await git(['add', '-A'], directory);
  await git(['commit', '-m', message], directory);
  await git(['push', 'origin', branch], directory);
}

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function fakeSecretStore(): SecretStore {
  return {
    isAvailable: () => true,
    set: () => undefined,
    get: () => undefined,
    has: () => false,
    delete: () => undefined,
    metadata: () => ({}) as SecretStore['metadata'] extends () => infer T ? T : never,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
