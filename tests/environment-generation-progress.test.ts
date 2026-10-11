import { strict as assert } from 'node:assert';
import { it, vi } from 'vitest';
import { environmentFixture, preparationFixture } from './environment-fixture.js';
import { createEnvironmentGenerationService } from '../src/server/projects/environment-generation.js';
import type { GitRepository } from '../src/server/repository/git-repository.js';

it('reads bounded source ranges, records invalid submissions and completes immediately after a valid tool submission', async () => {
  const f = environmentFixture();
  let stoppedModel = false;
  const service = createEnvironmentGenerationService({
    ...f,
    repoRoot: '/repo',
    generationTimeoutMs: 2000,
    loadSource: async () => ({
      commit: f.commit,
      repository: {
        directory: '/repo',
        listTree: async () => [{ path: 'entry.ts', type: 'blob', mode: '100644' }],
        readTextFileAtCommit: async () => ({ content: 'a'.repeat(20000) }),
      } as unknown as GitRepository,
    }),
    sessions: {
      async create(input) {
        let releaseStream: (() => void) | undefined;
        return {
          async prompt() {
            const read = input.customTools![0];
            const first = await read.execute(
              'r1',
              { path: 'entry.ts' },
              input.signal,
              undefined,
              {} as never,
            );
            assert.equal((first.details as { nextOffset: number }).nextOffset, 12000);
            assert.ok((first.content[0] as { text: string }).text.length < 12500);
            const rest = await read.execute(
              'r2',
              { path: 'entry.ts', offset: 12000 },
              input.signal,
              undefined,
              {} as never,
            );
            assert.equal((rest.details as { nextOffset: null }).nextOffset, null);
            const submit = input.customTools![1];
            await assert.rejects(
              () =>
                submit.execute('bad', { definition: '{}' }, input.signal, undefined, {} as never),
              /结构化对象/,
            );
            assert.match(service.current(f.project.projectId)?.lastToolError ?? '', /结构化对象/);
            await assert.rejects(
              () =>
                submit.execute(
                  'wrong-entry',
                  {
                    definition: {
                      summary: 'wrong service port',
                      preparation: preparationFixture,
                      files: [
                        {
                          path: '.luowang-generated/compose.yml',
                          content:
                            'services:\n  app:\n    expose: [5173]\n  tools:\n    image: fixture',
                        },
                      ],
                      runtime: f.configuration.get(f.project.projectId).runtime,
                    },
                  },
                  input.signal,
                  undefined,
                  {} as never,
                ),
              /不匹配/,
            );
            await submit.execute(
              'good',
              {
                definition: {
                  summary: 'fixture',
                  preparation: preparationFixture,
                  files: [{ path: '.luowang-generated/compose.yml', content: 'services: {}' }],
                  runtime: f.configuration.get(f.project.projectId).runtime,
                },
              },
              input.signal,
              undefined,
              {} as never,
            );
            await new Promise<void>((resolve) => {
              releaseStream = resolve;
              const stopped = () => {
                stoppedModel = true;
              };
              if (input.signal!.aborted) stopped();
              else input.signal!.addEventListener('abort', stopped, { once: true });
            });
            throw new Error('private provider error after accepted result');
          },
          dispose() {
            releaseStream?.();
          },
        };
      },
    },
  });
  try {
    service.start(f.project.projectId);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'completed'));
    const task = service.current(f.project.projectId)!;
    assert.equal(task.filesRead, 1);
    assert.equal(task.definitionAttempts, 3);
    assert.equal(task.lastToolError, null);
    assert.ok(task.startedAt && task.lastActivityAt);
    assert.ok(stoppedModel);
    assert.ok(!JSON.stringify(task).includes('private provider'));
  } finally {
    await service.close();
    f.database.close();
  }
});

it('times out with last safe progress instead of losing the diagnostic context', async () => {
  const f = environmentFixture();
  const service = createEnvironmentGenerationService({
    ...f,
    repoRoot: '/repo',
    generationTimeoutMs: 50,
    loadSource: async () => ({
      commit: f.commit,
      repository: { directory: '/repo', listTree: async () => [] } as unknown as GitRepository,
    }),
    sessions: {
      async create(input) {
        return {
          async prompt() {
            await new Promise<void>((_resolve, reject) => {
              if (input.signal!.aborted) reject(new Error('private provider failure'));
              else
                input.signal!.addEventListener(
                  'abort',
                  () => reject(new Error('private provider failure')),
                  { once: true },
                );
            });
          },
          dispose() {},
        };
      },
    },
  });
  try {
    service.start(f.project.projectId);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'failed'));
    const task = service.current(f.project.projectId)!;
    assert.match(task.error!, /配置生成超时：已读取 0 个文件，尝试提交 0 次/);
    assert.match(task.error!, /等待 Main 模型响应/);
    assert.ok(!task.error!.includes('private provider'));
  } finally {
    await service.close();
    f.database.close();
  }
});
