import { strict as assert } from 'node:assert';
import { it, vi } from 'vitest';
import {
  selectHighestThinking,
  type PiModel,
  type ProviderAdapter,
} from '../src/server/runs/provider.js';
import { createPiAgentSessionFactory } from '../src/server/runs/agent-session.js';
import type { AgentSessionInput } from '../src/server/runs/types.js';
import { assertDeclaredApplicationPort } from '../src/server/projects/compose-contract.js';
import { createEnvironmentGenerationService } from '../src/server/projects/environment-generation.js';
import { environmentFixture, preparationFixture } from './environment-fixture.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';

it('selects the highest declared reasoning capability and rejects off-only models before creating a Pi runtime', async () => {
  assert.equal(selectHighestThinking({ reasoning: true } as PiModel), 'high');
  assert.equal(
    selectHighestThinking({ reasoning: true, thinkingLevelMap: { max: 'high' } } as PiModel),
    'max',
  );
  assert.equal(
    selectHighestThinking({
      reasoning: true,
      thinkingLevelMap: { high: null, xhigh: null, max: null },
    } as PiModel),
    'medium',
  );
  const factory = createPiAgentSessionFactory({
    provider: {
      resolveModel: async () => ({ reasoning: false }),
      getRuntime: async () => {
        throw new Error('must not create runtime');
      },
    } as unknown as ProviderAdapter,
  });
  await assert.rejects(
    () =>
      factory.create({
        role: 'main-a',
        config: { thinking: 'off' },
        thinkingPolicy: 'highest',
      } as AgentSessionInput),
    /当前模型不支持/,
  );
});

it('rejects frontend/backend declared port mismatches without claiming that declarations prove listening', () => {
  const compose = 'services:\n  app:\n    expose: [8080]\n  frontend:\n    expose: [5173]\n';
  assert.throws(() => assertDeclaredApplicationPort(compose, 'app', 5173), /不匹配/);
  assert.doesNotThrow(() => assertDeclaredApplicationPort(compose, 'frontend', 5173));
  assert.doesNotThrow(() =>
    assertDeclaredApplicationPort('services:\n  app:\n    image: fixture', 'app', 3000),
  );
});

it('rejects inconsistent generated configuration on manual save without changing the saved definition', () => {
  const f = environmentFixture();
  try {
    const before = f.configuration.get(f.project.projectId);
    assert.throws(
      () =>
        f.configuration.update(f.project.projectId, {
          runtime: { ...before.runtime, servicePort: 5173 },
          generatedDefinition: {
            sourceCommit: f.commit,
            summary: 'fixture',
            preparation: preparationFixture,
            files: [
              {
                path: '.luowang-generated/compose.yml',
                content: 'services:\n  app:\n    expose: [8080]\n  tools:\n    image: fixture',
              },
            ],
          },
        }),
      /不匹配/,
    );
    assert.deepEqual(f.configuration.get(f.project.projectId), before);
  } finally {
    f.database.close();
  }
});

it('uses a 30-minute preparation budget, highest-thinking policy and persists the resolved level', async () => {
  const f = environmentFixture();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const service = createEnvironmentGenerationService({
    ...f,
    repoRoot: '/repo',
    loadSource: async () => ({
      commit: f.commit,
      repository: { directory: '/repo', listTree: async () => [] } as unknown as GitRepository,
    }),
    sessions: {
      async create(input) {
        assert.equal(input.thinkingPolicy, 'highest');
        input.onThinkingResolved?.('high');
        assert.match(input.systemPrompt, /不实现替代业务功能/);
        return {
          async prompt() {
            await input
              .customTools!.find((tool) => tool.name === 'report_missing_inputs')!
              .execute(
                'missing',
                {
                  items: [{ item: '测试能力', reason: '无项目测试替身', destination: 'decision' }],
                },
                input.signal,
                undefined,
                {} as never,
              );
          },
          dispose() {},
        };
      },
    },
  });
  try {
    service.start(f.project.projectId);
    await vi.waitFor(() =>
      assert.equal(service.current(f.project.projectId)?.status, 'needs_input'),
    );
    assert.ok(timeout.mock.calls.some((args) => args[0] === 30 * 60_000));
    assert.equal(service.current(f.project.projectId)?.thinking, 'high');
  } finally {
    await service.close();
    timeout.mockRestore();
    f.database.close();
  }
});
