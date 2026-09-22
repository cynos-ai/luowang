import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Both revisions run their own production resource loader, Pi factory and tools.
// Repository primitives are fixed Git reads; no external target or executable fixture is installed.
export async function runCase(root, input, repository, out, options = {}) {
  mkdirSync(out, { recursive: false });
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { createPiAgentSessionFactory, createTargetContextTools, createPlanWriterTool } =
    await load('src/server/runs/agent-session.ts');
  const { createRoleInstructionLoader } = await load('src/server/runs/role-instructions.ts');
  const { loadConfig } = await load('src/server/config.ts');
  const { initializeDatabase } = await load('src/server/db/migrate.ts');
  const { createConfigurationStore } = await load('src/server/configuration.ts');
  const { createSecretStore } = await load('src/server/security/secret-store.ts');
  const { createProviderAdapter } = await load('src/server/runs/provider.ts');
  const runId = randomUUID();
  const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
  const trace = [];
  const result = {
    case: input.id,
    runId,
    humanScoring: 'not_run',
    mode: options.live ? 'live' : 'preflight',
    status: 'started',
  };
  save('result.json', result);
  const config = loadConfig({
    LUOWANG_DATA_DIR: join(out, 'state'),
    LUOWANG_MASTER_KEY: randomUUID(),
  });
  const db = initializeDatabase(config);
  let session;
  try {
    const configuration = createConfigurationStore(db.sqlite, config);
    const secrets = createSecretStore(db.sqlite, config.masterKey);
    if (options.live) secrets.set('providerApiKey', options.apiKey);
    configuration.updateHarness({
      language: 'zh-CN',
      provider: 'deepseek',
      providerBaseUrl: options.baseUrl ?? 'http://127.0.0.1:1/v1',
      agents: {
        main: { model: 'deepseek-v4-flash', thinking: 'low' },
        runner: { model: 'deepseek-v4-flash', thinking: 'off' },
        reviewer: { model: 'deepseek-v4-flash-vision-exp', thinking: 'low' },
      },
      mcp: { enabled: false, browser: 'chromium', headless: true, timeoutMs: 15000 },
    });
    const git = (...args) =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trimEnd();
    const targetCommit = git('rev-parse', 'HEAD');
    const baseCommit = input.initialization ? null : git('rev-parse', 'HEAD^');
    const files = git('ls-tree', '-r', '--name-only', targetCommit).split('\n');
    const read = (version, path) => {
      if (!Object.hasOwn(version === 'base' ? (input.base ?? {}) : input.target, path))
        throw new Error('Fixed fixture path unavailable');
      return git('show', `${version === 'base' ? baseCommit : targetCommit}:${path}`);
    };
    const readResult = async (version, path) => {
      if (version === 'base' && !baseCommit) return { status: 'no_baseline' };
      try {
        const content = read(version, path);
        return { status: content ? 'ok' : 'empty', content };
      } catch {
        return { status: 'unavailable' };
      }
    };
    const changes = Object.keys({ ...input.base, ...input.target })
      .filter((path) => input.base?.[path] !== input.target[path])
      .map((path) => ({
        oldPath: Object.hasOwn(input.base ?? {}, path) ? path : null,
        newPath: Object.hasOwn(input.target, path) ? path : null,
        kind: !Object.hasOwn(input.base ?? {}, path)
          ? 'added'
          : !Object.hasOwn(input.target, path)
            ? 'deleted'
            : 'modified',
        oldMode: '100644',
        newMode: '100644',
        oldType: 'blob',
        newType: 'blob',
        readable: true,
      }));
    let sourceStore;
    if (options.candidate) {
      const { SourceReadStore } = await load('src/server/runs/source-reads.ts');
      sourceStore = new SourceReadStore(runId, input.id, async (content) =>
        writeFileSync(join(out, 'source-reads.json'), content),
      );
    }
    const sourceOptions = {
      baseCommit,
      targetCommit,
      sourceReads: sourceStore?.session(
        input.initialization ? 'initialization-static' : 'main-planning',
      ),
    };
    const context = {
      runId,
      baseCommit,
      targetCommit,
      request: input.request,
      initialization: input.initialization,
    };
    const tools = createTargetContextTools({
      ...sourceOptions,
      readFile: options.candidate
        ? (path) => readResult('target', path)
        : async (path) => read('target', path),
      listFiles: async () => files,
      search: async (query) => {
        const paths = files.filter((path) => read('target', path).includes(query));
        return options.candidate
          ? { paths, limits: [], scannedFiles: files.length }
          : paths.join('\n');
      },
      context: () => JSON.stringify(context),
      changeEvidence: {
        ...sourceOptions,
        listChanges: async () => changes,
        readFile: readResult,
        readDiff: async (path) =>
          !baseCommit
            ? { status: 'no_baseline' }
            : !changes.some((c) => c.oldPath === path || c.newPath === path)
              ? { status: 'empty', content: '' }
              : {
                  status: 'ok',
                  content: git('diff', '--no-ext-diff', baseCommit, targetCommit, '--', path),
                },
      },
    });
    if (sourceStore) tools.push(sourceStore.queryTool((value) => value));
    tools.push(
      createPlanWriterTool(
        '提交分析计划',
        '保存完整计划，评测不应用场景 patch。',
        async (content, requiresBrowser, references) => {
          const write = async (value) => writeFileSync(join(out, 'plan.md'), value);
          if (sourceStore)
            await sourceStore.writePlan(
              content,
              requiresBrowser,
              references,
              [input.initialization ? 'initialization-static' : 'main-planning'],
              write,
            );
          else await write(content);
        },
      ),
    );
    // Equal evaluation-only delivery aid: calls each revision's real source tools,
    // then returns every result to the model. It adds no rubric or expected decision.
    tools.push({
      name: 'read_evaluation_fixture',
      label: '读取完整固定评测材料',
      description:
        '一次取得此合成样本全部固定 target 正文、变化 diff 和有变化的 base 正文。经生产读取工具交付；返回的回执可引用。只用于评测，不属于产品工具。',
      parameters: tools[0].parameters,
      execute: async (id) => {
        const results = [];
        const invoke = async (name, args) => {
          const output = await wrapped
            .find((tool) => tool.name === name)
            .execute(`${id}/${results.length}`, args);
          results.push({ name, input: args, output });
        };
        for (const path of files) await invoke('read_target_file', { path });
        if (baseCommit)
          for (const change of changes) {
            await invoke('read_target_diff', { path: change.newPath ?? change.oldPath });
            if (change.oldPath)
              await invoke('read_target_file_version', { version: 'base', path: change.oldPath });
          }
        return { content: [{ type: 'text', text: JSON.stringify(results) }], details: {} };
      },
    });
    const wrapped = tools.map((tool) => ({
      ...tool,
      execute: async (...args) => {
        const entry = { tool: tool.name, input: args[1] };
        trace.push(entry);
        try {
          entry.output = await tool.execute(...args);
          return entry.output;
        } finally {
          save('trace.json', trace);
        }
      },
    }));
    const instructions = await createRoleInstructionLoader({
      resourceDirectory: join(root, 'resources/agent-roles'),
    }).load('main-planning', input.initialization);
    save('resources.json', instructions.versions);
    // Paths and immutable revisions are supplied equally; no expected decisions or rubric is supplied.
    const prompt = `这是隔离的 Main 规划评测，不执行测试、不写 patch、不发布报告。请先调用 read_evaluation_fixture 一次取得全部冻结材料，再用 write_plan 交付理解、依据、维护决定、关键验证和缺口；没有实际执行，不得声明产品通过。用中文，正文尽量不超过 1800 字。\n本案例最多 4 次模型响应；完整材料已由 read_evaluation_fixture 覆盖，不必重复目录与正文读取，给提交计划和结束留出响应。\n${JSON.stringify(context)}\n完整目标路径清单：${JSON.stringify(files)}\n固定变化路径：${JSON.stringify(baseCommit ? changes.map((c) => ({ oldPath: c.oldPath, newPath: c.newPath, kind: c.kind })) : { status: 'no_baseline' })}\n只需在计划描述场景维护决定，不要求生成 patch；这是局部规划评测而不是完整 Run。`;
    writeFileSync(join(out, 'prompt.txt'), prompt);
    if (options.live) {
      session = await createPiAgentSessionFactory({
        provider: createProviderAdapter(configuration, secrets),
      }).create({
        role: 'main-a',
        sessionKind: 'main-planning',
        config: { model: 'deepseek-v4-flash', thinking: 'low' },
        cwd: out,
        toolNames: wrapped.map((tool) => tool.name),
        customTools: wrapped,
        systemPrompt: instructions.content,
        userMessage: prompt,
        roleInstructionVersions: instructions.versions,
      });
      await session.prompt(prompt);
    } else {
      const references = [];
      for (const path of files) {
        const tool = wrapped.find((t) => t.name === 'read_target_file');
        const value = await tool.execute(randomUUID(), { path });
        if (value.details?.error) throw new Error('Read preflight failed');
        if (options.candidate)
          references.push({
            receiptId: JSON.parse(value.content[0].text).receipt.id,
            coverage: 'full-file',
          });
      }
      const value = await wrapped
        .find((t) => t.name === 'write_plan')
        .execute(randomUUID(), {
          content: '# Scripted preflight\nNo semantic judgment.',
          requiresBrowser: false,
          sourceReferences: references,
        });
      if (value.details?.error) throw new Error('Writer preflight failed');
    }
    if (!readFileSync(join(out, 'plan.md'), 'utf8').trim()) throw new Error('Missing plan');
    result.status = options.live ? 'awaiting_ai_audit' : 'preflight_passed';
  } catch {
    result.status = 'incomplete';
  } finally {
    await session?.dispose();
    save('result.json', result);
    save('trace.json', trace);
    db.close();
  }
  return result;
}
