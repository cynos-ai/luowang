// Synthetic, non-production sources. Rubrics never enter a model Session.
const scenePath = 'docs/scenario-testing/scenarios/ORDER-001.md';
const scene = (expectation) => `---
id: ORDER-001
name: 提交订单
description: 验证订单提交的业务结果
status: approved
tags: [core]
---
## 前置条件
隔离测试库、两个合成租户、可用库存和测试用户。
## 步骤
用户提交订单，再从持久库读取订单与库存；另一个租户尝试读取。
## 期望
${expectation}
## 需要记录
响应、持久状态和拒绝后未变状态。数据用 Run 标记并清理。
`;
const contract = '订单只允许本租户访问；库存不足拒绝且不写订单；成功提交必须原子扣库存并保存订单。';
const shared = {
  'package.json': JSON.stringify({
    type: 'module',
    scripts: { test: 'node --test test/order.test.mjs' },
  }),
  'src/api.mjs': `import { submit, get } from './orders.mjs';
export const postOrder = (session, body) => submit(session, body);
export const getOrder = (session, id) => get(session, id);`,
  'src/orders.mjs': `import { db } from './store.mjs';
export async function submit(session, body) {
 return db.transaction(async tx => {
  if (!(await tx.reserve(body.sku, body.count))) throw new Error('stock');
  return tx.insert({ ...body, tenant: session.tenant });
 });
}
export async function get(session, id) {
 const order = await db.find(id);
 if (order.tenant !== session.tenant) throw new Error('forbidden');
 return order;
}`,
  'src/store.mjs': `// Adapter requires isolated TEST_DATABASE_URL; transaction rolls back on failure.
export const db = globalThis.testDatabaseAdapter;`,
  'test/order.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('route exists', () => assert.ok(true)); // No database assertions yet.
`,
  'docs/changes/orders/spec.md': contract,
  [scenePath]: scene(contract),
};
const build = (id, request, baseEdits, targetEdits, rubric, initialization = false) => {
  const base = { ...shared, ...baseEdits };
  const target = { ...base, ...targetEdits };
  for (const [path, value] of Object.entries(target)) if (value === null) delete target[path];
  return { id, request, initialization, base: initialization ? null : base, target, rubric };
};
export const fixtures = [
  build(
    'no-docs',
    '首次理解这个陌生订单服务，拟定初始化场景范围和必要侦察。',
    {},
    {
      'docs/changes/orders/spec.md': null,
      [scenePath]: null,
      'src/orders.mjs':
        shared['src/orders.mjs'] +
        `
export async function cancel(session, id) {
 return db.transaction(async tx => {
  const order = await get(session, id);
  if (order.status === 'cancelled') return order;
  await tx.restore(order.sku, order.count);
  return tx.update(id, { status: 'cancelled' });
 });
}`,
    },
    {
      critical: ['跨租户拒绝及无副作用', '提交订单与库存原子性', '取消幂等且库存只恢复一次'],
      forbidden: ['把实现行为当作已确认业务契约', '把占位单测称为真实验证'],
      allowed: '提出初始化候选及需确认期望；不要求固定场景数量。',
    },
    true,
  ),
  build(
    'refactor',
    '这次提取订单访问校验，判断测试资产如何维护。',
    {},
    {
      'src/access.mjs': `export function requireTenant(session, order) { if (order.tenant !== session.tenant) throw new Error('forbidden'); }`,
      'src/orders.mjs': shared['src/orders.mjs']
        .replace('import { db }', "import { requireTenant } from './access.mjs';\nimport { db }")
        .replace(
          "if (order.tenant !== session.tenant) throw new Error('forbidden');",
          'requireTenant(session, order);',
        ),
    },
    {
      critical: ['追踪 getOrder 到共享访问校验', '跨租户拒绝与本租户读取回归'],
      forbidden: ['仅因函数拆分新建重复场景', '根据文件类型或改动大小直接零场景'],
      allowed: '复用 ORDER-001，现有契约不变。',
    },
  ),
  build(
    'bug-fix',
    '订单失败后的残留写入已修复，判断维护和验证。',
    {
      'src/orders.mjs': shared['src/orders.mjs']
        .replace('return db.transaction(async tx => {', 'const tx = db; return (async () => {')
        .replace(' });', ' })();'),
    },
    { 'src/orders.mjs': shared['src/orders.mjs'] },
    {
      critical: [
        '保留失败不得留下订单和扣库存的原期望',
        '提交失败后独立读取持久状态',
        '成功路径回归',
      ],
      forbidden: ['放宽期望容许部分提交', '因已修复就称测试通过'],
      allowed: '复用 ORDER-001，必要时补足故障注入方法；能力不明应说明。',
    },
  ),
  build(
    'capability',
    '新增订单取消，请分析关联流程与场景覆盖。',
    {},
    {
      'docs/changes/orders/spec.md':
        contract + '\n本租户可取消待发货订单；重复取消不重复还库存；已发货拒绝且保持状态。',
      'src/api.mjs':
        shared['src/api.mjs'] +
        `\nexport const cancelOrder = (session, id) => import('./cancel.mjs').then(m => m.cancel(session, id));`,
      'src/cancel.mjs': `import { db } from './store.mjs';
import { get } from './orders.mjs';
export async function cancel(session, id) {
 return db.transaction(async tx => {
  const order = await get(session, id);
  if (order.status === 'cancelled') return order;
  if (order.status === 'shipped') throw new Error('shipped');
  await tx.restore(order.sku, order.count);
  return tx.update(id, { status: 'cancelled' });
 });
}`,
    },
    {
      critical: [
        '跨租户取消拒绝且不恢复库存',
        '重复取消只恢复一次库存',
        '已发货拒绝且状态库存不变',
        '成功取消的持久结果',
      ],
      forbidden: ['只有 HTTP 成功断言', '认为现有提交场景已覆盖取消'],
      allowed: '新增独立取消覆盖，保留已有订单场景。',
    },
  ),
  build(
    'permission-persistence',
    '读取订单新增缓存，请判断影响和测试。',
    {},
    {
      'src/cache.mjs': `const cache = new Map();
export const getCached = id => cache.get(id);
export const setCached = (id, value) => cache.set(id, value);`,
      'src/orders.mjs': shared['src/orders.mjs']
        .replace(
          'import { db }',
          "import { getCached, setCached } from './cache.mjs';\nimport { db }",
        )
        .replace(
          'const order = await db.find(id);',
          'const cached = getCached(id);\n if (cached) return cached;\n const order = await db.find(id);',
        )
        .replace('return order;', 'setCached(id, order);\n return order;'),
    },
    {
      critical: [
        '缓存命中早退绕过租户检查',
        '先本租户暖缓存再另租户读同 id',
        '冷缓存与持久库行为对照',
      ],
      forbidden: ['把缓存泄露作为合法新期望', '仅测冷缓存宣布权限正常'],
      allowed: '保留拒绝契约，指出实现缺陷风险；复用或补充缓存状态方法。',
    },
  ),
  build(
    'deprecation',
    '旧订单提交入口废弃，场景怎么处理？',
    {},
    {
      'src/api.mjs': `export const postOrder = () => ({ status: 410 });\nexport { get as getOrder } from './orders.mjs';`,
      'docs/changes/orders/spec.md':
        '旧提交入口永久返回 410，不再接受新增订单且不扣库存。历史订单本租户仍可读，跨租户拒绝。',
    },
    {
      critical: [
        'ORDER-001 的原成功承诺废弃，保留文件并 deprecated',
        '410 拒绝后订单库存不变',
        '历史订单本租户可读及跨租户拒绝',
      ],
      forbidden: ['物理删除历史场景', '把原成功场景同 ID 改成相反结果'],
      allowed: '旧资产 deprecated，替代覆盖可拆分或组合。',
    },
  ),
  build(
    'spec-conflict',
    '实现调整了跨租户读取，请核对规范和维护决定。',
    {},
    {
      'src/orders.mjs': shared['src/orders.mjs'].replace(
        "if (order.tenant !== session.tenant) throw new Error('forbidden');",
        '// Cross-tenant reads now return the order.',
      ),
    },
    {
      critical: [
        '明确固定 spec 的拒绝契约与 target 实现冲突',
        '保留跨租户拒绝期望',
        '列明风险并安排反例验证',
      ],
      forbidden: ['直接宣布规格过时', '将泄露改成 approved 正常行为', '现有明确期望因缺陷改 draft'],
      allowed: '保留已有资产语义并暴露冲突，待实测而不声称已通过。',
    },
  ),
  build(
    'missing-conditions',
    '检查订单持久化验证条件，当前环境仅有只读演示服务，无测试库、故障注入、时钟或数据库权限。',
    {},
    {
      'package.json': JSON.stringify({
        type: 'module',
        scripts: {
          test: 'node --test test/order.test.mjs',
          'test:integration': 'node test/integration.mjs',
        },
      }),
      'test/integration.mjs': `if (!process.env.TEST_DATABASE_URL) throw new Error('Missing isolated database');\n// Real adapter must be supplied by the test environment.`,
    },
    {
      critical: [
        '脚本存在不表示测试库就绪或测试通过',
        '必要的原子性和持久化检查缺条件应 blocked',
        '列明补齐隔离库和可观察故障结果条件',
      ],
      forbidden: ['编造数据库权限或成功执行结果', '用页面可见替代持久化必需断言', '要求接触生产库'],
      allowed: '可执行静态检查与阻塞验证分开；不弱化契约。',
    },
  ),
];

export const protocol = {
  schema: 2,
  cases: 8,
  pairedRepeats: 3,
  officialRuns: 48,
  models: { main: 'deepseek-v4-flash', thinking: 'low' },
  pilotCases: ['no-docs', 'permission-persistence'],
  maxRequestsPerCase: 4,
  maxPilotRequests: 8,
  maxFormalRequests: 192,
  delivery:
    'Both revisions receive the same evaluation-only batch read tool, implemented by their production fixed-source tools. Measures reasoning over delivered materials, not autonomous source navigation. Previous unbundled round is retained separately.',
  scope:
    'Isolated production Main planning Sessions and source tools; no Runner, patch application, remote writes or passing product verdict. Joint acceptance is separate.',
  failureRule:
    'Keep every attempt. No automatic case retry. Stop on upstream transport failure; budget-limited cases remain incomplete. Never replace samples or alter rubric within a round.',
  scoring: {
    method:
      'Artifact-bound qualitative AI audit by the supervising agent; each frozen critical item is met, missed or unclear, with quotations. Human scoring remains not_run.',
    metrics: [
      'criticalOmissions',
      'unsupportedOrWeakenedExpectations',
      'unnecessaryMutations',
      'provenanceErrors',
      'requests',
      'tokens',
      'elapsedMs',
    ],
    release:
      'No new critical wrong expectation/false pass; candidate critical omissions and unnecessary mutations no worse; at least one measured improvement in the frozen semantic metrics. Incomplete cases cannot count as passes.',
  },
};
