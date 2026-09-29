export const stageLabels = [
  '排队',
  '准备目标',
  'Main 规划',
  'Runner 执行',
  'Reviewer 审核',
  'Final Main',
  '数据清理',
  '归档索引',
];

const projectPages = new Set([
  'project-overview',
  'test-idle',
  'test-queued',
  'test-running',
  'test-completed',
  'runs',
  'run',
  'scenarios',
  'scenario',
  'readiness',
  'project-settings',
]);

export function topSection(page) {
  if (page === 'workspace') return 'workspace';
  if (page === 'system-status' || page === 'design-system' || page === 'states') return 'system';
  if (page === 'global-settings') return 'settings';
  if (projectPages.has(page) || page === 'projects' || page.startsWith('onboarding-'))
    return 'projects';
  return '';
}

export function projectSection(page) {
  if (page === 'project-overview') return 'overview';
  if (page.startsWith('test-')) return 'test';
  if (page === 'runs' || page === 'run') return 'runs';
  if (page === 'scenarios' || page === 'scenario') return 'scenarios';
  if (page === 'readiness') return 'readiness';
  if (page === 'project-settings') return 'project-settings';
  return '';
}

function navButton(label, page, active) {
  return `<button class="nav-button" type="button" data-page="${page}"${active === page ? ' aria-current="page"' : ''}>${label}</button>`;
}

export function productHeader(page) {
  const active = topSection(page);
  return `
    <header class="product-header">
      <button class="wordmark" type="button" data-page="workspace"><strong>罗网</strong><span>LuoWang</span></button>
      <nav class="global-nav" aria-label="主导航">
        ${navButton('工作台', 'workspace', active)}
        ${navButton('项目', 'projects', active)}
        ${navButton('系统状态', 'system-status', active)}
        ${navButton('设置', 'global-settings', active)}
      </nav>
      <div class="header-meta">
        <button class="text-button issue-count" type="button" data-page="workspace">需要处理 3</button>
        <button class="operator" type="button" data-page="account" aria-label="管理员账号">管</button>
      </div>
    </header>`;
}

export function projectContext(page, options = {}) {
  const active = projectSection(page);
  const links = [
    ['概览', 'project-overview', 'overview'],
    ['测试', 'test-running', 'test'],
    ['测试记录', 'runs', 'runs'],
    ['场景', 'scenarios', 'scenarios'],
    ['运行准备', 'readiness', 'readiness'],
    ['设置', 'project-settings', 'project-settings'],
  ];
  const state = options.state ?? '可运行';
  const stateClass = options.stateClass ?? 'status-ok';
  return `
    <section class="project-context" aria-label="当前项目">
      <div>
        <span class="scope-label">当前项目 · 设计样例</span>
        <h2>官网非生产测试</h2>
        <p>cynos-ai/cynos-website</p>
      </div>
      <div class="project-context-meta">
        <span class="status ${stateClass}">${state}</span>
        <nav class="project-nav" aria-label="项目导航">
          ${links
            .map(
              ([label, target, section]) =>
                `<button class="project-link" type="button" data-page="${target}"${active === section ? ' aria-current="page"' : ''}>${label}</button>`,
            )
            .join('')}
        </nav>
      </div>
    </section>`;
}

export function shell(page, content, options = {}) {
  return `
    <div class="product-shell">
      ${productHeader(page)}
      <div class="product-body">
        ${options.project ? projectContext(page, options) : ''}
        ${content}
      </div>
    </div>`;
}

export function heading(title, fact, scope = '全局 · 设计样例') {
  return `
    <header class="page-heading">
      <div><span class="scope-label">${scope}</span><h1>${title}</h1></div>
      ${fact ? `<p>${fact}</p>` : ''}
    </header>`;
}

export function stageTrack(activeIndex = 3, terminal = '') {
  return `<div class="stage-track" aria-label="测试阶段">
    ${stageLabels
      .map((label, index) => {
        let state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : '';
        if (terminal && index === activeIndex) state = terminal;
        return `<div class="stage-step ${state}"><span>${String(index + 1).padStart(2, '0')}</span>${label}</div>`;
      })
      .join('')}
  </div>`;
}

export function stats(items) {
  return `<dl>${items
    .map(([label, value]) => `<div class="stat-pair"><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('')}</dl>`;
}

export function pageMain(page, title, fact, content, options = {}) {
  return shell(
    page,
    `<main class="page-main">${heading(title, fact, options.scope)}${content}</main>`,
    options,
  );
}

export function status(label, kind = '') {
  return `<span class="status ${kind ? `status-${kind}` : ''}">${label}</span>`;
}

export function emptyState(title, body, action = '') {
  return `<div class="state-block state-empty"><span class="state-mark">—</span><h3>${title}</h3><p>${body}</p>${action}</div>`;
}

export function notice(kind, title, body, action = '') {
  return `<div class="state-block state-${kind}"><span class="state-mark">${kind === 'error' ? '!' : kind === 'stale' ? '~' : kind === 'locked' ? '×' : '·'}</span><div><h3>${title}</h3><p>${body}</p>${action}</div></div>`;
}

export function table(headers, rows, className = '') {
  return `<div class="table-shell ${className}"><table class="data-table"><thead><tr>${headers
    .map((item) => `<th>${item}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

export function formField(label, control, hint = '') {
  return `<label class="field"><span>${label}</span>${control}${hint ? `<small>${hint}</small>` : ''}</label>`;
}

export const button = {
  primary(label, attrs = '') {
    return `<button class="button-primary" type="button" ${attrs}>${label}</button>`;
  },
  secondary(label, attrs = '') {
    return `<button class="button-secondary" type="button" ${attrs}>${label}</button>`;
  },
  danger(label, attrs = '') {
    return `<button class="button-danger" type="button" ${attrs}>${label}</button>`;
  },
};
