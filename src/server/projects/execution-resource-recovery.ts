import type Database from 'better-sqlite3';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import {
  createLocalExecutionAdapter,
  createSshExecutionAdapter,
  type ExecutionAdapter,
} from './execution-adapter.js';
import { createDockerRuntimeFromAdapter } from './execution-container.js';
import { createExecutionResourceLedger } from './resource-ledger.js';
import { readInstanceId } from './instance-id.js';
import { containerControlIdentity } from './application-runtime.js';
import { isExecutionResourceActive } from './active-execution-resources.js';

export async function reconcileExecutionResourceLedger(
  database: Database.Database,
  secrets: ScopedSecretStore,
  options: {
    includeRunning?: boolean;
    adapterFactory?: (locationId: string, revision: number) => Promise<ExecutionAdapter>;
  } = {},
): Promise<{ released: number; unknown: number }> {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_ledger'",
      )
      .get()
  )
    return { released: 0, unknown: 0 };
  const ledger = createExecutionResourceLedger(database, readInstanceId(database));
  let released = 0;
  let unknown = 0;
  for (const resource of ledger.unresolved()) {
    if (isExecutionResourceActive(resource.resourceId)) continue;
    if (
      !options.includeRunning &&
      resource.queueId !== null &&
      database
        .prepare("SELECT 1 FROM test_request_queue WHERE queue_id = ? AND status = 'running'")
        .get(resource.queueId)
    ) {
      continue;
    }
    let adapter: ExecutionAdapter | undefined;
    try {
      adapter = options.adapterFactory
        ? await options.adapterFactory(
            resource.executionLocationId,
            resource.executionLocationRevision,
          )
        : await adapterFor(
            database,
            secrets,
            resource.executionLocationId,
            resource.executionLocationRevision,
          );
      const docker = createDockerRuntimeFromAdapter(adapter);
      const filters = [
        '--filter',
        `label=luowang.instance-id=${readInstanceId(database)}`,
        '--filter',
        `label=luowang.project-id=${resource.projectId}`,
      ];
      const containerList = await docker.run(['ps', '--all', '--quiet', ...filters], {
        timeoutMs: 20_000,
      });
      if (containerList.exitCode !== 0) throw new Error('容器资源查询失败');
      const containers = containerList.stdout.trim().split(/\s+/).filter(Boolean);
      for (const id of containers) {
        if (!(await ownedByAttempt(docker, 'container', id, resource.attemptId))) continue;
        const result = await docker.run(['rm', '--force', id], { timeoutMs: 30_000 });
        if (result.exitCode !== 0) throw new Error('容器清理未确认');
      }
      for (const kind of ['network', 'volume'] as const) {
        const listed = await docker.run([kind, 'ls', '--quiet', ...filters], { timeoutMs: 20_000 });
        if (listed.exitCode !== 0) throw new Error(`${kind} 资源查询失败`);
        for (const id of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
          if (!(await ownedByAttempt(docker, kind, id, resource.attemptId))) continue;
          if (kind === 'network' && resource.executionLocationId.startsWith('local:')) {
            const controlId = containerControlIdentity();
            if (controlId)
              await docker.run(['network', 'disconnect', '--force', id, controlId], {
                timeoutMs: 30_000,
              });
          }
          const removed = await docker.run([kind, 'rm', id], { timeoutMs: 30_000 });
          if (removed.exitCode !== 0) throw new Error(`${kind} 清理未确认`);
        }
      }
      ledger.transition(
        resource.resourceId,
        ['planned', 'created', 'cleanup_pending', 'unknown'],
        'released',
      );
      released++;
    } catch {
      if (resource.state !== 'unknown')
        try {
          ledger.transition(
            resource.resourceId,
            ['planned', 'created', 'cleanup_pending'],
            'unknown',
            null,
            'RECOVERY_UNAVAILABLE',
          );
        } catch {
          /* Preserve the original recovery failure when the state already changed. */
        }
      unknown++;
    } finally {
      await adapter?.close().catch(() => undefined);
    }
  }
  return { released, unknown };
}

async function ownedByAttempt(
  docker: ReturnType<typeof createDockerRuntimeFromAdapter>,
  kind: 'container' | 'network' | 'volume',
  id: string,
  attemptId: string,
): Promise<boolean> {
  const args =
    kind === 'container'
      ? ['inspect', '--format', '{{json .Config.Labels}}', id]
      : [kind, 'inspect', '--format', '{{json .Labels}}', id];
  const inspected = await docker.run(args, { timeoutMs: 10_000 });
  if (inspected.exitCode !== 0) throw new Error('资源归属无法核验');
  try {
    const labels = JSON.parse(inspected.stdout) as Record<string, string>;
    return labels['luowang.run-id'] === attemptId || labels['luowang.attempt-id'] === attemptId;
  } catch {
    throw new Error('资源标签无效');
  }
}

async function adapterFor(
  database: Database.Database,
  secrets: ScopedSecretStore,
  locationId: string,
  revision: number,
): Promise<ExecutionAdapter> {
  if (locationId.startsWith('local:')) return createLocalExecutionAdapter(locationId);
  const id = locationId.slice(7);
  const row = database.prepare('SELECT * FROM execution_servers WHERE server_id=?').get(id) as
    | {
        revision: number;
        host: string;
        port: number;
        username: string;
        auth_type: 'password' | 'private-key';
        host_fingerprint: string | null;
        health_status: string;
      }
    | undefined;
  if (!row || row.revision !== revision || !row.host_fingerprint || row.health_status !== 'ready')
    throw new Error('执行服务器不可恢复');
  const store = secrets.resource('execution-server', id);
  return createSshExecutionAdapter({
    locationId,
    host: row.host,
    port: row.port,
    username: row.username,
    password: row.auth_type === 'password' ? store.get('password') : undefined,
    privateKey: row.auth_type === 'private-key' ? store.get('privateKey') : undefined,
    passphrase: store.get('privateKeyPassphrase'),
    pinnedFingerprint: row.host_fingerprint,
  });
}
