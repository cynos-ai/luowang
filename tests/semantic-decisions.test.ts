import { strict as assert } from 'node:assert';
import { it } from 'vitest';
import { createPlanWriterTool } from '../src/server/runs/agent-session.js';
import { parseExecutionScenarioPlan } from '../src/server/runs/execution-plan.js';

it('uses the explicit planning decision rather than keywords, negations or quoted text', async () => {
  const writes: unknown[] = [];
  const tool = createPlanWriterTool('计划', 'fixture', async (content, requiresBrowser) => {
    writes.push({ content, requiresBrowser });
  });
  const examples = [
    { content: '无浏览器服务，不执行端到端 UI 测试，本次不做截图对比。', requiresBrowser: false },
    { content: '打开首页，检查按钮是否被其他元素挡住。', requiresBrowser: true },
    {
      content: '「ブラウザ」は対象外です。\n```\nUI screenshot canvas\n```',
      requiresBrowser: false,
    },
  ];
  for (const example of examples) {
    const result = await tool.execute('fixture', example, undefined, undefined, {} as never);
    assert.ok(!(result.details as { error?: boolean }).error);
  }
  assert.deepEqual(writes, examples);
});

it('rejects missing or non-boolean planning decisions without invoking the writer', async () => {
  let writes = 0;
  const tool = createPlanWriterTool('计划', 'fixture', async () => {
    writes++;
  });
  for (const requiresBrowser of [undefined, null, 'false', 0]) {
    const result = await tool.execute(
      'fixture',
      { content: '计划', requiresBrowser },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((result.details as { error?: boolean }).error, true);
  }
  assert.equal(writes, 0);
});

it('keeps selection/rationale structure but does not certify its meaning using magic words', () => {
  for (const reason of [
    '本批只调整说明书，产品行为没有变化。',
    'Cette modification ne concerne que la documentation.',
    '不能以“无需场景测试”为理由跳过登录验证。',
  ]) {
    const plan = parseExecutionScenarioPlan(`## execution_scenarios\n\n${reason}\n`);
    assert.deepEqual(plan.scenarioIds, []);
    assert.equal(plan.reason, reason); // A contradiction is for Reviewer to reject, not a parser to understand.
  }
  assert.throws(() => parseExecutionScenarioPlan('## execution_scenarios\n\n'), /非空理由/);
  assert.deepEqual(
    parseExecutionScenarioPlan(
      '## execution_scenarios\n- AUTH-LOGIN-001\n不能以“无需场景测试”跳过此项。',
    ).scenarioIds,
    ['AUTH-LOGIN-001'],
  );
  assert.throws(
    () => parseExecutionScenarioPlan('## execution_scenarios\n- invalid'),
    /无效场景 ID/,
  );
});
