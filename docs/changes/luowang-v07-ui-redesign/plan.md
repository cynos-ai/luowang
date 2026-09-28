# LuoWang v0.7.0 UI 重构实施计划

- 版本：v0.7.0
- 状态：Implementation Plan v1；Phase 0–4 已完成
- 日期：2026-09-27
- 关联规格：[spec.md](./spec.md)
- 视觉设计：[design.md](./design.md)
- 实现分支：`feat/v07-ui-redesign`
- 基线：`develop` / `2c265fb`

## 1. 计划目标

本计划把已经确认的信息架构和“怪盗动态构成”视觉设计落入当前多项目生产控制台，同时保持现有项目隔离、顺序队列、Secret、安全校验和 Run 结果语义。

完成后必须证明：

1. `工作台｜项目｜系统状态｜设置` 和项目内六个页面均有稳定 URL；
2. 登录、项目接入、测试、测试记录、场景、运行准备和设置使用真实 API，不使用原型样例数据；
3. `passed / failed / blocked / interrupted / running` 保持现有语义；
4. 全局配置和项目配置严格分离；
5. 选定视觉方向完整进入生产组件，不退化成传统卡片后台；
6. 1440px、1024px、768px、键盘和 200% 缩放通过验收；
7. #94 Git 远程检查在有界时间内结束；
8. 现有多项目隔离、认证、配置、队列、归档、证据和 Secret 测试不倒退。

## 2. 当前实现事实

### 2.1 前端

当前生产入口为 `src/web/main.tsx`。`GET /api/mode` 返回 `multi-project` 时加载 `src/web/projects/ProjectApp.tsx`。

当前多项目界面存在以下事实：

- `ProjectApp.tsx` 为 1118 行单文件，混合登录、项目列表、项目详情、部署设置和账号设置；
- 只通过 `#/projects/:projectId` 选择项目，没有真实页面路由和详情深链接；
- 一个项目详情页同时堆放概览、就绪检查、项目设置、凭据、镜像、同步、发起测试、队列、Run 和场景；
- 项目切换已经使用 `AbortController` 和 mounted 检查防止部分迟到响应覆盖新项目；
- `Shell.tsx` 和 `styles.css` 仍是旧蓝紫暗色控制台；
- `App.tsx`、`SettingsPage.tsx` 和 Phase 8 UI 属于旧单项目路径，不能作为新多项目信息架构的页面 owner；
- 当前无 React Router 依赖；Fastify 已对非 API GET 提供 SPA fallback；
- 原型位于 `prototypes/`，只用于设计验证，不能直接复制原型状态和样例数据进入生产。

### 2.2 现有多项目 API

可直接复用：

- 认证与账号：`/api/auth/*`、`/api/account`；
- 全局配置与 Secret：`/api/deployment`、`/api/deployment/secrets/:key`；
- 项目创建、详情、暂停、恢复、配置和 Secret：`/api/projects/**`；
- 项目就绪、镜像准备和仓库同步；
- 项目队列、当前 Run、Run 列表和 Run 详情；
- 项目 Evidence 受控读取；
- 项目场景、场景详情、报告列表和报告详情。

当前缺口：

- 没有跨项目工作台聚合接口；
- 项目列表没有当前执行、排队、最近结论、同步陈旧和待处理摘要；
- 没有认证后的系统状态聚合接口；
- Docker 资源盘点只有 `ops:inventory` CLI，没有只读 HTTP 入口；
- 后台调度器没有供控制台读取的结构化状态；
- 已有 `connectivity_check_results` 和 `project_connectivity_check_results` 表，但多项目 App 尚未把它们接入系统状态和项目就绪读模型；
- 全局 Provider、浏览器和 OSS 状态没有多项目控制台专用读模型；
- 项目就绪的 Git CLI 远程读取没有有界超时；
- 当前项目 Run 路由返回的数据具备底层事实，但前端尚未结构化展示归档、Issue、场景 PR、证据和报告。

### 2.3 测试

现有相关证明：

- `tests/multi-project-app.test.ts`：项目路由、隔离、认证、Evidence 和请求边界；
- `tests/e2e/multi-project-ui-smoke.ts`：多项目切换、迟到响应、接入、就绪、镜像和提交请求；
- `tests/e2e/phase8-ui-smoke.ts`：旧单项目运维控制台的状态、Run、场景、设置和 XSS 回归；
- `npm run test:e2e` 当前依次执行旧 smoke、Phase 8 和多项目 UI smoke。

新 UI 必须替换多项目 UI smoke 的旧 DOM 假设，同时保留其项目隔离和迟到响应断言。旧 Phase 8 测试不能被冒充为新多项目页面证明。

## 3. 实现原则

### 3.1 先建立生产读模型，再铺页面

跨项目工作台和系统状态不得由前端对每个项目触发一组远程就绪检查。服务端应聚合已有 SQLite、队列、Run、索引和调度事实，只在用户明确执行“重新检查”时调用外部依赖。

### 3.2 不建立第二份事实源

- 项目、队列、Run、场景、报告、Evidence 和配置继续由现有 owner 提供；
- 新接口只做结构化聚合和脱敏，不复制持久数据；
- 运行结论不从页面颜色、队列状态或报告文本反推；
- 没有已持久化事实时返回 `null / unknown / not_checked`，不补模拟值。

### 3.3 路由不依赖进程内选择

采用浏览器 History API 和一个受测试的类型化路由解析器，不为本版增加路由库。所有重要对象都从 URL 解析 `projectId`、`runId`、`scenarioId` 和设置分组。

旧 `#/projects/:projectId` 链接首次访问时重定向到 `/projects/:projectId/overview`。新页面不继续写 Hash URL。

### 3.4 迟到响应必须按资源归属丢弃

每个路由级资源请求使用独立 `AbortController` 和请求版本。项目或详情 ID 改变后，旧响应不能：

- 覆盖新页面数据；
- 显示旧项目成功提示；
- 恢复旧项目表单；
- 注入旧项目 Evidence 或报告。

### 3.5 页面区域独立失败

聚合页的每个区域独立表示加载、空、失败和陈旧。部分 API 失败不能清空其他已成功区域。轮询失败保留最后可信值，并显示最后成功时间。

### 3.6 原型只提供视觉语言

不能把原型中的项目名、Run ID、提交、时间、状态或统计写进生产默认值。生产组件复用 `design.md` 的 token、构图和组件规则，但所有内容来自真实接口。

## 4. 路由设计

### 4.1 登录与全局页面

| URL | 页面 owner | 主要数据 |
| --- | --- | --- |
| `/login` | `LoginPage` | auth status、health |
| `/workspace` | `WorkspacePage` | 跨项目工作台聚合 |
| `/projects` | `ProjectsPage` | 项目摘要与筛选 |
| `/projects/new` | `ProjectOnboardingPage` | 创建、配置、Secret、镜像、就绪 |
| `/system` | `SystemStatusPage` | 系统、共享依赖、资源盘点 |
| `/settings/:section` | `GlobalSettingsPage` | deployment config、全局 Secret |
| `/account` | `AccountPage` | profile、password |

### 4.2 项目页面

| URL | 页面 owner | 主要数据 |
| --- | --- | --- |
| `/projects/:projectId/overview` | `ProjectOverviewPage` | 项目、索引、当前/最近 Run、就绪摘要 |
| `/projects/:projectId/test` | `ProjectTestPage` | 当前 Run、队列、发起测试 |
| `/projects/:projectId/runs` | `ProjectRunsPage` | 测试记录列表 |
| `/projects/:projectId/runs/:runId/:tab?` | `ProjectRunPage` | Run、工件、报告、Evidence、归档和 Issue |
| `/projects/:projectId/scenarios` | `ProjectScenariosPage` | 场景列表与筛选 |
| `/projects/:projectId/scenarios/:scenarioId` | `ProjectScenarioPage` | Markdown、Git 来源、相关历史 |
| `/projects/:projectId/readiness` | `ProjectReadinessPage` | 就绪检查、同步和镜像 |
| `/projects/:projectId/settings/:section` | `ProjectSettingsPage` | 项目配置和项目 Secret |

### 4.3 路由行为

- `/`：认证后重定向 `/workspace`，未认证重定向 `/login`；
- 不存在的项目、Run 或场景显示作用域内 404，不退回其他项目；
- 详情页切换项目时进入新项目对应列表页，不复用详情 ID；
- 有未保存修改时，站内导航和 `popstate` 都先确认；
- 写操作提交中禁止切换项目；
- 页面标题随路由更新；
- Fastify SPA fallback 保证刷新和直接访问深链接；
- 外部 GitHub、报告和 Evidence 链接不劫持站内路由。

## 5. 服务端读模型与 API

### 5.1 跨项目工作台

新增认证接口：

```text
GET /api/workspace
```

响应只聚合已有事实：

- `fetchedAt`；
- `activeRun` 及其 projectId、项目名、阶段、角色、当前场景、进度和更新时间；
- 全局 FIFO 中未完成请求的实际顺序；
- 项目摘要：active/paused、当前执行/排队、最近 Run 结论、最近一次已保存的就绪检查、待处理数量、最近索引时间和陈旧原因；
- 最近完成的 Run；
- 待人工处理项：未就绪、blocked、清理/归档失败、索引错误、场景 PR 和后台错误。

实现要求：

- 复用 `ProjectStore`、项目 Queue、`RunStore`、Recovery、Indexer 状态、自动化状态、现有 `project_connectivity_check_results` 和 Dispatcher；
- 项目 readiness 执行后覆盖保存每项最新结果；项目配置、Secret、镜像或部署配置变化时使受影响结果失效，工作台没有历史结果时显示“尚未检查”，不猜测 ready；
- readiness 结果只是可重建读缓存，不建立检查历史；
- 不执行 Git fetch、Provider 请求、Docker 构建或环境探测；
- 每条事项包含稳定项目/Run 入口；
- 一个项目读取失败时返回局部错误，不让其他项目消失；
- 不包含 Secret、模型对话、Prompt、任意本机路径或原始命令输出。

建议 owner：

```text
src/server/projects/console-service.ts
src/server/projects/console-routes.ts
```

共享响应类型进入 `src/shared/types.ts`。

### 5.2 系统状态

新增认证接口：

```text
GET /api/system/status
GET /api/system/resources
POST /api/system/checks/:checkId
```

`status` 复用现有 `connectivity_check_results` 持久结果，不另建依赖健康事实源，并返回：

- 版本、数据库和 Secret Store 可用状态；
- 调度器是否启动、最近轮询/索引错误等已持久事实；
- Provider、浏览器和 OSS 的 `ok / degraded / unavailable / not_configured / unknown`；
- 每项最后检查时间；
- 恢复说明的固定入口信息。

`resources` 复用 `inspectProjectResources()`，只返回现有只读盘点：

- 当前实例确认归属的容器；
- 项目镜像及 `referenced / restart-candidate / manual-review`；
- 候选体积；
- 归属核验失败时整个资源预览失败，不展示部分清理建议。

`checks/:checkId` 只允许固定的 Provider、browser 和 OSS 检查 ID，复用现有 adapter。它不接受任意 URL、命令或路径。

系统状态轮询读取最近事实；外部检查只由用户显式触发或按已有后台规则更新，不能每次页面轮询都调用外部服务。服务重启后没有已保存检查结果时显示 `not_checked`，不能把进程可启动解释成依赖已通过。

### 5.3 项目页面

项目 readiness 增加显式读写分离接口：

```text
GET /api/projects/:projectId/readiness/status
POST /api/projects/:projectId/readiness/check
```

`status` 只读取最近持久结果；`check` 执行该项目的固定检查集合，不接受任意检查 ID、URL、命令或路径。现有 `GET /api/projects/:projectId/readiness` 保留已有行为，新页面不得通过轮询该旧接口隐式触发外部检查。

其余优先复用现有项目接口。仅在以下情况增加聚合字段：

- 项目列表需要 current/queued/recent/index summary；
- Run 详情需要明确输出现有 archive、scenario PR、issues、blocking reasons 和 Evidence metadata；
- 场景详情需要项目内最近执行历史和相关报告/PR，复用现有 Run/Report 查询形成受限摘要。

不新建在线场景编辑、取消 Run、删除项目、全局搜索、通知或跨项目并行接口。

### 5.4 #94 Git 远程检查超时

修改 `GitRepository` 的命令执行边界，为 Git CLI 增加显式、可测试的超时参数：

- 本地 Git 命令使用有界默认值；
- readiness 的 `ls-remote` 等远程只读检查使用 30 秒上限；
- clone/fetch/push 等正常生产操作使用独立的较长上限，不复用短 readiness 上限；
- 超时杀死子进程并清理临时 askpass 目录；
- 返回脱敏、可操作的“Git 远程检查超时”，不包含 Token、凭据 URL 或本机敏感路径；
- 超时只让对应 readiness 区域失败，不能卡住整个 HTTP 请求或错误启用项目。

测试必须使用可控挂起进程证明超时上界和清理，不依赖真实 GitHub 卡顿。

## 6. 前端结构

把当前 `ProjectApp.tsx` 拆为明确 owner，避免继续扩展单文件：

```text
src/web/
├── app/
│   ├── AppRouter.tsx
│   ├── route.ts
│   └── resource.ts
├── components/
│   ├── AppShell.tsx
│   ├── ProjectContext.tsx
│   ├── PageHeading.tsx
│   ├── StatusLabel.tsx
│   ├── AsyncRegion.tsx
│   ├── ConfirmDialog.tsx
│   ├── DataTable.tsx
│   ├── MarkdownView.tsx
│   └── FormControls.tsx
├── pages/
│   ├── LoginPage.tsx
│   ├── WorkspacePage.tsx
│   ├── ProjectsPage.tsx
│   ├── ProjectOnboardingPage.tsx
│   ├── SystemStatusPage.tsx
│   ├── GlobalSettingsPage.tsx
│   ├── AccountPage.tsx
│   └── project/
│       ├── ProjectOverviewPage.tsx
│       ├── ProjectTestPage.tsx
│       ├── ProjectRunsPage.tsx
│       ├── ProjectRunPage.tsx
│       ├── ProjectScenariosPage.tsx
│       ├── ProjectScenarioPage.tsx
│       ├── ProjectReadinessPage.tsx
│       └── ProjectSettingsPage.tsx
├── api.ts
├── main.tsx
├── tokens.css
├── components.css
└── pages.css
```

实际文件可在实现中合并相邻的小组件，但不能重新形成一个同时拥有全部页面状态的巨型组件。

### 6.1 状态边界

- 路由状态来自 URL；
- 表单草稿只属于当前页面；
- 服务端数据按 URL 资源 key 缓存；
- 轮询只在工作台、当前测试等需要实时事实的页面开启；
- 页面隐藏后停止轮询；
- 自动刷新失败保留最后可信数据；
- 不引入全局状态库。

### 6.2 Markdown

场景和正式报告需要渲染视图与原文视图。采用经过维护的 Markdown renderer，默认禁止 raw HTML，并为链接、图片和代码块提供受控组件。

如果新增依赖，必须：

- 固定版本并更新 lockfile；
- 不启用 raw HTML；
- 外部链接使用安全 `rel`；
- Evidence 图片只从当前项目/Run 的受控 API 读取；
- 保留现有 XSS 回归并增加多项目场景/报告用例。

### 6.3 CSS 和视觉 token

生产 CSS 以 `design.md` 为事实源：

- `tokens.css`：颜色、字体、空间、线条、角度和动效；
- `components.css`：Shell、导航、面板、状态、阶段、表格、表单和弹框；
- `pages.css`：页面网格和少量页面特定构图；
- 组件先完成正常文档流，再应用切角、旋转和错位；
- 不能用固定高度或 `overflow: hidden` 掩盖长文本；
- 不能把原型 toolbar 和样例标记带入产品。

旧 `styles.css` 在迁移期间按入口隔离。新多项目 UI 完成后删除已无引用的多项目旧样式；旧单项目路径是否退役不在本计划擅自决定。

## 7. 分阶段实施

全部阶段在当前 `feat/v07-ui-redesign` 完成，通过一个面向 `develop` 的 PR 合并。每阶段单独提交并满足自己的退出条件，避免一次性替换后无法定位回归。

### 实施前设计完成门（已完成）

进入 Phase 0 前已经完成：

1. Intent、Spec、Design 和 Plan 四份变更文档；
2. 登录、四个全局页面、账号设置、四步项目接入、六个项目页面及关键详情的完整页面构图；
3. 测试页的 idle、queued、running 和 completed 四种主状态；
4. 加载、空、错误、陈旧、锁定和 Evidence 异常状态样例；
5. 确认弹框、表格、表单、阶段条、状态标签和 Markdown 阅读区样例；
6. 23 个页面或状态在 1440px、1024px 和 768px 的横向溢出检查；
7. 23 个桌面页面截图和视觉总览。

这些原型冻结页面归属、主要构图和状态表达。生产实现仍必须使用真实 API，并重新完成键盘、焦点、200% 缩放、读屏、XSS 和响应迟到验收。

### Phase 0：契约冻结与测试骨架

#### 修改范围

1. 把本文、`spec.md`、`design.md` 和最终原型纳入版本控制；
2. 增加纯函数路由解析/生成测试，覆盖全部稳定 URL、非法 ID 和旧 Hash 重定向；
3. 为新跨项目和系统状态响应定义共享类型；
4. 建立新 UI E2E fixture builder，统一生成 project、queue、Run、scenario、report、Evidence 和状态数据；
5. 不修改生产页面行为。

#### 退出条件

- 路由表和响应类型经过 review；
- fixture 明确标记为测试数据；
- `node --check`、格式和类型检查通过；
- 后续页面不需要各自复制 API 假数据。

### Phase 1：读模型、系统状态与 Git 超时（已完成）

#### 修改范围

1. 新增跨项目工作台聚合 service/route；
2. 新增认证后的系统状态和只读资源盘点 route；
3. 为后台调度器提供只读状态，不改变调度行为；
4. 将现有全局和项目 connectivity 结果表接入多项目读模型；readiness 执行时保存最新结果，相关配置变化时失效，不新增检查历史或第二份长期事实；
5. 复用项目 Queue、RunStore、Indexer 和自动化状态，补齐项目摘要；
6. 实现 #94 的 Git 命令分级超时和脱敏错误；
7. 增加 API 隔离、认证、局部失败、Secret 阴性和 timeout 测试。

#### 退出条件

- 聚合接口不执行隐式外部检查和写操作；
- 项目 A 的数据不会进入项目 B；
- Docker 归属失败时 fail closed；
- 挂起 Git readiness 在 30 秒上限内结束，测试使用更短注入值；
- 现有项目 API 与队列测试通过。

完成证明：`GET /api/workspace`、系统状态/资源、显式 readiness 检查和缓存失效已接入生产 app；清理失败使用 Harness 写入的结构化 activity code 聚合，不解析 Agent 文本；Git 本地、远程读写命令采用分级超时并清理 askpass。Docker quality 环境全量 Vitest 为 465 项通过、2 项跳过，格式、lint、typecheck、build 和 `git diff --check` 通过。

### Phase 2：路由、Shell 与设计系统（已完成）

#### 修改范围

1. 实现类型化 History router、链接和重定向；
2. 建立 `AppShell`、全局导航、用户菜单和项目上下文栏；
3. 落实最终颜色、字体、空间、角度、切角、焦点和 reduced-motion token；
4. 建立 `PageHeading`、`StatusLabel`、`AsyncRegion`、按钮、表格、表单和确认框；
5. 先用最小真实页面壳验证深链接、刷新、404 和未认证重定向；
6. 保留后端 SPA fallback。

#### 退出条件

- 所有稳定 URL 可直接打开和刷新；
- 当前全局/项目作用域始终可见；
- 浏览器前进、后退和旧 Hash 重定向正确；
- 键盘可进入全部顶层导航；
- 新 Shell 不显示旧营销眉题或蓝紫主题。

完成证明：多项目入口已切换至类型化 History router 和新 Shell；全部稳定路由由浏览器直接打开，旧项目 Hash 迁移、前进后退、刷新、404、未认证返回原目标和键盘顶层导航均由 `tests/e2e/v07-ui-navigation-smoke.ts` 覆盖。1440px 与 768px 浏览器证据确认单一主标题、显式项目作用域和无整页横向溢出；新 token、基础组件和 reduced-motion 规则已进入生产 CSS。Docker quality 环境全量 Vitest 为 465 项通过、2 项跳过，新的 E2E 导航 smoke、格式、lint、typecheck、build 和 `git diff --check` 通过。

### Phase 3：登录、工作台、项目列表与接入向导（已完成）

#### 修改范围

1. 重做登录页，保留统一安全错误和环境变量初始化提示；
2. 实现异常优先工作台：需要处理、当前执行、队列、项目状态、最近完成；
3. 实现项目列表排序、现有数据可支持的筛选和项目行菜单；
4. 把创建项目改为 `/projects/new` 四步可恢复向导：
   - 连接仓库；
   - 配置测试；
   - 配置环境；
   - 准备并启用；
5. 向导复用现有创建、配置、Secret、镜像、readiness 和 resume API；
6. 步骤恢复由真实缺失条件推导，不新增虚假 onboarding 状态；
7. 加入暂停、恢复、发起测试等普通确认框。

#### 退出条件

- 零项目状态按规格显示三个真实步骤；
- 第一步成功后退出再进入可继续；
- Secret 不回显；
- 全部检查通过后仍需用户明确启用；
- 工作台不显示统计图或模拟项目；
- 项目切换和迟到响应回归通过。

完成证明：登录、异常优先工作台、项目筛选/排序/暂停确认和四步接入向导已绑定真实 API；零项目页只展示连接仓库、配置非生产环境、检查并启用三个真实步骤。向导以项目详情和 readiness 快照恢复，Secret 只写不回显，检查通过后仍需单独点击启用。`tests/e2e/v07-ui-workflows-smoke.ts` 覆盖合成工作台、空状态、暂停确认、创建项目、配置、Secret、镜像、刷新恢复、显式启用、迟到响应丢弃以及 768px 无横向溢出；1440px/768px 浏览器截图确认工作台构图。Docker quality 环境全量 Vitest 为 465 项通过、2 项跳过，完整 `npm run test:e2e`、格式、lint、typecheck、build 和 `git diff --check` 通过。

### Phase 4：项目概览、运行准备与项目设置（已完成）

#### 修改范围

1. 实现项目概览和唯一推荐行动；
2. 将 readiness、同步和镜像准备集中到运行准备页；
3. 将项目配置拆分为基本资料、测试策略、测试环境、执行环境、自动化和凭据；
4. 每组独立保存，Secret 独立提交；
5. 保存后只显示“已保存”，不显示“已就绪”；
6. 有待处理请求或活动 Run 时显示具体锁定原因；
7. 未保存草稿阻止导航，写操作中禁止切换项目；
8. 暂停和恢复保留在项目上下文和项目列表，不藏入设置。

#### 退出条件

- 设置页不混入全局 Provider、浏览器或 OSS；
- 运行准备不编辑配置；
- 已保存、已配置、连通和就绪四种事实可区分；
- readiness 局部超时不遮挡项目其他信息；
- 项目 ID 不从显示名称推导。

完成证明：项目概览以真实项目、Run、Queue、索引、场景和 readiness 数据给出唯一推荐行动；运行准备页只执行显式检查、仓库同步和受确认保护的镜像准备，不提供配置编辑；项目设置拆为六个稳定 URL 分组，普通配置、项目资料和四类项目 Secret 分别提交，Secret 原值不回显。新增受认证和 origin guard 保护的项目显示名称更新接口，仓库稳定身份保持只读。待处理队列或活动 Run 会显示具体测试记录并锁定配置；未保存草稿拦截站内导航和浏览器离开，写入期间拒绝切换。`tests/e2e/v07-ui-workflows-smoke.ts` 覆盖唯一行动、运行准备无编辑控件、局部 readiness 超时、活动 Run 锁定、草稿确认、写入锁和 768px 无横向溢出；1440px、1024px、768px 浏览器截图确认三类页面构图。Docker quality 环境全量 Vitest 为 465 项通过、2 项跳过，导航与工作流 E2E、格式、lint、typecheck、build 和 `git diff --check` 通过。

### Phase 5：测试页和实时任务

#### 修改范围

1. 实现同一测试页的 idle、queued、running 和 completed 四种主要状态；
2. idle 复用 current-head 和 merge-source 两种请求；
3. queued 显示真实位置、前方任务、来源和等待原因，不增加取消或重排；
4. running 映射现有生命周期为八阶段，并显示当前角色、场景、进度、耗时、更新时间和脱敏活动；
5. completed 显示结论和测试记录入口；
6. 只在测试页运行 2 秒轮询，页面离开后停止；
7. 轮询失败保留最后可信进度并标记陈旧。

#### 退出条件

- 不显示虚假百分比；
- `0/0`、Agent 异常和最后活动正确；
- `Runner` 只作为角色名；
- 页面不显示思维链、Prompt、Secret 或未脱敏参数；
- 正常 Run 阶段显示名为 Main · 规划、Runner、Reviewer、Main · 最终汇总。

### Phase 6：测试记录、场景、报告和 Evidence

#### 修改范围

1. 实现测试记录列表和局部筛选；
2. 实现稳定 Run 详情页及摘要、场景结果、审核、正式报告、证据、技术信息六个 tab；
3. 显示 archive、progressed、scenario PR、Issues 和清理告警，不改写正式结论；
4. 正式报告提供安全渲染视图和 Markdown 原文；
5. Evidence 显示类型、大小、时间、SHA、完整性/字段检测状态和受控打开入口；
6. 实现场景列表、筛选和详情；
7. 场景详情安全渲染 Markdown，并聚合最近执行、报告和场景 PR；
8. 所有项目/Run/Scenario 详情严格校验 URL 归属。

#### 退出条件

- blocked、failed、interrupted 和 passed 在列表与详情一致；
- AI Reviewer 不显示为人工评分；
- `humanScoring: not_run` 不被改写；
- 清理失败独立显示，不改写功能结论；
- Evidence 缺失或读取失败不自动等同于场景失败；
- 场景和报告中的 HTML/脚本不能执行；
- 其他项目的 Run、场景和 Evidence 返回 404。

### Phase 7：系统状态、全局设置和账号

#### 修改范围

1. 实现系统状态只读诊断页；
2. 展示版本、数据库、Secret Store、调度器和共享依赖；
3. 展示只读 Docker 容器/镜像盘点，不提供删除；
4. 将全局设置拆为模型与角色、浏览器、对象存储、本地数据和全局凭据；
5. 延续三组 Agent 配置，Final Main 只说明复用 Main，不增加第四组；
6. 每个设置分组独立保存，连接检查独立执行；
7. 对可能破坏历史证据地址的 OSS 修改执行现有后端 guard，并显示原因；
8. 账号设置进入用户菜单，包含显示名称和改密后退出。

#### 退出条件

- 系统状态无编辑控件；
- 全局设置持续显示“影响全部项目”；
- 项目 Secret 不出现在全局凭据；
- 保存配置不等于检查通过；
- 资源盘点只读且归属失败 fail closed；
- 不显示虚假启动时间或恢复演练记录。

### Phase 8：状态完善、可访问性与全量回归

#### 修改范围

1. 补齐全部页面的加载、空、错误、陈旧、锁定和危险操作状态；
2. 检查 1440px、1024px、768px 和 200% 缩放；
3. 检查长中文、长仓库名、Run ID、commit、digest 和错误文本；
4. 完成键盘、焦点、弹框焦点锁定/归还、表格语义和表单错误关联；
5. 验证 `prefers-reduced-motion`；
6. 删除多项目旧页面和无引用样式，不删除仍受支持的旧单项目代码路径；
7. 更新 E2E、README 截图或使用说明中已过时的导航名称；
8. 运行全部质量和验收命令。

#### 退出条件

- 无整页横向溢出；
- 变形文字和焦点框不被切角裁掉；
- 主要流程只用键盘可完成；
- 200% 缩放不丢失内容和操作；
- reduced motion 下无非必要位移动画；
- 新 UI E2E、现有单元测试和 release 相关 local 验收通过；
- 未运行的 live 验收明确记录为未运行，不冒充通过。

## 8. 验收矩阵

| 验证 ID | 对应规格/设计 | 自动证明 | 浏览器证明 |
| --- | --- | --- | --- |
| `UI-ROUTE-01` | Spec §25 | 路由解析单测、SPA fallback | 深链接刷新、前进后退 |
| `UI-SCOPE-01` | Spec §3.4、§5 | 项目 API 隔离测试 | 全局/项目作用域持续可见 |
| `UI-WORKSPACE-01` | Spec §7 | 工作台聚合 service 测试 | 异常、执行、队列、项目、最近完成 |
| `UI-PROJECTS-01` | Spec §8–9 | 创建/配置/Secret/readiness API 回归 | 四步接入、退出恢复、明确启用 |
| `UI-SYSTEM-01` | Spec §10 | 系统状态和资源盘点 route 测试 | 局部失败、只读资源、无删除 |
| `UI-GLOBAL-SETTINGS-01` | Spec §11 | deployment guard 测试 | 分组保存、检查独立、作用域文案 |
| `UI-ACCOUNT-01` | Spec §12 | auth/account 回归 | 改密退出、用户菜单 |
| `UI-OVERVIEW-01` | Spec §13 | 项目摘要测试 | 唯一推荐行动 |
| `UI-TEST-01` | Spec §14 | current/queue route 测试 | idle/queued/running/completed |
| `UI-RUN-01` | Spec §15 | Run 归属、archive、Evidence 测试 | 六个 tab、稳定 URL、结论语义 |
| `UI-SCENARIO-01` | Spec §16 | 场景归属和安全内容测试 | 列表、筛选、Markdown、历史 |
| `UI-READINESS-01` | Spec §17、#94 | timeout、readiness、镜像测试 | 检查、同步、镜像和四层状态 |
| `UI-PROJECT-SETTINGS-01` | Spec §18 | config/Secret lock 测试 | 分组保存、未保存确认 |
| `UI-STATE-01` | Spec §20–21 | 局部失败/陈旧响应测试 | 加载、空、错误、陈旧、锁定、确认 |
| `UI-DESIGN-01` | Design §4–9 | token lint/组件测试 | 1440/1024/768 视觉检查 |
| `UI-A11Y-01` | Spec §23–24、Design §12–13 | DOM 语义检查 | 键盘、焦点、200%、reduced motion |
| `UI-SECURITY-01` | Spec §2、§15–18 | Secret/XSS/项目隔离测试 | 页面与网络响应 Secret 扫描 |

## 9. 测试文件计划

新增或重构：

```text
tests/
├── multi-project-console-routes.test.ts
├── multi-project-system-status.test.ts
├── git-remote-timeout.test.ts
├── web-route.test.ts
└── e2e/
    ├── v07-ui-navigation-smoke.ts
    ├── v07-ui-workflows-smoke.ts
    └── v07-ui-accessibility-smoke.ts
```

调整：

- `tests/e2e/multi-project-ui-smoke.ts`：保留项目隔离、迟到响应和接入事实，迁移到新 URL 和页面；
- `tests/e2e/phase8-ui-smoke.ts`：继续证明旧路径时不得计入新多项目 UI AC；若旧路径后续正式退役，再由独立决定删除；
- `tests/multi-project-app.test.ts`：增加新聚合 route 和跨项目负例；
- 必要的 shared type、resource inventory、readiness 和 Git repository 单测。

浏览器 fixture 至少包含：

- 零项目；
- active、paused、未就绪三个项目；
- 当前执行和跨项目队列；
- passed、failed、blocked、interrupted；
- 归档失败、清理告警、场景 PR；
- 陈旧索引和局部 API 失败；
- Evidence 可用、缺失、读取失败和截图检测标签；
- 长中文、长仓库名和长技术标识；
- 可检测但不可执行的恶意 Markdown/HTML。

## 10. 公共验证命令

每个代码阶段运行与修改范围匹配的专项测试；最终至少运行：

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:acceptance:local
git diff --check
```

同时执行：

- production/quality Docker build；
- 1440px、1024px、768px 浏览器截图；
- 1536px 视口下 200% 缩放或等效 768 CSS px 验证；
- 键盘 Tab/Shift+Tab/Enter/Escape 流程；
- `prefers-reduced-motion`；
- DOM 与网络响应 Secret canary 扫描；
- 所有新稳定 URL 的直接刷新。

`test:acceptance:live` 和 `test:acceptance:release` 不因纯 UI 实现自动宣称通过。需要真实外部资源时按既有验收规则单独执行并如实记录。

## 11. 风险与控制

### 11.1 一次性页面重写导致行为回归

控制：按读模型、Shell、全局页、项目页、记录页分阶段迁移；每阶段保留可运行入口和专项 E2E。

### 11.2 动态构图造成文字或焦点裁切

控制：正常流布局优先；对长文本做边界断言；截图检查所有断点；禁止用固定高度和隐藏溢出掩盖问题。

### 11.3 工作台触发跨项目外部请求风暴

控制：服务端只聚合本地持久事实；外部 connectivity/readiness 由明确操作触发；轮询读取缓存和状态。

### 11.4 稳定 URL 暴露跨项目数据

控制：每个项目资源继续由服务端 `projectId` 作用域查询；详情 ID 不全局查询后再由前端过滤；增加 A/B 交叉负例。

### 11.5 轮询覆盖用户操作或旧项目状态

控制：路由级 AbortController、资源 key、最后可信缓存和写操作锁；自动刷新不重置表单、焦点和滚动位置。

### 11.6 Markdown 和外部链接引入 XSS

控制：禁用 raw HTML；受控链接 renderer；保留脚本字符串但不执行；Evidence 继续通过认证 API 读取。

### 11.7 Git timeout 误伤正常 clone/fetch

控制：readiness 远程检查和正式 Git 操作使用不同上限；测试超时分类、子进程终止和 askpass 清理。

### 11.8 旧单项目 UI 与新 CSS 冲突

控制：新设计样式使用应用根作用域和独立文件；不在迁移中用全局选择器无差别覆盖旧路径；是否退役旧路径另行决定。

## 12. 明确不做

本计划不实现：

- #93 Git HTTPS 受控代理；
- #95 模型质量对照重跑；
- 多用户、权限或租户；
- 并行 Run；
- 取消或重排测试；
- 在线编辑/删除场景；
- 人工测试套件；
- 全局搜索、通知中心、独立报告中心或证据中心；
- 项目级模型、浏览器或 OSS 覆盖；
- 移动端；
- 暗色主题或主题切换；
- 一键删除 Docker 资源；
- 新的测试状态或 Run 状态机。

## 13. 完成定义

只有以下条件同时满足，v0.7.0 UI 重构实现才算完成：

1. Phase 0–8 全部达到退出条件；
2. Spec 页面地图全部有生产页面和稳定 URL；
3. Design 视觉、响应式和可访问性验收通过；
4. #94 有确定性 timeout 证明；
5. 项目隔离、Secret、XSS、认证和 origin guard 回归通过；
6. 全部公共质量命令和 local acceptance 通过；
7. 未执行的 live 项明确记录为未运行或 blocked；
8. PR 面向 `develop`，不直接提交受保护分支；
9. 不包含原型样例数据、第三方受保护视觉资产或本版非目标。
