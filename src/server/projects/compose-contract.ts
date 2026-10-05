import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parse } from 'yaml';
import { ConfigurationError } from '../configuration.js';

const SERVICE_FIELDS = new Set([
  'image',
  'build',
  'command',
  'entrypoint',
  'working_dir',
  'environment',
  'depends_on',
  'healthcheck',
  'ports',
  'expose',
  'networks',
  'volumes',
]);
const ROOT_FIELDS = new Set(['name', 'services', 'networks', 'volumes']);
const UNSAFE_SERVICE_FIELDS = [
  'privileged',
  'devices',
  'container_name',
  'network_mode',
  'pid',
  'ipc',
  'uts',
  'userns_mode',
  'security_opt',
  'cap_add',
  'cap_drop',
  'secrets',
  'configs',
  'extends',
];

export type ControlledComposeDefinition = {
  projectName: string;
  definitionHash: string;
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, Record<string, unknown>>;
  volumes: Record<string, Record<string, unknown>>;
  applicationService: string;
  commandService: string;
  servicePort: number;
  volumeNames: string[];
  networkNames: string[];
};

export function normalizeComposeDefinition(input: {
  source: string;
  instanceId: string;
  projectId: string;
  attemptId: string;
  enabledServices: string[];
  applicationService: string;
  commandService: string;
  servicePort: number;
  publishHost?: string;
  composeFile?: string;
}): ControlledComposeDefinition {
  if (Buffer.byteLength(input.source, 'utf8') > 1024 * 1024 || /\$\{/.test(input.source))
    throw new ConfigurationError('Compose 文件过大或包含未受控变量插值');
  let document: unknown;
  try {
    document = parse(input.source, { maxAliasCount: 0 });
  } catch {
    throw new ConfigurationError('Compose 文件无法解析');
  }
  if (!record(document)) throw new ConfigurationError('Compose 根配置无效');
  rejectUnknown(document, ROOT_FIELDS, 'Compose 根配置');
  if ('include' in document || 'extends' in document)
    throw new ConfigurationError('Compose include/extends 不受支持');
  if (!record(document.services)) throw new ConfigurationError('Compose services 缺失');
  const composeDirectory = composeBaseDirectory(input.composeFile ?? 'compose.yml');
  const enabled = new Set(input.enabledServices);
  if (!enabled.has(input.applicationService) || !enabled.has(input.commandService))
    throw new ConfigurationError('应用和测试服务必须包含在启用服务中');
  const prefix = `lw-${input.projectId.slice(0, 8)}-${input.attemptId}`.toLowerCase();
  const services: Record<string, Record<string, unknown>> = {};
  const buildInputs: Record<string, Record<string, unknown>> = {};
  for (const name of enabled) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name))
      throw new ConfigurationError('Compose 服务名无效');
    const source = document.services[name];
    if (!record(source)) throw new ConfigurationError(`Compose 服务不存在：${name}`);
    for (const field of UNSAFE_SERVICE_FIELDS)
      if (field in source)
        throw new ConfigurationError(`Compose 不支持危险字段：services.${name}.${field}`);
    rejectUnknown(source, SERVICE_FIELDS, `Compose 服务 ${name}`);
    const normalized = structuredClone(source);
    if (normalized.build !== undefined)
      normalized.build = normalizeBuild(normalized.build, composeDirectory);
    if (normalized.volumes !== undefined)
      normalized.volumes = normalizeMounts(normalized.volumes, name, composeDirectory);
    if (normalized.ports !== undefined)
      normalized.ports = normalizePorts(
        normalized.ports,
        name,
        input.applicationService,
        input.servicePort,
        input.publishHost ?? '127.0.0.1',
      );
    else if (name === input.applicationService)
      normalized.ports = [`${input.publishHost ?? '127.0.0.1'}::${input.servicePort}`];
    buildInputs[name] = {
      build: normalized.build ?? null,
      image: normalized.image ?? null,
    };
    normalized.labels = {
      'luowang.instance-id': input.instanceId,
      'luowang.project-id': input.projectId,
      'luowang.attempt-id': input.attemptId,
    };
    services[name] = normalized;
  }
  const networks = normalizeTopResources(document.networks, `${prefix}-net`, 'network');
  const volumes = normalizeTopResources(document.volumes, `${prefix}-vol`, 'volume');
  if (!networks.default) networks.default = { external: false, name: `${prefix}-net-default` };
  for (const resource of [...Object.values(networks), ...Object.values(volumes)])
    resource.labels = {
      ...(record(resource.labels) ? resource.labels : {}),
      'luowang.instance-id': input.instanceId,
      'luowang.project-id': input.projectId,
      'luowang.attempt-id': input.attemptId,
    };
  for (const [name, service] of Object.entries(services)) {
    const selectedNetworks = normalizeServiceNetworks(service.networks, name);
    for (const network of selectedNetworks) {
      if (!networks[network])
        throw new ConfigurationError(`Compose 服务 ${name} 引用未登记网络：${network}`);
    }
    service.networks = selectedNetworks;
    for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
      const source = typeof mount === 'string' ? mount.split(':', 1)[0] : '';
      if (source && !source.startsWith('.') && !source.includes('/') && !volumes[source]) {
        throw new ConfigurationError(`Compose 服务 ${name} 引用未登记卷：${source}`);
      }
    }
  }
  const canonical = JSON.stringify(buildInputs);
  return {
    projectName: prefix,
    definitionHash: createHash('sha256').update(canonical).digest('hex'),
    services,
    networks,
    volumes,
    applicationService: input.applicationService,
    commandService: input.commandService,
    servicePort: input.servicePort,
    volumeNames: Object.values(volumes).map((value) => String(value.name)),
    networkNames: Object.values(networks).map((value) => String(value.name)),
  };
}

function normalizeBuild(value: unknown, composeDirectory: string): Record<string, unknown> {
  const build: Record<string, unknown> | null =
    typeof value === 'string' ? { context: value } : record(value) ? { ...value } : null;
  if (
    !build ||
    Object.keys(build).some((key) => !['context', 'dockerfile', 'target', 'args'].includes(key))
  )
    throw new ConfigurationError('Compose build 配置不受支持');
  build.context = resolveFromComposeDirectory(build.context, composeDirectory);
  if (build.dockerfile !== undefined) build.dockerfile = safeRelativePath(build.dockerfile, false);
  if (build.args !== undefined) throw new ConfigurationError('Compose build args 首版不受支持');
  return build;
}

function normalizeMounts(value: unknown, service: string, composeDirectory: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigurationError(`Compose ${service} volumes 无效`);
  return value.map((item) => {
    if (typeof item !== 'string') throw new ConfigurationError('Compose 长格式挂载首版不受支持');
    const parts = item.split(':');
    if (parts.length < 2 || parts.length > 3) throw new ConfigurationError('Compose 挂载格式无效');
    const source = parts[0];
    const target = parts[1];
    const relativeSource = source.startsWith('.') || source.includes('/') || source.includes('\\');
    const mode = parts[2] ?? (relativeSource ? 'ro' : 'rw');
    if (!target.startsWith('/') || target.includes('..'))
      throw new ConfigurationError('Compose 容器挂载路径无效');
    if (relativeSource) {
      if (parts[2] !== undefined && parts[2] !== 'ro')
        throw new ConfigurationError('Compose 源码挂载必须只读');
      const resolved = resolveFromComposeDirectory(source, composeDirectory);
      const hostPath = resolved === '.' ? '.' : `./${resolved}`;
      return `${hostPath}:${target}:ro`;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(source) || !['ro', 'rw'].includes(mode))
      throw new ConfigurationError('Compose 卷挂载无效');
    return `${source}:${target}:${mode}`;
  });
}

function composeBaseDirectory(composeFile: string): string {
  const normalized = safeRelativePath(composeFile, false);
  return posix.dirname(normalized);
}

function resolveFromComposeDirectory(value: unknown, composeDirectory: string): string {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  )
    throw new ConfigurationError('Compose 路径必须位于项目内');
  const normalized = posix.normalize(posix.join(composeDirectory, value));
  if (normalized === '..' || normalized.startsWith('../'))
    throw new ConfigurationError('Compose 路径越界');
  return normalized;
}

function normalizePorts(
  value: unknown,
  service: string,
  applicationService: string,
  servicePort: number,
  publishHost: string,
): string[] {
  if (service !== applicationService) throw new ConfigurationError('只有应用服务可以声明端口');
  if (!Array.isArray(value) || value.length !== 1)
    throw new ConfigurationError('应用服务必须只声明一个受控端口');
  const raw = String(value[0]);
  const container = Number(raw.split(':').at(-1)?.split('/')[0]);
  if (container !== servicePort || /^\d+:/.test(raw))
    throw new ConfigurationError('Compose 禁止固定宿主端口');
  return [`${publishHost}::${servicePort}`];
}

function normalizeTopResources(
  value: unknown,
  prefix: string,
  kind: 'network' | 'volume',
): Record<string, Record<string, unknown>> {
  if (value === undefined) return {};
  if (!record(value)) throw new ConfigurationError('Compose 网络或卷配置无效');
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, definition] of Object.entries(value)) {
    if (!record(definition) || definition.external === true)
      throw new ConfigurationError('Compose external 网络或卷不受支持');
    if (Object.keys(definition).some((key) => !['driver', 'labels'].includes(key)))
      throw new ConfigurationError('Compose 网络或卷字段不受支持');
    if (
      definition.driver !== undefined &&
      definition.driver !== (kind === 'network' ? 'bridge' : 'local')
    )
      throw new ConfigurationError('Compose 网络或卷驱动不受支持');
    result[name] = { ...definition, external: false, name: `${prefix}-${name}` };
  }
  return result;
}

function normalizeServiceNetworks(value: unknown, service: string): string[] {
  if (value === undefined) return ['default'];
  const names = Array.isArray(value) ? value : record(value) ? Object.keys(value) : null;
  if (
    !names ||
    names.length === 0 ||
    names.some(
      (name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name),
    )
  ) {
    throw new ConfigurationError(`Compose 服务 ${service} 网络配置无效`);
  }
  return names as string[];
}

function safeRelativePath(value: unknown, allowDot: boolean): string {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value)
  )
    throw new ConfigurationError('Compose 路径必须位于项目内');
  const normalized = posix.normalize(value);
  if ((!allowDot && normalized === '.') || normalized === '..' || normalized.startsWith('../'))
    throw new ConfigurationError('Compose 路径越界');
  return normalized;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const key = Object.keys(value).find((item) => !allowed.has(item));
  if (key) throw new ConfigurationError(`${label}包含不支持的字段：${key}`);
}
