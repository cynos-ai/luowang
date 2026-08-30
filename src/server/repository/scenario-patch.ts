import { parseScenarioMarkdown, type ParsedScenario } from './markdown.js';
import { RepositoryError } from './errors.js';

export const SCENARIO_DIRECTORY = 'docs/scenario-testing/scenarios/';
export const SCENARIO_PATCH_MAX_BYTES = 4 * 1024 * 1024;

export type ScenarioPatchChangeKind = 'add' | 'modify' | 'rename';

export interface ScenarioPatchChange {
  oldPath: string | null;
  newPath: string;
  kind: ScenarioPatchChangeKind;
  oldMode: string | null;
  newMode: string | null;
}

export interface ScenarioPatchValidation {
  changes: ScenarioPatchChange[];
  changedPaths: string[];
  addedPaths: string[];
  modifiedPaths: string[];
  renamedPaths: Array<{ oldPath: string; newPath: string }>;
  onlyAdds: boolean;
}

export class ScenarioPatchError extends RepositoryError {
  constructor(message: string) {
    super('SCENARIO_PATCH_INVALID', message, 422);
    this.name = 'ScenarioPatchError';
  }
}

/**
 * Parse only the file-level part of a git unified patch. The actual hunk
 * application is deliberately delegated to git, but all paths and modes are
 * checked here before git receives the patch.
 */
export function validateScenarioPatchText(content: string): ScenarioPatchValidation {
  if (
    typeof content !== 'string' ||
    content.trim() === '' ||
    content.includes('\u0000') ||
    Buffer.byteLength(content, 'utf8') > SCENARIO_PATCH_MAX_BYTES
  ) {
    throw new ScenarioPatchError('scenario-changes.patch 必须是非空的 UTF-8 文本');
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: PatchBlock[] = [];
  let current: PatchBlock | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current);
      current = { header: line, oldMarker: null, newMarker: null, oldMode: null, newMode: null };
      continue;
    }
    if (!current) {
      if (line.trim() !== '' && !line.startsWith('--- ')) {
        throw new ScenarioPatchError('patch 必须使用标准 git unified diff 格式');
      }
      continue;
    }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      current.binary = true;
    }
    if (line.startsWith('new file mode '))
      current.newMode = line.slice('new file mode '.length).trim();
    if (line.startsWith('deleted file mode ')) current.deleted = true;
    if (line.startsWith('old mode ')) current.oldMode = line.slice('old mode '.length).trim();
    if (line.startsWith('new mode ')) current.newMode = line.slice('new mode '.length).trim();
    if (line.startsWith('rename from ')) current.renameFrom = line.slice('rename from '.length);
    if (line.startsWith('rename to ')) current.renameTo = line.slice('rename to '.length);
    if (line.startsWith('--- ')) current.oldMarker = line.slice(4).split('\t', 1)[0] ?? null;
    if (line.startsWith('+++ ')) current.newMarker = line.slice(4).split('\t', 1)[0] ?? null;
  }
  if (current) blocks.push(current);
  if (blocks.length === 0) {
    throw new ScenarioPatchError('patch 不包含任何 git diff 文件变更');
  }

  const changes = blocks.map(toChange);
  const seen = new Set<string>();
  for (const change of changes) {
    const paths =
      change.oldPath === change.newPath
        ? [change.newPath]
        : [change.oldPath, change.newPath].filter((path): path is string => path !== null);
    for (const path of paths) {
      if (!path) continue;
      if (seen.has(path)) throw new ScenarioPatchError(`patch 重复修改场景文件：${path}`);
      seen.add(path);
    }
  }

  const addedPaths = changes
    .filter((change) => change.kind === 'add')
    .map((change) => change.newPath);
  const modifiedPaths = changes
    .filter((change) => change.kind === 'modify')
    .map((change) => change.newPath);
  const renamedPaths = changes
    .filter(
      (change): change is ScenarioPatchChange & { oldPath: string } => change.kind === 'rename',
    )
    .map((change) => ({ oldPath: change.oldPath, newPath: change.newPath }));
  return {
    changes,
    changedPaths: [...seen],
    addedPaths,
    modifiedPaths,
    renamedPaths,
    onlyAdds: changes.every((change) => change.kind === 'add'),
  };
}

/** Validate every resulting Markdown scenario and enforce stable IDs. */
export function validateScenarioContents(
  files: ReadonlyMap<string, string>,
  baseFiles: ReadonlyMap<string, string> = new Map(),
  changes: readonly ScenarioPatchChange[] = [],
): Map<string, ParsedScenario> {
  const parsed = new Map<string, ParsedScenario>();
  const ids = new Map<string, string>();
  for (const [path, content] of files) {
    assertScenarioPath(path);
    let scenario: ParsedScenario;
    try {
      scenario = parseScenarioMarkdown(content, path);
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw new ScenarioPatchError(error.message);
      }
      throw error;
    }
    const duplicate = ids.get(scenario.id);
    if (duplicate) {
      throw new ScenarioPatchError(`场景 id 重复：${scenario.id}（${duplicate} 与 ${path}）`);
    }
    ids.set(scenario.id, path);
    parsed.set(path, scenario);
  }

  for (const change of changes) {
    if (change.kind === 'add') continue;
    const oldPath = change.oldPath;
    if (!oldPath) throw new ScenarioPatchError(`场景变更缺少旧路径：${change.newPath}`);
    const previousContent = baseFiles.get(oldPath);
    const next = parsed.get(change.newPath);
    if (!previousContent || !next) {
      throw new ScenarioPatchError(`无法确认场景稳定 ID：${oldPath} → ${change.newPath}`);
    }
    let previous: ParsedScenario;
    try {
      previous = parseScenarioMarkdown(previousContent, oldPath);
    } catch (error) {
      if (error instanceof RepositoryError) throw new ScenarioPatchError(error.message);
      throw error;
    }
    if (previous.id !== next.id) {
      throw new ScenarioPatchError(
        `场景稳定 ID 不能改变：${oldPath} 的 ${previous.id} → ${change.newPath} 的 ${next.id}`,
      );
    }
  }
  return parsed;
}

export function assertScenarioPath(path: string): void {
  if (
    typeof path !== 'string' ||
    !path.startsWith(SCENARIO_DIRECTORY) ||
    path.endsWith('/') ||
    !path.endsWith('.md') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ScenarioPatchError(`场景路径越界或不是 Markdown 文件：${path}`);
  }
}

interface PatchBlock {
  header: string;
  oldMarker: string | null;
  newMarker: string | null;
  oldMode: string | null;
  newMode: string | null;
  renameFrom?: string;
  renameTo?: string;
  deleted?: boolean;
  binary?: boolean;
}

function toChange(block: PatchBlock): ScenarioPatchChange {
  if (block.binary) throw new ScenarioPatchError('patch 不允许包含二进制文件');

  const header = parseDiffHeader(block.header);
  const markerOldPath = block.oldMarker === null ? undefined : markerPath(block.oldMarker, 'old');
  const markerNewPath = block.newMarker === null ? undefined : markerPath(block.newMarker, 'new');
  const oldPath = resolvePatchPath(block.renameFrom ?? markerOldPath);
  const newPath = resolvePatchPath(block.renameTo ?? markerNewPath);
  if (!newPath) throw new ScenarioPatchError(`patch 缺少新文件路径：${block.header}`);
  if (!oldPath && block.deleted) {
    throw new ScenarioPatchError('patch 的删除变更无效');
  }
  if (!oldPath && block.oldMarker !== '/dev/null') {
    // A new-file patch normally has --- /dev/null. Requiring that marker
    // prevents a malformed patch from being interpreted as an addition.
    throw new ScenarioPatchError(`新增场景缺少 /dev/null 旧路径：${block.header}`);
  }
  if (block.newMarker === '/dev/null' || block.deleted) {
    throw new ScenarioPatchError(`不允许物理删除场景：${oldPath ?? newPath}`);
  }
  if (oldPath && !newPath) throw new ScenarioPatchError(`patch 缺少新文件路径：${block.header}`);

  assertScenarioPath(newPath);
  if (oldPath) assertScenarioPath(oldPath);
  assertRegularMode(block.oldMode, oldPath ?? newPath);
  assertRegularMode(block.newMode, newPath);

  const expectedHeaderOld = oldPath ?? newPath;
  if (header.oldPath !== expectedHeaderOld || header.newPath !== newPath) {
    throw new ScenarioPatchError(`patch 文件头与变更路径不一致：${block.header}`);
  }
  if (
    block.renameFrom !== undefined &&
    (markerOldPath !== undefined || markerNewPath !== undefined) &&
    (markerOldPath !== oldPath || markerNewPath !== newPath)
  ) {
    throw new ScenarioPatchError(`patch rename 标记与内容路径不一致：${block.header}`);
  }

  const kind: ScenarioPatchChangeKind = !oldPath
    ? 'add'
    : oldPath === newPath
      ? 'modify'
      : 'rename';
  if (kind === 'rename' && block.renameFrom && block.renameTo && oldPath === newPath) {
    throw new ScenarioPatchError(`场景 rename 的源和目标不能相同：${oldPath}`);
  }
  return {
    oldPath,
    newPath,
    kind,
    oldMode: block.oldMode,
    newMode: block.newMode,
  };
}

function parseDiffHeader(header: string): { oldPath: string; newPath: string } {
  // Git's default diff output keeps the two a/ and b/ paths unquoted for the
  // repository paths supported by the scenario writer. Rejecting quoted or
  // malformed headers is safer than guessing where a path ends.
  const match = /^diff --git (a\/[^\s]+) (b\/[^\s]+)$/.exec(header);
  if (!match) throw new ScenarioPatchError(`patch 文件头格式无效：${header}`);
  const oldPath = resolvePatchPath(match[1]);
  const newPath = resolvePatchPath(match[2]);
  if (!oldPath || !newPath) throw new ScenarioPatchError(`patch 文件头路径无效：${header}`);
  return { oldPath, newPath };
}

function markerPath(marker: string | null, side: 'old' | 'new'): string | null {
  if (!marker) throw new ScenarioPatchError(`patch 缺少 ${side} 文件路径`);
  if (marker === '/dev/null') return null;
  const prefix = side === 'old' ? 'a/' : 'b/';
  if (!marker.startsWith(prefix)) {
    throw new ScenarioPatchError(`patch ${side} 文件路径格式无效：${marker}`);
  }
  return marker.slice(prefix.length);
}

function resolvePatchPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '/dev/null') return null;
  if (value.startsWith('a/')) return value.slice(2);
  if (value.startsWith('b/')) return value.slice(2);
  return value;
}

function assertRegularMode(mode: string | null, path: string): void {
  if (mode === null) return;
  if (mode !== '100644' && mode !== '100755') {
    throw new ScenarioPatchError(`场景文件必须是普通文件，拒绝模式 ${mode}：${path}`);
  }
}
