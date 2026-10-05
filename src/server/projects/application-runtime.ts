import { existsSync, readFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import type { DockerRuntime } from './execution-container.js';
import type { ProjectRuntimeDefinition } from './configuration.js';
import { ControlledCommandError } from '../runs/command-runner.js';
import type { ControlledComposeDefinition } from './compose-contract.js';

export type RunRuntimeEnvironment = {
  mode: 'managed' | 'external' | 'repository-only';
  baseUrl: string | null;
  browserAvailable: boolean;
  applicationReady: boolean;
  applicationService: string | null;
  commandService: string | null;
  serviceImages?: Record<string, string>;
};
export interface ManagedApplicationRuntime {
  readonly containerId: string;
  readonly resourceExternalId: string;
  readonly commandSourceRoot: string;
  readonly environment: RunRuntimeEnvironment;
  readonly imageIds: Record<string, string>;
  close(): Promise<void>;
}

export async function startSingleContainerApplication(input: {
  docker: DockerRuntime;
  instanceId: string;
  projectId: string;
  runId: string;
  targetCommit: string;
  imageId: string;
  sourceDirectory: string;
  runtime: ProjectRuntimeDefinition;
  signal?: AbortSignal;
  publishHost?: string;
  resolveBaseUrl?: (hostPort: number) => Promise<{ baseUrl: string; close(): Promise<void> }>;
  beforeStart?: (containerId: string) => Promise<void>;
}): Promise<ManagedApplicationRuntime> {
  if (!input.runtime.servicePort || input.runtime.startCommand.length === 0)
    throw new ControlledCommandError('COMMAND_INVALID', '单容器启动配置不完整');
  const name = `luowang-app-${input.runId.toLowerCase()}`;
  input.signal?.throwIfAborted();
  const publishHost = input.publishHost ?? localDockerHostAddress();
  const controlId = input.resolveBaseUrl ? null : containerControlIdentity();
  const accessNetwork = controlId
    ? `lw-${input.projectId.slice(0, 8)}-${input.runId.slice(0, 8)}-access`.toLowerCase()
    : null;
  if (accessNetwork)
    await success(
      input.docker,
      [
        'network',
        'create',
        '--label',
        `luowang.instance-id=${input.instanceId}`,
        '--label',
        `luowang.project-id=${input.projectId}`,
        '--label',
        `luowang.attempt-id=${input.runId}`,
        accessNetwork,
      ],
      30_000,
      input.signal,
    );
  let created: Awaited<ReturnType<typeof success>>;
  try {
    created = await success(
      input.docker,
      [
        'create',
        '--name',
        name,
        '--label',
        `luowang.instance-id=${input.instanceId}`,
        '--label',
        `luowang.project-id=${input.projectId}`,
        '--label',
        `luowang.attempt-id=${input.runId}`,
        '--label',
        `luowang.target-commit=${input.targetCommit}`,
        '--publish',
        `${publishHost}::${input.runtime.servicePort}`,
        ...(accessNetwork ? ['--network', accessNetwork] : []),
        '--workdir',
        '/luowang-source',
        '--entrypoint',
        'sleep',
        input.imageId,
        'infinity',
      ],
      30_000,
      input.signal,
    );
  } catch (error) {
    if (accessNetwork)
      await removeNetworkConfirmed(input.docker, accessNetwork).catch(() => undefined);
    throw error;
  }
  const containerId = created.stdout.trim();
  let controlConnected = false;
  try {
    await success(
      input.docker,
      ['cp', `${input.sourceDirectory}/.`, `${containerId}:/luowang-source`],
      120_000,
      input.signal,
    );
    input.signal?.throwIfAborted();
    await input.beforeStart?.(containerId);
    input.signal?.throwIfAborted();
    await success(input.docker, ['start', containerId], 30_000, input.signal);
    if (accessNetwork && controlId) {
      await success(
        input.docker,
        ['network', 'connect', accessNetwork, controlId],
        30_000,
        input.signal,
      );
      controlConnected = true;
    }
    if (input.runtime.prepareCommand.length)
      await success(
        input.docker,
        [
          'exec',
          '--workdir',
          `/luowang-source/${input.runtime.workingDirectory === '.' ? '' : input.runtime.workingDirectory}`,
          containerId,
          ...input.runtime.prepareCommand,
        ],
        15 * 60_000,
        input.signal,
      );
    input.signal?.throwIfAborted();
    await success(
      input.docker,
      [
        'exec',
        '--detach',
        '--workdir',
        `/luowang-source/${input.runtime.workingDirectory === '.' ? '' : input.runtime.workingDirectory}`,
        containerId,
        ...input.runtime.startCommand,
      ],
      30_000,
      input.signal,
    );
    let hostPort: number | null = null;
    if (!accessNetwork || input.resolveBaseUrl) {
      const port = await success(
        input.docker,
        ['port', containerId, `${input.runtime.servicePort}/tcp`],
        10_000,
        input.signal,
      );
      hostPort = Number(/:(\d+)\s*$/.exec(port.stdout)?.[1]);
      if (!Number.isInteger(hostPort)) throw new Error('无法解析临时入口端口');
    }
    const endpoint = input.resolveBaseUrl
      ? await input.resolveBaseUrl(hostPort!)
      : accessNetwork
        ? {
            baseUrl: `http://${await containerNetworkAddress(
              input.docker,
              containerId,
              accessNetwork,
              input.signal,
            )}:${input.runtime.servicePort}`,
            async close() {
              if (controlConnected)
                await disconnectNetwork(input.docker, {
                  name: accessNetwork,
                  containerId: controlId!,
                });
              controlConnected = false;
            },
          }
        : {
            baseUrl: `http://${publishHost}:${hostPort}`,
            async close() {},
          };
    input.signal?.throwIfAborted();
    const baseUrl = endpoint.baseUrl;
    await waitForHealth(
      `${baseUrl}${input.runtime.healthPath}`,
      input.runtime.healthTimeoutSeconds,
      input.signal,
    );
    let closed = false;
    return {
      containerId,
      resourceExternalId: containerId,
      commandSourceRoot: '/luowang-source',
      imageIds: { app: input.imageId },
      environment: {
        mode: 'managed',
        baseUrl,
        browserAvailable: true,
        applicationReady: true,
        applicationService: 'app',
        commandService: 'app',
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await endpoint.close();
        } finally {
          try {
            await removeConfirmed(input.docker, containerId);
          } finally {
            if (accessNetwork) await removeNetworkConfirmed(input.docker, accessNetwork);
          }
        }
      },
    };
  } catch (error) {
    if (controlConnected)
      await disconnectNetwork(input.docker, {
        name: accessNetwork!,
        containerId: controlId!,
      }).catch(() => undefined);
    await removeConfirmed(input.docker, containerId).catch(() => undefined);
    if (accessNetwork)
      await removeNetworkConfirmed(input.docker, accessNetwork).catch(() => undefined);
    throw error;
  }
}

export async function startComposeApplication(input: {
  docker: DockerRuntime;
  definition: ControlledComposeDefinition;
  buildSourceDirectory: string;
  commandSourceDirectory: string;
  targetCommit: string;
  cachedImageIds?: Record<string, string>;
  runtime: ProjectRuntimeDefinition;
  signal?: AbortSignal;
  publishHost?: string;
  resolveBaseUrl?: (hostPort: number) => Promise<{ baseUrl: string; close(): Promise<void> }>;
  writeDefinition?: (content: string) => Promise<{ path: string; remove(): Promise<void> }>;
  prepareSourceVolume?: (
    service: string,
    helperContainerId: string,
    destinationRoot: string,
  ) => Promise<void>;
  afterStart?: (
    service: string,
    containerId: string,
    managedFileRoot: string | null,
  ) => Promise<void>;
}): Promise<ManagedApplicationRuntime> {
  const localFile = join(
    dirname(input.buildSourceDirectory),
    `.luowang-${input.definition.projectName}.compose.yml`,
  );
  const composePrefix = [
    'compose',
    '--project-name',
    input.definition.projectName,
    '--project-directory',
    input.buildSourceDirectory,
    '--file',
  ];
  const controlled = {
    name: input.definition.projectName,
    services: structuredClone(input.definition.services),
    networks: input.definition.networks,
    volumes: input.definition.volumes,
  };
  const sourceVolumes: Array<{
    service: string;
    source: string;
    target: string;
    volumeKey: string;
    volumeName: string;
    sourceDirectory: string;
  }> = [];
  for (const [serviceName, service] of Object.entries(controlled.services)) {
    if (Array.isArray(service.volumes)) {
      service.volumes = service.volumes.map((mount, index) => {
        if (typeof mount !== 'string') return mount;
        const [source, target] = mount.split(':');
        if (!source.startsWith('.') && !source.includes('/')) return mount;
        const root =
          serviceName === input.definition.commandService
            ? input.commandSourceDirectory
            : input.buildSourceDirectory;
        const suffix = `${serviceName}-${index}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
        const volumeKey = `luowang_source_${suffix.replace(/[.-]/g, '_')}`;
        const volumeName = `${input.definition.projectName}-src-${suffix}`;
        controlled.volumes[volumeKey] = {
          name: volumeName,
          external: false,
          labels: service.labels,
        };
        sourceVolumes.push({
          service: serviceName,
          source,
          target,
          volumeKey,
          volumeName,
          sourceDirectory: root.startsWith('/')
            ? posix.resolve(root, source)
            : resolve(root, source.replaceAll('/', '\\')),
        });
        return `${volumeKey}:${target}:ro`;
      });
    }
    if (service.build && typeof service.build === 'object') {
      const build = service.build as Record<string, unknown>;
      const ownership = service.labels as Record<string, string>;
      build.labels = {
        'luowang.instance-id': ownership['luowang.instance-id'],
        'luowang.project-id': ownership['luowang.project-id'],
        'luowang.target-commit': input.targetCommit,
        'luowang.build-definition': `${input.definition.definitionHash}:${serviceName}`,
      };
      const cachedImageId = input.cachedImageIds?.[serviceName];
      if (
        cachedImageId &&
        (await composeImageMatches(
          input.docker,
          cachedImageId,
          {
            'luowang.instance-id': ownership['luowang.instance-id'],
            'luowang.project-id': ownership['luowang.project-id'],
            'luowang.target-commit': input.targetCommit,
            'luowang.build-definition': `${input.definition.definitionHash}:${serviceName}`,
          },
          input.signal,
        ))
      ) {
        service.image = cachedImageId;
        delete service.build;
      } else {
        service.image = `luowang-compose-${ownership['luowang.project-id'].slice(0, 8)}:${input.targetCommit.slice(0, 12)}-${input.definition.definitionHash.slice(0, 12)}-${serviceName.toLowerCase()}`;
      }
    }
    if (
      typeof service.image === 'string' &&
      !String(service.image).includes('@sha256:') &&
      !/^sha256:[0-9a-f]{64}$/.test(String(service.image))
    ) {
      if (service.build) continue;
      await success(input.docker, ['pull', String(service.image)], 10 * 60_000, input.signal);
      const digest = await success(
        input.docker,
        ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', String(service.image)],
        10_000,
        input.signal,
      );
      if (!/@sha256:[0-9a-f]{64}$/.test(digest.stdout.trim()))
        throw new ControlledCommandError('COMMAND_FAILED', 'Compose 外部镜像无法固定 digest');
      service.image = digest.stdout.trim();
    }
  }
  const definitionFile = input.writeDefinition
    ? await input.writeDefinition(stringify(controlled))
    : (await writeFile(localFile, stringify(controlled), { flag: 'wx', mode: 0o600 }),
      { path: localFile, remove: () => rm(localFile, { force: true }) });
  input.signal?.throwIfAborted();
  const file = definitionFile.path;
  let started = false;
  let controlNetwork: { name: string; containerId: string } | null = null;
  let endpoint: { baseUrl: string; close(): Promise<void> } | null = null;
  const imageIds: Record<string, string> = {};
  const containerIds: Record<string, string> = {};
  try {
    input.signal?.throwIfAborted();
    if (Object.values(controlled.services).some((service) => service.build))
      await success(
        input.docker,
        [...composePrefix, file, 'build', '--pull=false'],
        30 * 60_000,
        input.signal,
      );
    input.signal?.throwIfAborted();
    await success(
      input.docker,
      [...composePrefix, file, 'create', '--no-build', ...Object.keys(controlled.services)],
      5 * 60_000,
      input.signal,
    );
    started = true;
    const controlId = input.resolveBaseUrl ? null : containerControlIdentity();
    if (controlId) {
      const applicationNetworks = controlled.services[input.definition.applicationService]
        .networks as string[];
      const networkKey = applicationNetworks[0];
      const networkName = String(controlled.networks[networkKey]?.name ?? '');
      if (!networkName)
        throw new ControlledCommandError('COMMAND_FAILED', 'Compose 应用网络身份无效');
      await success(
        input.docker,
        ['network', 'connect', networkName, controlId],
        30_000,
        input.signal,
      );
      controlNetwork = { name: networkName, containerId: controlId };
    }
    for (const sourceVolume of sourceVolumes) {
      const service = controlled.services[sourceVolume.service];
      const image = String(service.image ?? '');
      if (!image)
        throw new ControlledCommandError(
          'COMMAND_FAILED',
          `Compose 源码卷无法确定服务镜像：${sourceVolume.service}`,
        );
      await populateSourceVolume({
        docker: input.docker,
        volumeName: sourceVolume.volumeName,
        sourceDirectory: sourceVolume.sourceDirectory,
        image,
        labels: service.labels as Record<string, string>,
        signal: input.signal,
        beforeRemove:
          sourceVolume.source === '.' && input.prepareSourceVolume
            ? (helperContainerId) =>
                input.prepareSourceVolume!(
                  sourceVolume.service,
                  helperContainerId,
                  '/luowang-volume',
                )
            : undefined,
      });
    }
    for (const service of Object.keys(controlled.services)) {
      const id = (
        await success(
          input.docker,
          [...composePrefix, file, 'ps', '--all', '--quiet', service],
          10_000,
          input.signal,
        )
      ).stdout.trim();
      if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`Compose 服务未创建：${service}`);
      containerIds[service] = id;
      const imageId = (
        await success(input.docker, ['inspect', '--format', '{{.Image}}', id], 10_000, input.signal)
      ).stdout.trim();
      if (!/^sha256:[0-9a-f]{64}$/.test(imageId))
        throw new Error(`Compose 服务镜像身份无效：${service}`);
      imageIds[service] = imageId;
      if (
        service === input.definition.commandService &&
        !sourceVolumes.some((mount) => mount.service === service && mount.source === '.')
      ) {
        await success(
          input.docker,
          ['cp', `${input.commandSourceDirectory}/.`, `${id}:/luowang-source`],
          120_000,
          input.signal,
        );
      }
      const roots = sourceVolumes.filter(
        (mount) => mount.service === service && mount.source === '.',
      );
      if (roots.length > 1)
        throw new ControlledCommandError(
          'COMMAND_INVALID',
          `Compose 服务存在多个源码根挂载：${service}`,
        );
      if (roots.length === 0) {
        const managedFileRoot =
          service === input.definition.commandService ? '/luowang-source' : null;
        input.signal?.throwIfAborted();
        await input.afterStart?.(service, id, managedFileRoot);
        input.signal?.throwIfAborted();
      }
    }
    input.signal?.throwIfAborted();
    await success(
      input.docker,
      [...composePrefix, file, 'start', ...Object.keys(controlled.services)],
      5 * 60_000,
      input.signal,
    );
    let hostPort: number | null = null;
    if (input.resolveBaseUrl || !controlNetwork) {
      const port = await success(
        input.docker,
        [
          ...composePrefix,
          file,
          'port',
          input.definition.applicationService,
          String(input.definition.servicePort),
        ],
        10_000,
        input.signal,
      );
      hostPort = Number(/:(\d+)\s*$/.exec(port.stdout)?.[1]);
      if (!Number.isInteger(hostPort)) throw new Error('无法解析 Compose 临时入口端口');
    }
    endpoint = input.resolveBaseUrl
      ? await input.resolveBaseUrl(hostPort!)
      : controlNetwork
        ? {
            baseUrl: `http://${await containerNetworkAddress(
              input.docker,
              containerIds[input.definition.applicationService],
              controlNetwork.name,
              input.signal,
            )}:${input.definition.servicePort}`,
            async close() {
              await disconnectNetwork(input.docker, controlNetwork!);
            },
          }
        : {
            baseUrl: `http://${input.publishHost ?? localDockerHostAddress()}:${hostPort}`,
            async close() {},
          };
    input.signal?.throwIfAborted();
    const baseUrl = endpoint.baseUrl;
    await waitForHealth(
      `${baseUrl}${input.runtime.healthPath}`,
      input.runtime.healthTimeoutSeconds,
      input.signal,
    );
    const commandId = (
      await success(
        input.docker,
        [...composePrefix, file, 'ps', '--quiet', input.definition.commandService],
        10_000,
        input.signal,
      )
    ).stdout.trim();
    let closed = false;
    return {
      containerId: commandId,
      resourceExternalId: input.definition.projectName,
      commandSourceRoot:
        sourceVolumes.find(
          (mount) => mount.service === input.definition.commandService && mount.source === '.',
        )?.target ?? '/luowang-source',
      imageIds,
      environment: {
        mode: 'managed',
        baseUrl,
        browserAvailable: true,
        applicationReady: true,
        applicationService: input.definition.applicationService,
        commandService: input.definition.commandService,
        serviceImages: imageIds,
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await endpoint!.close();
          await composeDown(
            input.docker,
            input.definition.projectName,
            input.buildSourceDirectory,
            file,
          );
        } finally {
          await definitionFile.remove();
        }
      },
    };
  } catch (error) {
    if (endpoint) await endpoint.close().catch(() => undefined);
    else if (controlNetwork)
      await disconnectNetwork(input.docker, controlNetwork).catch(() => undefined);
    if (started)
      await composeDown(
        input.docker,
        input.definition.projectName,
        input.buildSourceDirectory,
        file,
      ).catch(() => undefined);
    await definitionFile.remove();
    throw error;
  }
}

async function composeImageMatches(
  docker: DockerRuntime,
  imageId: string,
  expectedLabels: Record<string, string>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) return false;
  const result = await docker.run(
    ['image', 'inspect', '--format', '{{json .Config.Labels}}', imageId],
    { timeoutMs: 10_000, signal },
  );
  if (result.exitCode !== 0) return false;
  try {
    const labels = JSON.parse(result.stdout) as Record<string, string>;
    return Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
  } catch {
    return false;
  }
}

async function populateSourceVolume(input: {
  docker: DockerRuntime;
  volumeName: string;
  sourceDirectory: string;
  image: string;
  labels: Record<string, string>;
  signal?: AbortSignal;
  beforeRemove?: (helperContainerId: string) => Promise<void>;
}): Promise<void> {
  const createArgs = ['create'];
  for (const [key, value] of Object.entries(input.labels))
    createArgs.push('--label', `${key}=${value}`);
  createArgs.push(
    '--mount',
    `type=volume,source=${input.volumeName},target=/luowang-volume`,
    '--entrypoint',
    'true',
    input.image,
  );
  const helper = (await success(input.docker, createArgs, 30_000, input.signal)).stdout.trim();
  if (!/^[0-9a-f]{12,64}$/.test(helper))
    throw new ControlledCommandError('COMMAND_FAILED', 'Compose 源码卷临时容器身份无效');
  try {
    await success(
      input.docker,
      ['cp', `${input.sourceDirectory}/.`, `${helper}:/luowang-volume`],
      120_000,
      input.signal,
    );
    input.signal?.throwIfAborted();
    await input.beforeRemove?.(helper);
    input.signal?.throwIfAborted();
  } finally {
    await removeConfirmed(input.docker, helper);
  }
}

export function staticRunEnvironment(
  mode: 'external' | 'repository-only',
  baseUrl: string,
): RunRuntimeEnvironment {
  return {
    mode,
    baseUrl: mode === 'external' ? baseUrl : null,
    browserAvailable: mode === 'external' && Boolean(baseUrl),
    applicationReady: mode === 'external' && Boolean(baseUrl),
    applicationService: null,
    commandService: null,
  };
}

async function waitForHealth(
  url: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = '';
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const timeoutSignal = AbortSignal.timeout(3000);
      const response = await fetch(url, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      signal?.throwIfAborted();
      last = error instanceof Error ? error.name : 'network';
    }
    await delay(1000, undefined, signal ? { signal } : undefined);
  }
  throw new ControlledCommandError('COMMAND_FAILED', `应用健康检查超时：${last}`);
}
async function success(
  docker: DockerRuntime,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const result = await docker.run(args, { timeoutMs, signal });
  signal?.throwIfAborted();
  if (result.exitCode !== 0)
    throw new ControlledCommandError('COMMAND_FAILED', `Docker ${args[0]} 操作失败`);
  return result;
}
async function removeConfirmed(docker: DockerRuntime, id: string): Promise<void> {
  const removed = await docker.run(['rm', '--force', id], { timeoutMs: 30_000 });
  if (removed.exitCode === 0) return;
  const remaining = await docker.run(['ps', '--all', '--quiet', '--filter', `id=${id}`], {
    timeoutMs: 10_000,
  });
  if (remaining.stdout.trim()) throw new Error('应用容器清理状态未知');
}
async function removeNetworkConfirmed(docker: DockerRuntime, name: string): Promise<void> {
  const removed = await docker.run(['network', 'rm', name], { timeoutMs: 30_000 });
  if (removed.exitCode === 0) return;
  const remaining = await docker.run(['network', 'inspect', name], { timeoutMs: 10_000 });
  if (remaining.exitCode === 0) throw new Error('应用网络清理状态未知');
}
async function composeDown(
  docker: DockerRuntime,
  project: string,
  projectDirectory: string,
  file: string,
): Promise<void> {
  const result = await docker.run(
    [
      'compose',
      '--project-name',
      project,
      '--project-directory',
      projectDirectory,
      '--file',
      file,
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) throw new Error('Compose 资源清理失败或状态未知');
}

export function localDockerHostAddress(): string {
  return '127.0.0.1';
}

export function containerControlIdentity(): string | null {
  if (!existsSync('/.dockerenv')) return null;
  const id = readFileSync('/etc/hostname', 'utf8').trim();
  if (!/^[0-9a-f]{12,64}$/.test(id))
    throw new ControlledCommandError('COMMAND_FAILED', '无法核验容器化控制端身份');
  return id;
}

async function containerNetworkAddress(
  docker: DockerRuntime,
  containerId: string,
  networkName: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await success(
    docker,
    ['inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId],
    10_000,
    signal,
  );
  const networks = JSON.parse(result.stdout) as Record<string, { IPAddress?: string }>;
  const address = networks[networkName]?.IPAddress;
  if (!address || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))
    throw new ControlledCommandError('COMMAND_FAILED', 'Compose 应用网络地址无效');
  return address;
}

async function disconnectNetwork(
  docker: DockerRuntime,
  connection: { name: string; containerId: string },
): Promise<void> {
  const result = await docker.run(
    ['network', 'disconnect', connection.name, connection.containerId],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new ControlledCommandError('COMMAND_FAILED', '容器化控制端退出 Run 网络失败');
}
