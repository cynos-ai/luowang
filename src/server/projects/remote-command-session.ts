import type Database from 'better-sqlite3';
import type { RunCommandSessionFactory } from '../runs/orchestrator.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectTaskRuntime } from './task-runtime.js';
import { createSshExecutionAdapter } from './execution-adapter.js';
import {
  createDockerRuntimeFromAdapter,
  startProjectCommandSession,
} from './execution-container.js';
import { prepareProjectRunSource } from './run-source.js';
import { createLocationImageStateStore } from './execution-image-cache.js';
import {
  createProjectImagePreparationDependencies,
  ensureProjectImage,
} from './image-preparation.js';
import { readInstanceId } from './instance-id.js';
import { readFile, rm } from 'node:fs/promises';

export function createRemoteProjectRunCommandSessionFactory(input: {
  database: Database.Database;
  task: ProjectTaskRuntime;
  secrets: ScopedSecretStore;
  storageRoot: string;
}): RunCommandSessionFactory {
  return async (context) => {
    const serverId = input.task.executionLocationId.slice('server:'.length);
    const row = input.database
      .prepare('SELECT * FROM execution_servers WHERE server_id=?')
      .get(serverId) as
      | {
          revision: number;
          host: string;
          port: number;
          username: string;
          host_fingerprint: string | null;
          health_status: string;
          auth_type: 'password' | 'private-key';
        }
      | undefined;
    if (
      !row ||
      row.revision !== input.task.executionLocationRevision ||
      row.health_status !== 'ready' ||
      !row.host_fingerprint
    )
      throw new Error('任务固定的远程执行服务器不可用；禁止回退本机');
    const secret = input.secrets.resource('execution-server', serverId);
    const adapter = await createSshExecutionAdapter({
      locationId: input.task.executionLocationId,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.auth_type === 'password' ? secret.get('password') : undefined,
      privateKey: row.auth_type === 'private-key' ? secret.get('privateKey') : undefined,
      passphrase: secret.get('privateKeyPassphrase'),
      pinnedFingerprint: row.host_fingerprint,
    });
    const docker = createDockerRuntimeFromAdapter(adapter);
    const capabilities = JSON.parse(
      (
        input.database
          .prepare('SELECT capabilities_json FROM execution_servers WHERE server_id=?')
          .get(serverId) as { capabilities_json: string }
      ).capabilities_json,
    ) as { platform?: string };
    const state = createLocationImageStateStore(input.database, {
      executionLocationId: input.task.executionLocationId,
      executionLocationRevision: input.task.executionLocationRevision,
      platform: capabilities.platform ?? 'linux/unknown',
    });
    const dependencies = createProjectImagePreparationDependencies(docker);
    dependencies.build = async (build) => {
      const remote = `/tmp/luowang/${readInstanceId(input.database)}/${input.task.projectId}/command-image-${context.runId}`;
      const localIid = `${input.storageRoot}/remote-command-iid-${context.runId}`;
      await adapter.uploadTree(build.source.directory, remote);
      try {
        const iid = `${remote}/.luowang-iid`;
        const result = await adapter.execute(
          'docker',
          [
            'build',
            '--file',
            `${remote}/${build.source.dockerfilePath}`,
            '--iidfile',
            iid,
            '--label',
            `luowang.project-id=${build.projectId}`,
            '--label',
            `luowang.instance-id=${build.instanceId}`,
            '--label',
            `luowang.target-commit=${build.source.targetCommit}`,
            '--label',
            `luowang.build-definition=${build.source.buildDefinition ?? build.source.dockerfilePath}`,
            remote,
          ],
          { timeoutMs: 30 * 60_000, signal: context.signal },
        );
        if (result.code !== 0) throw new Error('远程镜像构建失败');
        await adapter.download(iid, localIid);
        const imageId = (await readFile(localIid, 'utf8')).trim();
        if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('远程镜像 ID 无效');
        return {
          projectId: build.projectId,
          targetCommit: build.source.targetCommit,
          imageId,
          tag: `luowang-project-${build.projectId}:${build.source.targetCommit}`,
        };
      } finally {
        await rm(localIid, { force: true });
        await adapter.removeTree(remote).catch(() => undefined);
      }
    };
    const image = await ensureProjectImage(
      {
        repository: context.repository,
        projectId: input.task.projectId,
        instanceId: readInstanceId(input.database),
        targetCommit: context.targetCommit,
        dockerfilePath: input.task.executionDockerfile,
        storageRoot: input.storageRoot,
        state,
      },
      dependencies,
    ).catch(async (error) => {
      await adapter.close();
      throw error;
    });
    const source = await prepareProjectRunSource({
      repository: context.repository,
      projectId: input.task.projectId,
      runId: context.runId,
      targetCommit: context.targetCommit,
      scenarioPatch: context.scenarioPatch,
      storageRoot: input.storageRoot,
    });
    const remote = `/tmp/luowang/${readInstanceId(input.database)}/${input.task.projectId}/command-${context.runId}`;
    try {
      await adapter.uploadTree(source.directory, remote);
      const session = await startProjectCommandSession(
        {
          signal: context.signal,
          onExitUnconfirmed: context.onExitUnconfirmed,
          projectId: input.task.projectId,
          instanceId: readInstanceId(input.database),
          runId: context.runId,
          targetCommit: context.targetCommit,
          imageId: image.imageId,
          repositoryDirectory: context.repository.directory,
          sourceRoot: input.storageRoot,
          runSource: source,
          executionSourceDirectory: remote,
        },
        docker,
      );
      return {
        run: (command, options) => session.run(command, options),
        async close() {
          try {
            await session.close();
            await adapter.removeTree(remote);
          } finally {
            await source.cleanup();
            await adapter.close();
          }
        },
      };
    } catch (error) {
      await adapter.removeTree(remote).catch(() => undefined);
      await source.cleanup();
      await adapter.close();
      throw error;
    }
  };
}
