import type Database from 'better-sqlite3';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { RunRuntimeEnvironmentFactory } from '../runs/orchestrator.js';
import type { ScopedSecretStore } from '../security/scoped-secret-store.js';
import type { ProjectTaskRuntime } from './task-runtime.js';
import { createDockerRuntimeFromAdapter, type DockerRuntime } from './execution-container.js';
import {
  createLocalExecutionAdapter,
  createSshExecutionAdapter,
  type ExecutionAdapter,
} from './execution-adapter.js';
import {
  ensureProjectImage,
  createProjectImagePreparationDependencies,
} from './image-preparation.js';
import {
  createExecutionImageCache,
  createLocationImageStateStore,
} from './execution-image-cache.js';
import { prepareProjectRunSource } from './run-source.js';
import { prepareProjectCommitTree, type ProjectCommitTree } from './image-source.js';
import {
  localDockerHostAddress,
  startComposeApplication,
  startSingleContainerApplication,
  staticRunEnvironment,
} from './application-runtime.js';
import { injectManagedFiles, managedFileSensitiveValues } from './managed-file-runtime.js';
import { readInstanceId } from './instance-id.js';
import { normalizeComposeDefinition, resolveNativeComposeConfig } from './compose-contract.js';
import { createExecutionResourceLedger } from './resource-ledger.js';
import { createHash } from 'node:crypto';
import { projectImageTag } from './image-builder.js';
import { materializeGeneratedDefinition, generatedDefinitionHash } from './generated-definition.js';
import { decodeProjectFileContent } from './file-content.js';
import type { EnvironmentStage } from '../../shared/environment-preparation.js';
import { TEST_ACCOUNT_FILE } from '../../shared/project-preparation.js';
import { createEnvironmentTimeline } from './environment-timing.js';
import type { EnvironmentValidationTask } from '../../shared/environment-preparation.js';

export function createProjectRunRuntimeEnvironmentFactory(input: {
  database: Database.Database;
  task: ProjectTaskRuntime;
  secrets: ScopedSecretStore;
  storageRoot: string;
  preparationResourceId?: string;
  onStage?: (stage: EnvironmentStage) => void;
  setManagedCommandTarget?: (
    runId: string,
    target: {
      docker: DockerRuntime;
      containerId: string;
      sourceRoot: string;
      workingDirectory: string;
    } | null,
  ) => void;
}): RunRuntimeEnvironmentFactory {
  return async (context) => {
    const preparationTimings: EnvironmentValidationTask['steps'] = [];
    const timeline = createEnvironmentTimeline(preparationTimings);
    const onStage = (stage: EnvironmentStage) => {
      timeline.enter(stage);
      input.onStage?.(stage);
    };
    const repositoryConfig = input.task.configuration.getRepository();
    if (input.task.runtimeMode !== 'managed') {
      const environment = staticRunEnvironment(input.task.runtimeMode, repositoryConfig.baseUrl);
      return {
        baseUrl: environment.baseUrl,
        browserAvailable: environment.browserAvailable,
        async close() {},
      };
    }
    onStage('source');
    const adapter: ExecutionAdapter = input.task.executionLocationId.startsWith('local:')
      ? createLocalExecutionAdapter(input.task.executionLocationId)
      : await (async () => {
          const serverId = input.task.executionLocationId.slice('server:'.length);
          const row = input.database
            .prepare('SELECT * FROM execution_servers WHERE server_id = ?')
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
            throw new Error('任务固定的远程执行服务器未验证或修订已变化；禁止回退本机');
          const store = input.secrets.resource('execution-server', serverId);
          return createSshExecutionAdapter({
            locationId: input.task.executionLocationId,
            host: row.host,
            port: row.port,
            username: row.username,
            password: row.auth_type === 'password' ? store.get('password') : undefined,
            privateKey: row.auth_type === 'private-key' ? store.get('privateKey') : undefined,
            passphrase: store.get('privateKeyPassphrase'),
            pinnedFingerprint: row.host_fingerprint,
          });
        })();
    const selectedDocker = createDockerRuntimeFromAdapter(adapter);
    const imageDependencies = createProjectImagePreparationDependencies(selectedDocker);
    if (input.task.executionLocationId.startsWith('server:'))
      imageDependencies.build = async (build) => {
        const remote = `/tmp/luowang/${readInstanceId(input.database)}/${input.task.projectId}/image-${context.targetCommit}`;
        await adapter.uploadTree(build.source.directory, remote, {
          signal: build.signal,
          timeoutMs: 10 * 60_000,
        });
        try {
          const dockerfile = `${remote}/${build.source.dockerfilePath}`;
          const iid = `${remote}/.luowang-iid`;
          const result = await adapter.execute(
            'docker',
            [
              'build',
              '--file',
              dockerfile,
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
            { timeoutMs: 30 * 60_000, signal: build.signal },
          );
          if (result.code !== 0) throw new Error('远程镜像构建失败');
          const local = `${input.storageRoot}/remote-iid-${context.runId}`;
          await adapter.download(iid, local, { signal: build.signal, timeoutMs: 60_000 });
          const imageId = (await import('node:fs/promises'))
            .readFile(local, 'utf8')
            .then((value) => value.trim());
          const resolved = await imageId;
          await (await import('node:fs/promises')).rm(local, { force: true });
          if (!/^sha256:[0-9a-f]{64}$/.test(resolved)) throw new Error('远程镜像 ID 无效');
          return {
            projectId: build.projectId,
            targetCommit: build.source.targetCommit,
            imageId: resolved,
            tag: projectImageTag(
              build.projectId,
              build.source.targetCommit,
              build.source.buildDefinition ?? build.source.dockerfilePath,
            ),
          };
        } finally {
          await adapter.removeTree(remote).catch(() => undefined);
        }
      };
    const remoteSource = input.task.executionLocationId.startsWith('server:')
      ? `/tmp/luowang/${readInstanceId(input.database)}/${input.task.projectId}/run-${context.runId}`
      : null;
    const acquisition = await (async () => {
      let source: Awaited<ReturnType<typeof prepareProjectRunSource>> | null = null;
      try {
        const platform = input.task.executionLocationId.startsWith('local:')
          ? `${process.platform}/${process.arch}`
          : ((
              JSON.parse(
                (
                  input.database
                    .prepare('SELECT capabilities_json FROM execution_servers WHERE server_id=?')
                    .get(input.task.executionLocationId.slice(7)) as {
                    capabilities_json: string;
                  }
                ).capabilities_json,
              ) as { platform?: string }
            ).platform ?? 'linux/unknown');
        onStage('executor');
        const image = await ensureProjectImage(
          {
            repository: context.repository,
            projectId: input.task.projectId,
            instanceId: readInstanceId(input.database),
            targetCommit: context.targetCommit,
            dockerfilePath: input.task.executionDockerfile,
            storageRoot: input.storageRoot,
            state: createLocationImageStateStore(input.database, {
              executionLocationId: input.task.executionLocationId,
              executionLocationRevision: input.task.executionLocationRevision,
              platform,
            }),
            signal: context.signal,
          },
          imageDependencies,
        );
        source = await prepareProjectRunSource({
          repository: context.repository,
          projectId: input.task.projectId,
          runId: context.runId,
          targetCommit: context.targetCommit,
          scenarioPatch: context.scenarioPatch,
          storageRoot: input.storageRoot,
          signal: context.signal,
        });
        await materializeGeneratedDefinition(
          source.directory,
          input.task.generatedDefinition ?? null,
        );
        if (remoteSource)
          await adapter.uploadTree(source.directory, remoteSource, {
            signal: context.signal,
            timeoutMs: 10 * 60_000,
          });
        const files = input.task.managedFiles.map((reference) => {
          const row = input.database
            .prepare(
              'SELECT revision FROM project_managed_files WHERE project_id = ? AND file_id = ?',
            )
            .get(input.task.projectId, reference.id) as { revision: number } | undefined;
          if (!row || row.revision !== reference.revision)
            throw new Error('受控配置文件版本与任务快照不一致');
          const content = input.secrets.resource('project-file', reference.id).get('content');
          if (!content) throw new Error('受控配置文件内容不可用');
          const decoded = decodeProjectFileContent(content);
          return {
            ...reference,
            serviceName:
              reference.serviceName ??
              (input.task.generatedDefinition && decoded.purpose === 'config'
                ? input.task.runtime.applicationService
                : null),
            content: decoded.purpose === 'config' ? decoded.bytes.toString('utf8') : '',
            bytes: decoded.bytes,
            purpose: decoded.purpose,
          };
        });
        const accountMode = input.task.generatedDefinition?.preparation.account.mode;
        if (accountMode && accountMode !== 'none') {
          const store = input.secrets.project(input.task.projectId);
          const username = store.get('testUsername');
          const password = store.get('testPassword');
          if (!username || !password)
            throw new Error('测试账号尚未准备，请在项目测试准备中保存方案或补充测试账号');
          if (files.some((file) => file.path === TEST_ACCOUNT_FILE))
            throw new Error('测试账号注入路径冲突');
          const content = JSON.stringify({ username, password });
          files.push({
            id: 'test-account',
            revision: 0,
            path: TEST_ACCOUNT_FILE,
            serviceName: input.task.runtime.commandService,
            content,
            bytes: Buffer.from(content),
            purpose: 'config',
          });
        }
        const ledger = createExecutionResourceLedger(
          input.database,
          readInstanceId(input.database),
        );
        const resource = input.preparationResourceId
          ? ledger.get(input.preparationResourceId)
          : ledger.plan({
              projectId: input.task.projectId,
              queueId: input.task.queueId,
              attemptId: context.runId,
              runId: context.runId,
              executionLocationId: input.task.executionLocationId,
              executionLocationRevision: input.task.executionLocationRevision,
              resourceType:
                input.task.startType === 'compose' ? 'compose-stack' : 'application-container',
              ownerLabels: {
                'luowang.instance-id': readInstanceId(input.database),
                'luowang.project-id': input.task.projectId,
                'luowang.attempt-id': context.runId,
              },
            });
        return { platform, image, source, files, ledger, resource };
      } catch (error) {
        if (remoteSource) await adapter.removeTree(remoteSource).catch(() => undefined);
        await source?.cleanup();
        await adapter.close();
        throw error;
      }
    })();
    const { platform, image, source, files, ledger, resource } = acquisition;
    const runtimeSource = remoteSource ?? source.directory;
    let composeBuildSource: ProjectCommitTree | null = null;
    let remoteBuildSource: string | null = null;
    let runtimeDefinitionHash = createHash('sha256')
      .update(input.task.executionDockerfile || '@builtin')
      .digest('hex');
    try {
      const owner =
        input.task.startType === 'compose'
          ? await (async () => {
              composeBuildSource = await prepareProjectCommitTree({
                repository: context.repository,
                projectId: input.task.projectId,
                targetCommit: context.targetCommit,
                storageRoot: input.storageRoot,
                sourceKind: 'image-sources',
                signal: context.signal,
              });
              await materializeGeneratedDefinition(
                composeBuildSource.directory,
                input.task.generatedDefinition ?? null,
              );
              const stagedFiles = await stageComposeManagedFiles(
                composeBuildSource.directory,
                // Managed env_file inputs may be read during native Compose resolution. The
                // implicit project .env remains fixed-commit input so a runtime Secret cannot
                // silently become a build argument.
                files.filter(
                  (file) =>
                    file.purpose === 'config' &&
                    file.path !== '.env' &&
                    file.path !== TEST_ACCOUNT_FILE,
                ),
              );
              let composeSource: string;
              try {
                onStage('parse');
                if (input.task.executionLocationId.startsWith('server:')) {
                  remoteBuildSource = `/tmp/luowang/${readInstanceId(input.database)}/${input.task.projectId}/build-${context.runId}`;
                  await adapter.uploadTree(composeBuildSource.directory, remoteBuildSource, {
                    signal: context.signal,
                    timeoutMs: 10 * 60_000,
                  });
                }
                const parseSource = remoteBuildSource ?? composeBuildSource.directory;
                composeSource = await resolveNativeComposeConfig({
                  adapter,
                  sourceDirectory: parseSource,
                  composeFile: input.task.runtime.composeFile,
                  signal: context.signal,
                });
              } finally {
                await stagedFiles.cleanup(
                  remoteBuildSource
                    ? async (path) => {
                        if (!adapter.removeFile) throw new Error('远程受控文件清理不可用');
                        await adapter.removeFile(`${remoteBuildSource}/${path}`);
                      }
                    : undefined,
                );
              }
              const buildSource = remoteBuildSource ?? composeBuildSource.directory;
              const publishHost = remoteSource ? '127.0.0.1' : localDockerHostAddress();
              const definition = normalizeComposeDefinition({
                source: composeSource,
                instanceId: readInstanceId(input.database),
                projectId: input.task.projectId,
                attemptId: context.runId,
                enabledServices: input.task.runtime.composeServices,
                applicationService: input.task.runtime.applicationService,
                commandService: input.task.runtime.commandService,
                servicePort: input.task.runtime.servicePort!,
                publishHost,
                composeFile: input.task.runtime.composeFile,
                generatedContentHash: input.task.generatedDefinition
                  ? generatedDefinitionHash(input.task.generatedDefinition)
                  : undefined,
              });
              runtimeDefinitionHash = definition.definitionHash;
              const cachedImageIds: Record<string, string> = {};
              const composeCache = createExecutionImageCache(input.database);
              for (const serviceName of input.task.runtime.composeServices) {
                const cached = composeCache.get({
                  executionLocationId: input.task.executionLocationId,
                  executionLocationRevision: input.task.executionLocationRevision,
                  projectId: input.task.projectId,
                  targetCommit: context.targetCommit,
                  buildDefinitionHash: createHash('sha256')
                    .update(`${runtimeDefinitionHash}:${serviceName}`)
                    .digest('hex'),
                  platform,
                });
                if (cached?.status === 'ready' && cached.imageId)
                  cachedImageIds[serviceName] = cached.imageId;
              }
              return startComposeApplication({
                onStage,
                docker: selectedDocker,
                definition,
                buildSourceDirectory: buildSource,
                commandSourceDirectory: runtimeSource,
                targetCommit: context.targetCommit,
                cachedImageIds,
                runtime: input.task.runtime,
                signal: context.signal,
                publishHost,
                resolveBaseUrl: adapter.openTunnel
                  ? async (port) => {
                      const tunnel = await adapter.openTunnel!('127.0.0.1', port);
                      return { baseUrl: `http://127.0.0.1:${tunnel.port}`, close: tunnel.close };
                    }
                  : undefined,
                writeDefinition: remoteSource
                  ? async (content) => {
                      const local = `${input.storageRoot}/compose-${context.runId}.yml`;
                      await (
                        await import('node:fs/promises')
                      ).writeFile(local, content, { flag: 'wx', mode: 0o600 });
                      const remote = `${posix.dirname(remoteBuildSource!)}/.luowang-${definition.projectName}.compose.yml`;
                      try {
                        await adapter.upload(local, remote, {
                          signal: context.signal,
                          timeoutMs: 60_000,
                        });
                      } catch (error) {
                        await (await import('node:fs/promises')).rm(local, { force: true });
                        throw error;
                      }
                      return {
                        path: remote,
                        remove: async () => {
                          try {
                            if (!adapter.removeFile) throw new Error('远程 Compose 配置清理不可用');
                            await adapter.removeFile(remote);
                          } finally {
                            await (await import('node:fs/promises')).rm(local, { force: true });
                          }
                        },
                      };
                    }
                  : undefined,
                prepareSourceVolume: async (service, containerId, destinationRoot) => {
                  const selected = files.filter(
                    (file) =>
                      file.serviceName === service ||
                      (file.serviceName === null && service === definition.commandService),
                  );
                  await injectManagedFiles({
                    docker: selectedDocker,
                    executionAdapter: adapter,
                    containerId,
                    serviceName: service,
                    destinationRoot,
                    files: selected,
                    signal: context.signal,
                  });
                },
                afterStart: async (service, containerId, managedFileRoot) => {
                  const selected = files.filter(
                    (file) =>
                      file.serviceName === service ||
                      (file.serviceName === null && service === definition.commandService),
                  );
                  if (selected.length > 0 && !managedFileRoot)
                    throw new Error(
                      `Compose 服务 ${service} 没有明确的源码根挂载，不能注入受控文件`,
                    );
                  await injectManagedFiles({
                    docker: selectedDocker,
                    executionAdapter: adapter,
                    containerId,
                    serviceName: service,
                    destinationRoot: managedFileRoot ?? undefined,
                    files: selected,
                    signal: context.signal,
                  });
                },
              });
            })()
          : await startSingleContainerApplication({
              onStage,
              docker: selectedDocker,
              instanceId: readInstanceId(input.database),
              projectId: input.task.projectId,
              runId: context.runId,
              targetCommit: context.targetCommit,
              imageId: image.imageId,
              sourceDirectory: runtimeSource,
              runtime: input.task.runtime,
              signal: context.signal,
              publishHost: remoteSource ? '127.0.0.1' : localDockerHostAddress(),
              resolveBaseUrl: adapter.openTunnel
                ? async (port) => {
                    const tunnel = await adapter.openTunnel!('127.0.0.1', port);
                    return { baseUrl: `http://127.0.0.1:${tunnel.port}`, close: tunnel.close };
                  }
                : undefined,
              beforeStart: (containerId) =>
                injectManagedFiles({
                  docker: selectedDocker,
                  executionAdapter: adapter,
                  containerId,
                  files,
                  signal: context.signal,
                }),
            });
      if (input.task.startType === 'compose') {
        const cache = createExecutionImageCache(input.database);
        for (const serviceName of input.task.runtime.composeServices) {
          const service = (
            input.task.startType === 'compose' ? owner.environment.serviceImages : undefined
          )?.[serviceName];
          if (!service) continue;
          const key = {
            executionLocationId: input.task.executionLocationId,
            executionLocationRevision: input.task.executionLocationRevision,
            projectId: input.task.projectId,
            targetCommit: context.targetCommit,
            buildDefinitionHash: createHash('sha256')
              .update(`${runtimeDefinitionHash}:${serviceName}`)
              .digest('hex'),
            platform,
          };
          const existing = cache.get(key);
          if (existing?.status !== 'ready' || existing.imageId !== service) {
            cache.begin(key);
            cache.ready(key, service);
          }
        }
      }
      timeline.finish('passed');
      ledger.transition(resource.resourceId, 'planned', 'created', owner.resourceExternalId);
      if (!input.preparationResourceId)
        input.database
          .prepare(
            `INSERT INTO run_execution_context(run_id,project_id,execution_location_id,execution_location_revision,config_revision,target_commit,start_type,build_definition_hash,image_id,scenario_patch_sha256,runtime_environment_json,cleanup_state,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'created',?) ON CONFLICT(run_id) DO UPDATE SET scenario_patch_sha256=excluded.scenario_patch_sha256,runtime_environment_json=excluded.runtime_environment_json,cleanup_state='created',recorded_at=excluded.recorded_at`,
          )
          .run(
            context.runId,
            input.task.projectId,
            input.task.executionLocationId,
            input.task.executionLocationRevision,
            input.task.configRevision,
            context.targetCommit,
            input.task.startType,
            runtimeDefinitionHash,
            owner.imageIds[owner.environment.applicationService ?? 'app'] ?? image.imageId,
            source.scenarioPatchSha256,
            JSON.stringify({
              ...owner.environment,
              preparationTimings,
              managedFiles: files.map((file) => ({
                id: file.id,
                revision: file.revision,
                path: file.path,
                purpose: file.purpose,
                serviceName: file.serviceName ?? owner.environment.commandService,
                byteSize: file.bytes.length,
                ...(file.purpose === 'data'
                  ? { sha256: createHash('sha256').update(file.bytes).digest('hex') }
                  : {}),
              })),
            }),
            new Date().toISOString(),
          );
      input.setManagedCommandTarget?.(context.runId, {
        docker: selectedDocker,
        containerId: owner.containerId,
        sourceRoot: owner.commandSourceRoot,
        workingDirectory: `${owner.commandSourceRoot}${
          input.task.runtime.workingDirectory === '.'
            ? ''
            : `/${input.task.runtime.workingDirectory}`
        }`,
      });
      return {
        baseUrl: owner.environment.baseUrl,
        browserAvailable: owner.environment.browserAvailable,
        sensitiveValues: managedFileSensitiveValues(files),
        preparationResults: (owner.environment.preparationResults ?? []).map((result) => ({
          kind: result.kind,
          label: input.task.runtime.preparationChecks?.[result.step - 1]?.label ?? result.kind,
          exitCode: result.exitCode,
        })),
        async close() {
          onStage('cleanup');
          let cleanupSucceeded = false;
          input.setManagedCommandTarget?.(context.runId, null);
          ledger.transition(resource.resourceId, 'created', 'cleanup_pending');
          input.database
            .prepare(
              "UPDATE run_execution_context SET cleanup_state='cleanup_pending' WHERE run_id=?",
            )
            .run(context.runId);
          try {
            await owner.close();
            if (remoteSource) await adapter.removeTree(remoteSource);
            if (remoteBuildSource) await adapter.removeTree(remoteBuildSource);
            ledger.transition(resource.resourceId, 'cleanup_pending', 'released');
            input.database
              .prepare("UPDATE run_execution_context SET cleanup_state='released' WHERE run_id=?")
              .run(context.runId);
            cleanupSucceeded = true;
          } catch (error) {
            ledger.transition(
              resource.resourceId,
              'cleanup_pending',
              'unknown',
              null,
              'CLEANUP_UNCONFIRMED',
            );
            input.database
              .prepare("UPDATE run_execution_context SET cleanup_state='unknown' WHERE run_id=?")
              .run(context.runId);
            throw error;
          } finally {
            let finalized = false;
            try {
              await source.cleanup();
              await composeBuildSource?.cleanup();
              await adapter.close();
              finalized = true;
            } finally {
              timeline.finish(cleanupSucceeded && finalized ? 'passed' : 'failed');
              input.database
                .prepare(
                  "UPDATE run_execution_context SET runtime_environment_json=json_set(runtime_environment_json,'$.preparationTimings',json(?)) WHERE run_id=? AND project_id=?",
                )
                .run(JSON.stringify(preparationTimings), context.runId, input.task.projectId);
            }
          }
        },
      };
    } catch (error) {
      input.setManagedCommandTarget?.(context.runId, null);
      try {
        ledger.transition(resource.resourceId, 'planned', 'unknown', null, 'CREATE_UNCONFIRMED');
      } catch {
        /* Preserve the creation failure if the resource state was concurrently reconciled. */
      }
      if (remoteSource) await adapter.removeTree(remoteSource).catch(() => undefined);
      if (remoteBuildSource) await adapter.removeTree(remoteBuildSource).catch(() => undefined);
      await source.cleanup();
      await (composeBuildSource as ProjectCommitTree | null)?.cleanup();
      await adapter.close();
      throw error;
    }
  };
}

async function stageComposeManagedFiles(
  sourceDirectory: string,
  files: Array<{ path: string; content: string }>,
): Promise<{ cleanup(removeRemote?: (path: string) => Promise<void> | undefined): Promise<void> }> {
  const staged: Array<{ path: string; local: string }> = [];
  try {
    for (const file of files) {
      const local = resolve(sourceDirectory, ...file.path.split('/'));
      const remainder = relative(sourceDirectory, local);
      if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder))
        throw new Error('Compose 受控文件路径越界');
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, file.content, { flag: 'wx', mode: 0o600 });
      staged.push({ path: file.path, local });
    }
  } catch (error) {
    await Promise.allSettled(staged.map((file) => rm(file.local, { force: true })));
    throw error;
  }
  return {
    async cleanup(removeRemote) {
      let failure: unknown;
      for (const file of staged) {
        try {
          if (removeRemote) await removeRemote(file.path);
        } catch (error) {
          failure ??= error;
        } finally {
          await rm(file.local, { force: true });
        }
      }
      if (failure) throw failure;
    },
  };
}
