import { strict as assert } from 'node:assert';
import { it, vi } from 'vitest';
import { environmentFixture } from './environment-fixture.js';
import { normalizeGeneratedDefinition } from '../src/server/projects/generated-definition.js';
import { normalizeRuntimeDefinition } from '../src/server/projects/configuration.js';
import { createEnvironmentGenerationService } from '../src/server/projects/environment-generation.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';
import type { PreparationPlan } from '../src/shared/project-preparation.js';

const preparation: PreparationPlan = {
  scope: '完整网页和后端',
  data: '创建合成数据，不连接生产库',
  account: { mode: 'generated', description: '创建主测试用户并验证登录' },
  externalServices: '不发送真实邮件',
  decisions: ['使用合成数据'],
  evidence: ['src/auth.ts：登录接口'],
};

it('requires a complete preparation plan, rejects old definitions and validates actual checks', () => {
  const base = {
    sourceCommit: 'a'.repeat(40),
    summary: 'fixture',
    files: [{ path: '.luowang-generated/compose.yml', content: 'services: {}' }],
  };
  assert.throws(() => normalizeGeneratedDefinition(base), /测试准备方案无效/);
  assert.throws(
    () => normalizeGeneratedDefinition({ ...base, preparation: null }),
    /测试准备方案无效/,
  );
  assert.deepEqual(
    normalizeGeneratedDefinition({ ...base, preparation })?.preparation,
    preparation,
  );
  assert.throws(
    () =>
      normalizeGeneratedDefinition({
        ...base,
        preparation: { ...preparation, account: { mode: 'production' } },
      }),
    /账号策略/,
  );
  assert.throws(
    () => normalizeGeneratedDefinition({ ...base, preparation: { ...preparation, scope: '' } }),
    /说明/,
  );
  const runtime = {
    composeServices: ['app', 'tools'],
    applicationService: 'app',
    commandService: 'tools',
    preparationChecks: [
      {
        kind: 'account',
        label: '登录',
        service: 'tools',
        command: 'verify-login',
        timeoutSeconds: 30,
      },
    ],
  };
  assert.deepEqual(
    normalizeRuntimeDefinition(runtime).preparationChecks,
    runtime.preparationChecks,
  );
  assert.throws(
    () =>
      normalizeRuntimeDefinition({
        ...runtime,
        preparationChecks: [{ ...runtime.preparationChecks[0], service: 'app' }],
      }),
    /非应用/,
  );
  assert.throws(
    () =>
      normalizeRuntimeDefinition({
        ...runtime,
        preparationChecks: [{ ...runtime.preparationChecks[0], kind: 'other' }],
      }),
    /核验/,
  );
});

it('creates credentials only on explicit application, atomically, retains existing credentials and carries draft feedback without exposing secrets', async () => {
  const f = environmentFixture();
  const prompts: string[] = [];
  const service = createEnvironmentGenerationService({
    ...f,
    repoRoot: '/repo',
    loadSource: async () => ({
      commit: f.commit,
      repository: { directory: '/repo', listTree: async () => [] } as unknown as GitRepository,
    }),
    sessions: {
      async create(input) {
        return {
          async prompt(message: string) {
            prompts.push(message);
            await input
              .customTools!.find((tool) => tool.name === 'submit_environment_definition')!
              .execute(
                'submit',
                {
                  definition: {
                    summary: 'fixture',
                    preparation,
                    files: [{ path: '.luowang-generated/compose.yml', content: 'services: {}' }],
                    runtime: {
                      ...f.configuration.get(f.project.projectId).runtime,
                      initializationSteps: [
                        { service: 'tools', command: 'create-user-from-file', timeoutSeconds: 30 },
                      ],
                      preparationChecks: [
                        {
                          kind: 'account',
                          label: '核验登录',
                          service: 'tools',
                          command: 'verify-login-from-file',
                          timeoutSeconds: 30,
                        },
                      ],
                    },
                  },
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
  const store = f.secrets.project(f.project.projectId);
  const generate = async () => {
    const started = service.start(f.project.projectId, { requirements: '请用普通用户' });
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'completed'));
    return { id: started.id, draft: service.current(f.project.projectId)!.draft! };
  };
  try {
    await generate();
    assert.equal(store.has('testUsername'), false);
    const next = await generate();
    assert.deepEqual(
      JSON.parse(prompts.at(-1)!).previousDraft.generatedDefinition.preparation,
      preparation,
    );
    const originalUpdate = f.configuration.update;
    f.configuration.update = () => {
      throw new Error('synthetic write failure');
    };
    assert.throws(() => service.apply(f.project.projectId, next.id, next.draft), /synthetic/);
    assert.equal(store.has('testUsername'), false);
    assert.equal(store.has('testPassword'), false);
    f.configuration.update = originalUpdate;
    service.apply(f.project.projectId, next.id, next.draft);
    const username = store.get('testUsername')!;
    const password = store.get('testPassword')!;
    assert.match(username, /^luowang-[a-f0-9]+@example.test$/);
    assert.ok(password.length >= 32);
    const updated = await generate();
    service.apply(f.project.projectId, updated.id, updated.draft);
    assert.equal(store.get('testPassword'), password);
    assert.equal(store.get('testUsername'), username);
    assert.ok(!prompts.join('').includes(password));
    assert.ok(!JSON.stringify(service.current(f.project.projectId)).includes(password));
    assert.ok(!JSON.stringify(f.configuration.get(f.project.projectId)).includes(password));
    const stale = await generate();
    store.set('testPassword', 'synthetic-rotated-password');
    assert.equal(service.current(f.project.projectId)?.stale, true);
    assert.throws(() => service.apply(f.project.projectId, stale.id, stale.draft), /已变化/);
    store.delete('testPassword');
    const incomplete = await generate();
    assert.throws(
      () => service.apply(f.project.projectId, incomplete.id, incomplete.draft),
      /不完整/,
    );
    assert.equal(store.get('testUsername'), username);
  } finally {
    await service.close();
    f.database.close();
  }
});
