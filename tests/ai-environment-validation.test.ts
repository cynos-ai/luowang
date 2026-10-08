import { strict as assert } from 'node:assert';
import { it, vi } from 'vitest';
import { environmentFixture } from './environment-fixture.js';
import { createEnvironmentValidationService } from '../src/server/projects/environment-validation.js';
import { createExecutionResourceLedger } from '../src/server/projects/resource-ledger.js';
import { readInstanceId } from '../src/server/projects/instance-id.js';
import { ControlledCommandError } from '../src/server/runs/command-runner.js';
import { environmentState } from '../src/server/projects/environment-state.js';
import type { EnvironmentValidationTask } from '../src/shared/environment-preparation.js';

it('validates a frozen environment, shares capacity and configuration locks, and persists a result without creating a Run', async () => {
  const f = environmentFixture();
  const ledger = createExecutionResourceLedger(f.database, readInstanceId(f.database));
  let unblock!: () => void;
  const service = createEnvironmentValidationService({
    ...f,
    repoRoot: '/repo',
    reportRoot: '/reports',
    storageRoot: '/tmp',
    loadSource: async () => ({ repository: {} as never, commit: f.commit }),
    runtimeFactory: (input) => async (context) => {
      assert.equal(context.targetCommit, f.commit);
      assert.equal(input.task.runtime.servicePort, 8080);
      assert.throws(
        () =>
          f.configuration.update(f.project.projectId, {
            runtime: { ...f.configuration.get(f.project.projectId).runtime, servicePort: 9090 },
          }),
        /准备|清理/,
      );
      assert.throws(() => service.start(f.project.projectId), /正在/);
      assert.throws(
        () =>
          f.resources.createProjectFile(f.project.projectId, { path: '.env.test', content: 'X=1' }),
        /资源/,
      );
      for (const stage of ['executor', 'parse', 'build', 'initialize', 'start', 'health'] as const)
        input.onStage?.(stage);
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      ledger.transition(input.preparationResourceId!, 'planned', 'created', 'fixture');
      return {
        baseUrl: 'http://example.test',
        browserAvailable: true,
        async close() {
          ledger.transition(input.preparationResourceId!, 'created', 'released');
        },
      };
    },
  });
  try {
    const started = service.start(f.project.projectId);
    await vi.waitFor(() => assert.ok(unblock));
    assert.equal(service.current(f.project.projectId)?.status, 'running');
    unblock();
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'passed'));
    assert.equal(service.current(f.project.projectId)?.cleanupConfirmed, true);
    assert.equal(
      (f.database.prepare('SELECT count(*) n FROM test_request_queue').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (f.database.prepare('SELECT count(*) n FROM run_execution_context').get() as { n: number }).n,
      0,
    );
    const restored = createEnvironmentValidationService({
      ...f,
      repoRoot: '/repo',
      reportRoot: '/reports',
      storageRoot: '/tmp',
    });
    assert.equal(restored.current(f.project.projectId)?.id, started.id);
    f.configuration.update(f.project.projectId, { environmentDescription: 'changed' });
    assert.equal(restored.current(f.project.projectId)?.stale, true);
    await restored.close();
  } finally {
    await service.close();
    f.database.close();
  }
});

it('keeps initialization failure and unknown cleanup visible, exposes only controlled diagnostics', async () => {
  const f = environmentFixture();
  const service = createEnvironmentValidationService({
    ...f,
    repoRoot: '/repo',
    reportRoot: '/reports',
    storageRoot: '/tmp',
    loadSource: async () => ({ repository: {} as never, commit: f.commit }),
    runtimeFactory: (input) => async () => {
      input.onStage?.('initialize');
      throw new ControlledCommandError(
        'COMMAND_FAILED',
        '初始化步骤失败：tools（第 1 步，退出码 1）',
      );
    },
    reconcile: async () => ({ released: 0, unknown: 1 }),
  });
  try {
    service.start(f.project.projectId);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'failed'));
    const result = service.current(f.project.projectId)!;
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.failure?.stage, 'initialize');
    assert.equal(result.steps.at(-1)?.status, 'failed');
    assert.equal(service.failure(f.project.projectId)?.stage, 'initialize');
    assert.throws(() => service.start(f.project.projectId), /资源/);
  } finally {
    await service.close();
    f.database.close();
  }
});

it('cancels before the runtime starts and marks a restarted validation interrupted rather than passed', async () => {
  const f = environmentFixture();
  let entered = false;
  const service = createEnvironmentValidationService({
    ...f,
    repoRoot: '/repo',
    reportRoot: '/reports',
    storageRoot: '/tmp',
    loadSource: async (_id, signal) => {
      entered = true;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
    runtimeFactory: () => async () => {
      throw new Error('must not start');
    },
  });
  try {
    const started = service.start(f.project.projectId);
    await vi.waitFor(() => assert.ok(entered));
    service.stop(f.project.projectId, started.id);
    await vi.waitFor(() => assert.equal(service.current(f.project.projectId)?.status, 'cancelled'));
    assert.equal(service.current(f.project.projectId)?.cleanupConfirmed, true);
    const stored = environmentState<EnvironmentValidationTask>(
      f.database,
      f.project.projectId,
      'validation',
    );
    stored.set({ ...stored.get()!, status: 'running' });
    const restarted = createEnvironmentValidationService({
      ...f,
      repoRoot: '/repo',
      reportRoot: '/reports',
      storageRoot: '/tmp',
    });
    assert.equal(restarted.current(f.project.projectId)?.status, 'cancelled');
    assert.match(restarted.current(f.project.projectId)?.failure?.message ?? '', /服务重启/);
    await restarted.close();
  } finally {
    await service.close();
    f.database.close();
  }
});
