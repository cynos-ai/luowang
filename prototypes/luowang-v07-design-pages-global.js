import {
  button,
  emptyState,
  formField,
  heading,
  notice,
  pageMain,
  shell,
  stageTrack,
  stats,
  status,
  table,
} from './luowang-v07-design-kit.js';

export function loginPage() {
  return `<div class="login-prototype">
    <div class="login-brand"><span>LuoWang</span><strong>罗网</strong><p>v0.7.0</p></div>
    <main class="login-surface">
      <span class="scope-label">单管理员安全入口</span>
      <h1>登录</h1>
      <form class="login-form-sample" onsubmit="return false">
        ${formField('管理员密码', '<input type="password" value="synthetic-password" />')}
        ${button.primary('登录')}
      </form>
      <div class="login-alert">服务尚未完成安全初始化时，只显示部署操作提示，不提供网页设密。</div>
      <small>罗网 v0.7.0 · 非生产控制台</small>
    </main>
  </div>`;
}

export function workspacePage() {
  return pageMain(
    'workspace',
    '工作台',
    '3 项需要处理 · 1 项正在执行 · 2 个请求等待',
    `<div class="page-grid workspace-grid">
      <section class="panel panel-attention">
        <div class="panel-heading"><h2>需要处理</h2><span class="sample-flag">3</span></div>
        <ul class="list-reset issue-list">
          <li class="issue-row"><div><span class="row-title">Git 远程检查超时</span><span class="row-detail">Closure 7 Fixture · 12 分钟前</span></div><button class="text-button" data-page="readiness">处理</button></li>
          <li class="issue-row"><div><span class="row-title">测试数据清理告警</span><span class="row-detail">官网非生产测试 · RUN…Q4B</span></div><button class="text-button" data-page="run">查看</button></li>
          <li class="issue-row"><div><span class="row-title">场景 PR 等待审核</span><span class="row-detail">Portal Sandbox · PR #184</span></div><span class="row-meta">GitHub</span></li>
        </ul>
      </section>
      <section class="panel panel-current">
        <div class="panel-heading"><div><span class="eyeline">官网非生产测试 · RUN…7K2</span><h2>Runner 正在执行场景</h2></div>${status('执行中', 'running')}</div>
        <div class="current-stage"><div><span class="eyeline">当前场景</span><h2>AUTH-LOGIN-001 · 登录状态恢复</h2>${stageTrack(3)}</div>${stats(
          [
            ['开始', '14:08:21'],
            ['已持续', '08:42'],
            ['场景', '3 / 8'],
            ['更新', '刚刚'],
          ],
        )}</div>
      </section>
      <section class="panel panel-queue">
        <div class="panel-heading"><h2>等待队列</h2><small>2 项</small></div>
        <ol class="list-reset queue-list"><li class="queue-row"><span class="row-title">01 · Closure 7 Fixture</span><span class="row-detail">等待当前测试完成 · 14:11</span></li><li class="queue-row"><span class="row-title">02 · Portal Sandbox</span><span class="row-detail">项目已暂停，请求保留 · 13:54</span></li></ol>
      </section>
      <section class="panel panel-projects">
        <div class="panel-heading"><h2>项目状态</h2><button class="text-button" data-page="projects">查看全部</button></div>
        ${table(
          ['项目', '状态', '最近测试', '同步', '待处理'],
          [
            [
              '<strong>官网非生产测试</strong><span class="row-detail">cynos-ai/cynos-website</span>',
              status('执行中', 'running'),
              'RUN…7K2',
              '8 分钟前',
              '1',
            ],
            [
              '<strong>Closure 7 Fixture</strong><span class="row-detail">cynos-ai/luowang-closure7-fixture</span>',
              status('未就绪', 'warning'),
              '通过 · 昨天',
              '检查超时',
              '1',
            ],
            [
              '<strong>Portal Sandbox</strong><span class="row-detail">cynos-ai/portal-sandbox</span>',
              status('已暂停'),
              '阻塞 · 09-25',
              '2 天前',
              '1',
            ],
          ],
        )}
      </section>
      <section class="panel panel-recent"><div class="panel-heading"><h2>最近完成</h2><small>测试记录</small></div><ul class="list-reset activity-list"><li class="activity-row">${status('通过', 'ok')}<span class="row-title">Closure 7 Fixture</span><span class="row-meta">昨天 18:42</span></li><li class="activity-row">${status('阻塞', 'warning')}<span class="row-title">Portal Sandbox</span><span class="row-meta">09-25 16:07</span></li><li class="activity-row">${status('通过', 'ok')}<span class="row-title">官网非生产测试</span><span class="row-meta">09-25 11:20</span></li></ul></section>
    </div>`,
  );
}

export function projectsPage() {
  return pageMain(
    'projects',
    '项目',
    '按需要处理、执行中、排队、正常和暂停排序',
    `<div class="filter-bar">
      ${formField('筛选', '<input placeholder="项目名称或仓库" />')}
      ${formField('状态', '<select><option>全部状态</option><option>需要处理</option><option>正在执行</option><option>已暂停</option></select>')}
      ${formField('排序', '<select><option>需要处理优先</option><option>名称</option><option>最近活动</option></select>')}
      ${button.primary('连接新项目', 'data-page="onboarding-repo"')}
    </div>
    <div class="project-directory">
      ${projectRow('官网非生产测试', 'cynos-ai/cynos-website', '执行中', 'running', 'RUN…7K2', '8 分钟前', '1')}
      ${projectRow('Closure 7 Fixture', 'cynos-ai/luowang-closure7-fixture', '未就绪', 'warning', '通过 · 昨天', '检查超时', '1')}
      ${projectRow('Portal Sandbox', 'cynos-ai/portal-sandbox', '已暂停', '', '阻塞 · 09-25', '2 天前', '1')}
    </div>`,
  );
}

function projectRow(name, repo, state, kind, recent, sync, issues) {
  return `<article class="panel directory-row"><div><span class="eyeline">${repo}</span><h2>${name}</h2></div><div>${status(state, kind)}<span class="row-detail">最近测试 ${recent}</span></div><div><strong>${sync}</strong><span class="row-detail">最近同步</span></div><div><strong>${issues}</strong><span class="row-detail">需要处理</span></div><button class="button-secondary" data-page="project-overview">进入项目</button><button class="icon-button" aria-label="项目菜单">•••</button></article>`;
}

const onboardingMeta = {
  'onboarding-repo': [0, '连接仓库', '先核验稳定仓库身份，再建立暂停项目。'],
  'onboarding-test': [1, '配置测试', '默认值只是初始配置，不代表已经检查通过。'],
  'onboarding-env': [2, '配置环境', '只允许非生产环境；Secret 保存后不回显。'],
  'onboarding-ready': [3, '准备并启用', '完成检查后仍由操作者明确启用。'],
};

export function onboardingPage(page) {
  const [index, , fact] = onboardingMeta[page];
  const steps = ['连接仓库', '配置测试', '配置环境', '准备并启用'];
  return pageMain(
    page,
    '连接新项目',
    fact,
    `<div class="wizard-layout"><nav class="wizard-steps" aria-label="接入步骤">${steps
      .map(
        (label, item) =>
          `<button class="wizard-step ${item === index ? 'active' : item < index ? 'done' : ''}" data-page="${Object.keys(onboardingMeta)[item]}"><span>0${item + 1}</span><strong>${label}</strong><small>${item < index ? '已保存' : item === index ? '当前步骤' : '尚未开始'}</small></button>`,
      )
      .join('')}</nav>${onboardingBody(page)}</div>`,
    { scope: '新项目接入 · 可随时退出' },
  );
}

function onboardingBody(page) {
  if (page === 'onboarding-repo')
    return `<form class="panel wizard-panel" onsubmit="return false"><div class="panel-heading"><h2>连接仓库</h2>${status('尚未创建')}</div><div class="field-grid">${formField('项目显示名称', '<input value="Closure 7 Fixture" />')}${formField('GitHub 仓库地址', '<input value="https://github.com/cynos-ai/luowang-closure7-fixture" />')}${formField('GitHub Token', '<input type="password" value="synthetic-token" />', '私有仓库必填，创建后不回显。')}</div><div class="form-actions">${button.secondary('返回项目')}${button.primary('核验并创建暂停项目', 'data-page="onboarding-test"')}</div></form>`;
  if (page === 'onboarding-test')
    return `<form class="panel wizard-panel" onsubmit="return false"><div class="panel-heading"><h2>配置测试</h2>${status('项目已暂停', 'warning')}</div><div class="field-grid">${formField('场景分支', '<input value="scenario-testing" />')}${formField('场景维护模式', '<select><option>自动维护</option><option>仅自动新增</option><option>全部人工审核</option></select>')}${formField('固定包含标签', '<input value="core" />')}${formField('生成语言', '<input value="zh-CN" />')}${formField('执行 Dockerfile', '<input value="Dockerfile.test" />')}</div><div class="form-actions">${button.secondary('上一步', 'data-page="onboarding-repo"')}${button.primary('保存并继续', 'data-page="onboarding-env"')}</div></form>`;
  if (page === 'onboarding-env')
    return `<form class="panel wizard-panel" onsubmit="return false"><div class="panel-heading"><h2>配置环境</h2>${status('非生产', 'warning')}</div><label class="confirm-line"><input type="checkbox" checked /> 我确认该环境没有生产数据和真实用户</label><div class="field-grid">${formField('环境说明', '<textarea>Cynos 官网独立验收环境</textarea>')}${formField('服务地址', '<input value="https://staging.example.test" />')}${formField('测试账号', '<input value="synthetic@example.test" />')}${formField('测试密码', '<input type="password" value="synthetic-password" />')}${formField('清理地址', '<input value="https://staging.example.test/api/test-cleanup" />')}${formField('清理 Token', '<input type="password" value="synthetic-token" />')}</div><div class="form-actions">${button.secondary('上一步', 'data-page="onboarding-test"')}${button.primary('安全保存并继续', 'data-page="onboarding-ready"')}</div></form>`;
  return `<section class="panel wizard-panel"><div class="panel-heading"><h2>准备并启用</h2>${status('3 / 4', 'running')}</div><ol class="readiness-sequence"><li class="done"><strong>同步仓库</strong><span>6405a45b6889 · 已完成</span></li><li class="done"><strong>准备执行镜像</strong><span>sha256:a31f… · 已完成</span></li><li class="active"><strong>检查环境和共享依赖</strong><span>正在检查 OSS</span></li><li><strong>明确启用项目</strong><span>等待全部检查通过</span></li></ol>${notice('locked', '尚不能启用', '模型与浏览器通过，OSS 检查仍在进行。')}<div class="form-actions">${button.secondary('上一步', 'data-page="onboarding-env"')}${button.primary('启用项目', 'disabled')}</div></section>`;
}

export function systemStatusPage() {
  return pageMain(
    'system-status',
    '系统状态',
    '只读诊断 · 最近检查 14:20:08',
    `<div class="system-status-grid">
      <section class="panel system-services"><div class="panel-heading"><h2>服务</h2>${status('正常', 'ok')}</div>${stats(
        [
          ['LuoWang', 'v0.7.0'],
          ['数据库', 'SQLite · 正常'],
          ['Secret Store', '可用'],
          ['调度器', '运行中'],
        ],
      )}</section>
      <section class="panel system-dependencies"><div class="panel-heading"><h2>共享依赖</h2><button class="button-secondary">重新检查</button></div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">模型 Provider</span>${status('通过', 'ok')}<span class="row-detail">14:19:54</span></li><li class="check-row"><span class="row-title">浏览器运行环境</span>${status('通过', 'ok')}<span class="row-detail">14:19:58</span></li><li class="check-row"><span class="row-title">对象存储</span>${status('不可达', 'error')}<span class="row-detail">连接超时，最后成功 13:42</span></li></ul></section>
      <section class="panel system-resources"><div class="panel-heading"><h2>执行资源</h2><small>只读盘点</small></div>${table(
        ['类型', '项目', '归属', '体积'],
        [
          ['容器', '官网非生产测试', '当前 Run', '—'],
          ['镜像', 'Closure 7 Fixture', '可重启候选', '1.8 GB'],
          ['镜像', 'Portal Sandbox', '人工核对', '734 MB'],
        ],
      )}<p class="row-detail">候选体积不表示 Docker 一定能回收同等空间。</p></section>
      <section class="panel system-recovery"><div class="panel-heading"><h2>恢复</h2></div><p>查看持久卷备份、数据库回退和 Docker 项目资源恢复说明。</p>${button.secondary('打开恢复说明')}</section>
    </div>`,
  );
}

export function globalSettingsPage() {
  return pageMain(
    'global-settings',
    '全局设置',
    '影响当前部署中的全部项目',
    `<div class="settings-layout"><nav class="settings-nav" aria-label="设置分组"><button class="active">模型与角色</button><button>浏览器</button><button>对象存储</button><button>本地数据</button><button>全局凭据</button></nav><form class="panel settings-form" onsubmit="return false"><section class="form-section"><div class="panel-heading"><h2>模型与角色</h2>${status('当前无任务锁定', 'ok')}</div><div class="field-grid">${formField('Provider', '<input value="deepseek" />')}${formField('Provider Base URL', '<input value="https://api.deepseek.com" />')}</div></section><section class="form-section"><h2>角色模型</h2><div class="field-grid">${formField('Main 模型', '<input value="deepseek-v4-flash" />', 'Final Main 使用同一组 Main 配置。')}${formField('Runner 模型', '<input value="deepseek-v4-flash" />')}${formField('Reviewer 模型', '<input value="deepseek-v4-flash-vision-exp" />')}${formField('Reviewer thinking', '<select><option>high</option></select>')}</div></section><section class="form-section"><h2>影响范围</h2><p>保存后影响 3 个项目。保存成功不表示模型连接检查通过。</p></section><div class="form-actions">${button.secondary('放弃修改')}${button.primary('保存模型设置')}</div></form></div>`,
    { scope: '全局作用域' },
  );
}

export function accountPage() {
  return pageMain(
    'account',
    '账号设置',
    '当前部署只有一名管理员',
    `<div class="account-grid"><form class="panel" onsubmit="return false"><div class="panel-heading"><h2>管理员资料</h2></div>${formField('显示名称', '<input value="管理员" />', '显示名称不参与授权。')}<div class="form-actions">${button.primary('保存显示名称')}</div></form><form class="panel" onsubmit="return false"><div class="panel-heading"><h2>修改密码</h2></div>${formField('当前密码', '<input type="password" value="current-password" />')}${formField('新密码', '<input type="password" value="new-long-password" />')}${formField('确认新密码', '<input type="password" value="new-long-password" />', '至少 12 个字符。')}<div class="form-actions">${button.primary('修改密码并退出')}</div></form><section class="panel account-session"><div class="panel-heading"><h2>当前会话</h2>${status('已认证', 'ok')}</div><p>退出后需要重新输入管理员密码。</p>${button.secondary('退出登录')}</section></div>`,
    { scope: '用户菜单' },
  );
}

export function statesPage() {
  return pageMain(
    'states',
    '界面状态',
    '每个区域独立表达，不用假数据填充',
    `<div class="state-gallery"><section class="panel"><div class="panel-heading"><h2>加载中</h2></div><div class="skeleton-lines"><i></i><i></i><i></i></div></section><section class="panel">${emptyState('还没有测试记录', '发起第一次测试后，记录会出现在这里。', button.primary('前往测试', 'data-page="test-idle"'))}</section><section class="panel">${notice('error', '项目资料加载失败', '其他项目仍可使用。请求 ID：REQ-81A', button.secondary('重试'))}</section><section class="panel">${notice('stale', '正在显示陈旧缓存', 'GitHub 暂时不可达。最后成功同步：13:42。', button.secondary('重新同步'))}</section><section class="panel">${notice('locked', '配置暂时锁定', '测试记录 RUN-01J8Y7K2 正在执行，完成后才能修改。', button.secondary('查看当前测试', 'data-page="test-running"'))}</section><section class="panel evidence-state"><div class="panel-heading"><h2>Evidence 状态</h2></div><ul class="list-reset check-list"><li class="check-row"><span class="row-title">login.png</span>${status('可用', 'ok')}<span class="row-detail">页面含可见表单值</span></li><li class="check-row"><span class="row-title">cleanup-query.txt</span>${status('完整性失败', 'error')}<span class="row-detail">SHA-256 不匹配</span></li><li class="check-row"><span class="row-title">trace.zip</span>${status('外部存储不可达', 'warning')}<span class="row-detail">功能结论不自动改写</span></li></ul></section></div>`,
  );
}

export function designSystemPage() {
  const colors = [
    ['深黑', '#070707', '#fff'],
    ['报纸白', '#FFFDF4', '#070707'],
    ['行动红', '#E51C23', '#fff'],
    ['冷灰', '#85857F', '#070707'],
  ];
  return shell(
    'design-system',
    `<main class="page-main">${heading('怪盗动态构成', '已选定的唯一视觉方向', 'v0.7.0 · 设计规范')}<div class="system-grid"><section class="panel system-intro"><div class="panel-heading"><h2>设计语法</h2><span class="sample-flag">最终</span></div>${stats(
      [
        ['密度', '7 / 10'],
        ['切角', '10–14px'],
        ['动效', '140ms'],
        ['主画布', '1440px'],
      ],
    )}<p class="type-sample-body">倾斜、切角和错位可以进入文字与控件，但必须保证边界、字号、阅读顺序和操作命中。</p></section><section class="panel palette-panel"><div class="panel-heading"><h2>颜色</h2><small>状态不能只靠颜色</small></div><div class="palette">${colors.map(([name, color, text]) => `<div class="swatch" style="--swatch:${color};--swatch-text:${text}">${name}<span>${color}</span></div>`).join('')}</div></section><section class="panel type-panel"><span class="eyeline">Typography</span><div class="type-sample-display">事实先于装饰</div><p class="type-sample-body">标题建立判断顺序，正文承载操作事实，等宽字体只用于时间、ID、commit 和 digest。</p></section><section class="panel component-panel"><div class="panel-heading"><h2>控件与状态</h2><small>完整状态见“界面状态”</small></div><div class="component-row">${button.primary('主要操作')}${button.secondary('次要操作')}${button.danger('高风险操作')}</div><div class="component-row">${status('通过', 'ok')}${status('执行中', 'running')}${status('阻塞', 'warning')}${status('失败', 'error')}</div><div class="component-row">${button.secondary('查看确认弹框', 'data-open-modal')}</div></section></div></main>`,
  );
}

export const globalPages = {
  login: loginPage,
  workspace: workspacePage,
  projects: projectsPage,
  'onboarding-repo': () => onboardingPage('onboarding-repo'),
  'onboarding-test': () => onboardingPage('onboarding-test'),
  'onboarding-env': () => onboardingPage('onboarding-env'),
  'onboarding-ready': () => onboardingPage('onboarding-ready'),
  'system-status': systemStatusPage,
  'global-settings': globalSettingsPage,
  account: accountPage,
  states: statesPage,
  'design-system': designSystemPage,
};
