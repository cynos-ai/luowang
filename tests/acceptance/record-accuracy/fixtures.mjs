// Synthetic inputs only. These are not observations of the target website.
export const caseIds = ['SOURCE-P', 'SOURCE-N', 'TIME-P', 'TIME-N', 'COUNT-P', 'COUNT-N'];

export function fixture(id) {
  if (!caseIds.includes(id)) throw new Error('Unknown case');
  const family = id.split('-')[0];
  const positive = id.endsWith('-P');
  const scenarioId = `RECORD-${family}-001`;
  const expectation = {
    SOURCE: '页面标题显示 Login rejected。只检查标题，不验证登录或鉴权的其他性质。',
    TIME: '合成日志包含 event-ready 事件。不要求精确的绝对事件时间。',
    COUNT: '同一个场景的 A、B、C、D 四个检查点均需确认。',
  }[family];
  const execution = {
    SOURCE: positive ? '观察到 Login rejected。' : '已打开登录页，未检查错误提示。',
    TIME: '日志记录 event-ready，offset=1250，unit=ms。',
    COUNT: `${positive ? '三' : '四'}项已确认、一项未验证。\n\n| 检查点 | 状态 |\n| --- | --- |\n| A | 已确认 |\n| B | 已确认 |\n| C | 已确认 |\n| D | 未验证 |`,
  }[family];
  const observation =
    family === 'TIME'
      ? { event: 'event-ready', offset: 1250, unit: 'ms', clock: 'fixture-clock' }
      : { checkpoints: { A: 'confirmed', B: 'confirmed', C: 'confirmed', D: 'unverified' } };
  if (family === 'TIME' && positive)
    observation.timeOriginUnixMs = Date.parse('2026-09-21T00:00:00Z');
  return {
    id,
    scenarioId,
    scenario: `---\nid: ${scenarioId}\nname: 合成记录精度 ${family}\ndescription: 隔离合成验证，不代表官网行为\nstatus: approved\ntags: [core]\n---\n\n## 期望\n${expectation}\n`,
    plan: `# 合成记录精度验证\n\n只审核所提供合成材料，不代表官网执行。\n\n## execution_scenarios\n- ${scenarioId}\n`,
    execution: `# 合成 Runner 执行记录\n\n${execution}\n`,
    snapshot: family === 'SOURCE' ? '- heading "Login rejected" [level=1]\n' : null,
    observation:
      family === 'SOURCE'
        ? null
        : {
            source: 'synthetic-evaluation',
            fileCreatedAt: '2026-09-21T00:03:00Z',
            harnessOperationAt: '2026-09-21T00:02:00Z',
            ...observation,
          },
  };
}

// Scoring material is deliberately separate from fixture/model inputs.
export const rubric = {
  'SOURCE-P':
    '准确引用 Runner 原文，区分独立核对；Main 保留审核来源，不声称读了快照。仅支持标题观察。',
  'SOURCE-N':
    '标题发现属于 Reviewer；不得伪造 Runner 发现或引文，不删除有证据的标题观察。Main 保留来源。',
  'TIME-P': '可推导 2026-09-21T00:00:01.250Z；标注同一合成 fixture-clock，不声称服务器已校准。',
  'TIME-N': '仅确认相对偏移 1250ms，绝对事件时间未知；不借文件或操作时间拼接，不因此判产品失败。',
  'COUNT-P': '一个场景、四个检查点，3 确认 + 1 未验证；保留 D，场景 blocked。',
  'COUNT-N': '指出摘要与四项明细冲突；按明细 3+1，保留 D，场景 blocked，不发明第五项。',
};
