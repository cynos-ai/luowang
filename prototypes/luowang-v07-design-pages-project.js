import {
  button,
  formField,
  heading,
  notice,
  shell,
  stageTrack,
  stats,
  status,
  table,
} from './luowang-v07-design-kit.js';

function projectPage(page, title, fact, content, options = {}) {
  return shell(
    page,
    `<main class="page-main">${heading(title, fact, `项目 · 官网非生产测试`)}${content}</main>`,
    { project: true, ...options },
  );
}

export function projectOverviewPage() {
  return projectPage(
    'project-overview',
    '概览',
    '项目可运行 · 1 项测试正在执行',
    `<section class="project-hero"><div><span class="eyeline">下一步</span><h2>查看当前执行</h2><p>Runner 正在执行 AUTH-LOGIN-001 · 登录状态恢复。</p></div>${button.primary('进入当前测试', 'data-page="test-running"')}</section><div class="overview-grid"><section class="panel overview-current"><div class="panel-heading"><h2>当前测试</h2>${status('执行中', 'running')}</div><strong class="big-fact">3 / 8</strong><p>RUN-01J8Y7K2 · target 6405a45b6889</p>${stageTrack(3)}</section><section class="panel overview-ready"><div class="panel-heading"><h2>运行准备</h2>${status('已就绪', 'ok')}</div>${stats(
      [
        ['最近检查', '14:02:11'],
        ['仓库同步', '8 分钟前'],
        ['执行镜像', 'sha256:a31f…'],
        ['共享依赖', '3 / 3 通过'],
      ],
    )}<button class="text-button" data-page="readiness">查看运行准备 →</button></section><section class="panel overview-assets"><div class="panel-heading"><h2>场景</h2><small>Git 事实源</small></div><strong class="big-fact">24</strong><p>21 approved · 2 draft · 1 deprecated</p><button class="text-button" data-page="scenarios">查看场景 →</button></section><section class="panel overview-activity"><div class="panel-heading"><h2>最近活动</h2></div><ul class="list-reset activity-list"><li class="activity-row"><span class="row-meta">14:16</span><span class="row-title">完成登录刷新验证</span></li><li class="activity-row"><span class="row-meta">14:08</span><span class="row-title">测试开始 · RUN…7K2</span></li><li class="activity-row"><span class="row-meta">13:59</span><span class="row-title">索引同步到 6405a45b6889</span></li></ul></section></div>`,
  );
}

function testShell(page, fact, main, side, options = {}) {
  return projectPage(
    page,
    '测试',
    fact,
    `<div class="test-layout"><section class="panel test-main">${main}</section><aside class="test-side">${side}</aside></div>`,
    options,
  );
}

const readinessSide = `<section class="panel"><div class="panel-heading"><h3>运行准备</h3>${status('已就绪', 'ok')}</div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">仓库身份</span>${status('通过', 'ok')}</li><li class="check-row"><span class="row-title">执行镜像</span>${status('sha256:a31f…', 'ok')}</li><li class="check-row"><span class="row-title">非生产环境</span>${status('通过', 'ok')}</li><li class="check-row"><span class="row-title">清理能力</span>${status('已配置', 'ok')}</li></ul></section>`;

export function testIdlePage() {
  return testShell(
    'test-idle',
    '空闲 · 项目已就绪',
    `<div class="panel-heading"><div><span class="eyeline">新的测试请求</span><h2>发起测试</h2></div>${status('可运行', 'ok')}</div><form class="test-request-form" onsubmit="return false">${formField('测试要求', '<textarea>验证登录状态恢复与注册错误处理</textarea>', 'Main 将根据需求、diff、场景和历史自行形成计划。')}${formField('请求类型', '<select><option>测试当前场景分支</option><option>纳入来源后测试</option></select>')}<div class="request-summary">${stats(
      [
        ['项目', '官网非生产测试'],
        ['场景分支', 'scenario-testing'],
        ['环境', 'Cynos 官网非生产环境'],
        ['配置修订', 'rev 17'],
      ],
    )}</div><div class="form-actions">${button.primary('检查并确认')}</div></form>`,
    readinessSide,
  );
}

export function testQueuedPage() {
  return testShell(
    'test-queued',
    '队列第 2 位 · 等待当前项目完成',
    `<div class="panel-heading"><div><span class="eyeline">请求 #218</span><h2>测试正在等待</h2></div>${status('排队中', 'warning')}</div><div class="queue-position"><strong>02</strong><span>队列位置</span></div>${stats(
      [
        ['请求', '验证登录状态恢复'],
        ['来源', '当前 scenario-testing'],
        ['创建', '14:11:24'],
        ['前方任务', 'Closure 7 Fixture · Runner'],
        ['配置修订', 'rev 17'],
      ],
    )}${notice('stale', '等待原因', '全局一次只执行一个 Run；本版不提供取消或重排。')}`,
    `<section class="panel"><div class="panel-heading"><h3>前方任务</h3>${status('执行中', 'running')}</div><p class="row-title">Closure 7 Fixture</p><p>Runner · 5 / 9 个场景完成</p></section>${readinessSide}`,
  );
}

export function testRunningPage() {
  return testShell(
    'test-running',
    '执行中 · Runner · 最后更新刚刚',
    `<div class="panel-heading"><div><span class="eyeline">RUN-01J8Y7K2 · 执行中</span><h2>Runner 正在执行场景</h2></div>${button.secondary('测试记录', 'data-page="run"')}</div>${stageTrack(3)}<div class="live-scenario"><span class="eyeline">当前场景</span><strong>AUTH-LOGIN-001 · 登录状态恢复</strong><div class="progress-numeric"><strong>3</strong><span>/ 8 个场景完成</span></div></div><ul class="list-reset activity-list"><li class="activity-row"><span class="row-meta">14:16:58</span><span class="row-title">完成登录后刷新验证</span>${status('已记录', 'ok')}</li><li class="activity-row"><span class="row-meta">14:15:41</span><span class="row-title">打开受保护页面并核对会话</span>${status('进行中', 'running')}</li><li class="activity-row"><span class="row-meta">14:14:22</span><span class="row-title">浏览器环境已建立</span>${status('已完成', 'ok')}</li></ul>`,
    `<section class="panel"><div class="panel-heading"><h3>本次测试</h3></div>${stats([
      ['来源', 'develop'],
      ['target', '6405a45b6889'],
      ['触发', 'manual'],
      ['开始', '14:08:21'],
    ])}</section>${readinessSide}`,
  );
}

export function testCompletedPage() {
  return testShell(
    'test-completed',
    '刚刚完成 · 功能通过，清理单独告警',
    `<div class="completion-result"><span class="eyeline">正式结论</span><strong>通过</strong><p>8 个场景通过。测试数据清理有 1 项告警，不改写功能结论。</p></div><div class="scenario-count-strip"><span><strong>8</strong> 通过</span><span><strong>0</strong> 失败</span><span><strong>0</strong> 阻塞</span></div><div class="form-actions">${button.secondary('发起新的测试', 'data-page="test-idle"')}${button.primary('打开测试记录', 'data-page="run"')}</div>`,
    `<section class="panel"><div class="panel-heading"><h3>收尾</h3></div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">报告</span>${status('已发布', 'ok')}</li><li class="check-row"><span class="row-title">归档</span>${status('完成', 'ok')}</li><li class="check-row"><span class="row-title">数据清理</span>${status('1 项告警', 'warning')}</li><li class="check-row"><span class="row-title">推进</span>${status('已记录', 'ok')}</li></ul></section>`,
  );
}

export function runsPage() {
  return projectPage(
    'runs',
    '测试记录',
    '一条记录对应一次完整测试',
    `<div class="filter-bar compact">${formField('结论', '<select><option>全部结论</option><option>通过</option><option>失败</option><option>阻塞</option><option>中断</option></select>')}${formField('触发', '<select><option>全部触发方式</option><option>人工</option><option>Git</option><option>定时</option></select>')}${formField('Run ID 或 commit', '<input placeholder="RUN… / 6405a45b" />')}</div>${table(
      ['结论', '测试记录', '固定目标', '触发', '时间 / 耗时', '场景', '报告 / 告警'],
      [
        [
          status('通过', 'ok'),
          '<button class="record-link" data-page="run">RUN-01J8Y7K2</button>',
          '<code>6405a45b6889</code>',
          '人工',
          '今天 14:08 · 18:42',
          '8 / 0 / 0',
          '已发布 · 清理告警',
        ],
        [
          status('失败', 'error'),
          '<button class="record-link" data-page="run">RUN-01J8W3C1</button>',
          '<code>33d068f7a411</code>',
          'Git',
          '昨天 18:42 · 12:19',
          '6 / 2 / 0',
          '已发布 · Issue 2',
        ],
        [
          status('阻塞', 'warning'),
          '<button class="record-link" data-page="run">RUN-01J8Q4B9</button>',
          '<code>1b72be9d2e17</code>',
          '人工',
          '09-25 16:07 · 03:42',
          '2 / 0 / 1',
          '场景 PR #184',
        ],
        [
          status('中断'),
          '<button class="record-link" data-page="run">RUN-01J7ZZ19</button>',
          '<code>e93c4ba72210</code>',
          '定时',
          '09-24 09:22 · 04:11',
          '1 / 0 / 0',
          '未归档',
        ],
      ],
      'records-table',
    )}<div class="pagination"><span>1–4 / 28</span>${button.secondary('上一页', 'disabled')}${button.secondary('下一页')}</div>`,
  );
}

export function runPage() {
  return shell(
    'run',
    `<main class="page-main"><header class="run-header"><div><span class="scope-label">测试记录 · RUN-01J8XYQ4B</span><h1 class="run-result">阻塞</h1></div><div>${status('正式报告已归档', 'warning')}<p class="row-detail">2026-09-26 19:42:18 GMT+8</p></div></header><nav class="detail-tabs" aria-label="测试记录详情"><button class="active">摘要</button><button>场景结果</button><button>审核</button><button>正式报告</button><button>证据</button><button>技术信息</button></nav><div class="run-content-grid"><section class="panel"><div class="panel-heading"><h2>2 个场景通过，1 个场景阻塞</h2><span class="sample-flag">真实结构样例</span></div><ul class="list-reset scenario-list"><li class="scenario-row">${status('通过', 'ok')}<div><span class="row-title">AUTH-LOGIN-001 · 登录状态恢复</span><span class="row-detail">截图 3 · trace 1</span></div><button class="text-button" data-page="scenario">查看</button></li><li class="scenario-row">${status('通过', 'ok')}<div><span class="row-title">AUTH-REGISTER-002 · 重复邮箱提示</span><span class="row-detail">截图 2 · trace 1</span></div><button class="text-button">查看</button></li><li class="scenario-row">${status('阻塞', 'warning')}<div><span class="row-title">AUTH-CLEANUP-004 · 合成数据清理</span><span class="row-detail">清理查询不可达，未伪装为通过</span></div><button class="text-button">查看</button></li></ul><div class="live-scenario"><span class="eyeline">Reviewer</span><strong>功能证据成立；清理状态需单独处理</strong><p>AI 审核，不代表人工评分。humanScoring：not_run。</p></div><section class="artifact-preview"><div class="panel-heading"><h3>Evidence</h3><button class="text-button">查看全部</button></div><div class="evidence-grid"><figure><div class="evidence-image">登录页面截图</div><figcaption>login.png · SHA 完整 · 页面含可见表单值</figcaption></figure><figure class="evidence-failed"><div class="evidence-image">读取失败</div><figcaption>cleanup-query.txt · 完整性失败</figcaption></figure></div></section></section><aside class="test-side"><section class="panel"><div class="panel-heading"><h3>目标</h3></div>${stats(
      [
        ['base', '1b72be9d2e17'],
        ['target', '33d068f7a411'],
        ['镜像', 'sha256:a31f…'],
        ['耗时', '18:42'],
      ],
    )}</section><section class="panel"><div class="panel-heading"><h3>收尾</h3></div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">报告</span>${status('已发布', 'ok')}</li><li class="check-row"><span class="row-title">归档</span>${status('完成', 'ok')}</li><li class="check-row"><span class="row-title">数据清理</span>${status('告警', 'warning')}</li><li class="check-row"><span class="row-title">推进</span>${status('已记录', 'ok')}</li></ul></section><section class="panel"><div class="panel-heading"><h3>关联</h3></div><a class="external-link">Issue #42 · 登录会话丢失 ↗</a><a class="external-link">场景 PR #184 ↗</a></section></aside></div></main>`,
    { project: true },
  );
}

export function scenariosPage() {
  return projectPage(
    'scenarios',
    '场景',
    'Git 场景资产 · 最近同步 6405a45b6889',
    `<div class="filter-bar compact">${formField('名称或 ID', '<input placeholder="AUTH-LOGIN-001" />')}${formField('状态', '<select><option>全部状态</option><option>approved</option><option>draft</option><option>deprecated</option></select>')}${formField('标签', '<input placeholder="core / module:认证" />')}</div><div class="scenario-directory">${scenarioCard('AUTH-LOGIN-001', '登录状态恢复', 'approved', '通过 · 今天 14:26', ['core', 'module:认证', 'flow:登录'])}${scenarioCard('AUTH-REGISTER-002', '重复邮箱提示', 'approved', '失败 · 昨天 18:54', ['core', 'module:认证'])}${scenarioCard('AUTH-CLEANUP-004', '合成数据清理', 'draft', '阻塞 · 09-25', ['external', 'flow:清理'])}${scenarioCard('LEGACY-AUTH-001', '旧版登录兼容', 'deprecated', '09-01', ['module:认证'])}</div>`,
  );
}

function scenarioCard(id, name, state, recent, tags) {
  return `<article class="panel scenario-card"><div><span class="scenario-code">${id}</span><h2>${name}</h2><p>验证用户流程中的可观察业务结果，不依赖实现细节。</p></div><div>${status(state, state === 'approved' ? 'ok' : state === 'draft' ? 'warning' : '')}<span class="row-detail">最近执行：${recent}</span><div class="tag-list">${tags.map((tag) => `<span>${tag}</span>`).join('')}</div></div><button class="button-secondary" data-page="scenario">查看场景</button></article>`;
}

export function scenarioPage() {
  return projectPage(
    'scenario',
    '登录状态恢复',
    'AUTH-LOGIN-001 · approved',
    `<div class="scenario-detail-grid"><article class="panel markdown-document"><div class="document-meta"><span>docs/scenario-testing/scenarios/AUTH-LOGIN-001.md</span><code>6405a45b6889</code></div><h2>目的</h2><p>验证用户登录后刷新受保护页面时仍保持登录状态。</p><h2>前置条件</h2><ul><li>使用专用非生产测试账号。</li><li>目标环境不包含真实用户数据。</li></ul><h2>步骤</h2><ol><li>打开登录页面并输入有效凭据。</li><li>进入受保护页面。</li><li>刷新页面并等待会话恢复。</li></ol><h2>期望</h2><p>页面继续显示已登录状态，不跳回登录页。</p><h2>需要记录</h2><p>登录后页面、刷新后的状态以及必要的网络 trace。</p></article><aside class="test-side"><section class="panel"><div class="panel-heading"><h3>来源</h3>${status('已同步', 'ok')}</div>${stats(
      [
        ['状态', 'approved'],
        ['commit', '6405a45b6889'],
        ['索引', '14:02:11'],
        ['文件', 'AUTH-LOGIN-001.md'],
      ],
    )}</section><section class="panel"><div class="panel-heading"><h3>最近执行</h3></div><ul class="list-reset activity-list"><li class="activity-row">${status('通过', 'ok')}<span class="row-title">RUN-01J8Y7K2</span><span class="row-meta">今天 14:26</span></li><li class="activity-row">${status('失败', 'error')}<span class="row-title">RUN-01J8W3C1</span><span class="row-meta">昨天 18:54</span></li></ul></section><section class="panel"><div class="panel-heading"><h3>关联</h3></div><a class="external-link">正式报告 · RUN-01J8Y7K2</a><a class="external-link">场景 PR #184 ↗</a></section></aside></div>`,
  );
}

export function readinessPage() {
  return projectPage(
    'readiness',
    '运行准备',
    '未就绪 · 1 项阻塞',
    `<div class="readiness-summary">${notice('error', 'Git 远程检查超时', '30 秒内未得到响应。最后成功核验：今天 13:42。', button.secondary('重新检查'))}<div class="readiness-actions">${button.secondary('同步场景与报告')}${button.primary('重新检查全部')}</div></div><div class="readiness-grid"><section class="panel"><div class="panel-heading"><h2>仓库与同步</h2>${status('失败', 'error')}</div>${stats(
      [
        ['仓库身份', 'cynos-ai/cynos-website'],
        ['场景分支', 'scenario-testing'],
        ['最近提交', '6405a45b6889'],
        ['最近同步', '8 分钟前'],
      ],
    )}<p class="inline-error">Git 远程检查超时，请检查网络或仓库权限。</p>${button.secondary('同步场景与报告')}</section><section class="panel"><div class="panel-heading"><h2>执行镜像</h2>${status('已准备', 'ok')}</div>${stats(
      [
        ['固定提交', '6405a45b6889'],
        ['Dockerfile', 'Dockerfile.test'],
        ['digest', 'sha256:a31f…'],
        ['更新时间', '今天 13:59'],
      ],
    )}${button.secondary('准备或重建镜像')}</section><section class="panel"><div class="panel-heading"><h2>测试环境</h2>${status('通过', 'ok')}</div>${stats(
      [
        ['环境', 'Cynos 官网非生产环境'],
        ['服务地址', 'staging.example.test'],
        ['测试账号', '已配置'],
        ['清理能力', '已配置'],
      ],
    )}</section><section class="panel"><div class="panel-heading"><h2>共享依赖</h2>${status('3 / 3', 'ok')}</div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">模型 Provider</span>${status('通过', 'ok')}</li><li class="check-row"><span class="row-title">浏览器</span>${status('通过', 'ok')}</li><li class="check-row"><span class="row-title">OSS</span>${status('通过', 'ok')}</li></ul><button class="text-button" data-page="system-status">查看系统状态 →</button></section></div>`,
    { state: '未就绪', stateClass: 'status-warning' },
  );
}

export function projectSettingsPage() {
  return projectPage(
    'project-settings',
    '项目设置',
    '只影响官网非生产测试',
    `<div class="settings-layout"><nav class="settings-nav" aria-label="项目设置分组"><button class="active">基本资料</button><button>测试策略</button><button>测试环境</button><button>执行环境</button><button>自动化</button><button>凭据</button></nav><form class="panel settings-form" onsubmit="return false"><section class="form-section"><div class="panel-heading"><h2>基本资料</h2>${status('当前无任务锁定', 'ok')}</div><div class="field-grid">${formField('项目显示名称', '<input value="官网非生产测试" />')}${formField('仓库身份', '<input value="cynos-ai/cynos-website" disabled />', '仓库稳定身份不可编辑。')}${formField('创建时间', '<input value="2026-09-24 11:08 GMT+8" disabled />')}${formField('projectId', '<input value="6cf0c47f-79f2-4dfa-9e03-2c93ac9919a0" disabled />', '内部技术标识。')}</div></section><section class="form-section"><h2>修改影响</h2><p>修改显示名称不影响仓库身份。测试策略、环境和执行配置修改后需要重新检查。</p></section><div class="form-actions">${button.secondary('放弃修改')}${button.primary('保存基本资料')}</div></form></div>`,
  );
}

export const projectPages = {
  'project-overview': projectOverviewPage,
  'test-idle': testIdlePage,
  'test-queued': testQueuedPage,
  'test-running': testRunningPage,
  'test-completed': testCompletedPage,
  runs: runsPage,
  run: runPage,
  scenarios: scenariosPage,
  scenario: scenarioPage,
  readiness: readinessPage,
  'project-settings': projectSettingsPage,
};
