# 罗网（LuoWang）场景测试 Harness MVP 分阶段实现计划

- 状态：Implementation Plan v0.1
- 关联 Intent：[intent.md](./intent.md)
- 关联 Spec：[spec.md](./spec.md)
- 正式仓库：公开的 `cynos-ai/luowang`
- 许可证：`PolyForm-Noncommercial-1.0.0`
- 实施方式：阶段顺序执行；每一阶段独立分支、独立 PR、独立验证、独立闭环

## 1. 计划目标

本计划把 MVP 拆成可以由不同 AI 依次完成的实施阶段。每个阶段必须同时具备：

1. 明确输入和责任边界；
2. 一个真实可观察的输出，不用 TODO、占位接口或生产 mock 冒充完成；
3. 自动化测试和至少一个阶段级 smoke/integration proof；
4. 失败、空状态和恢复路径；
5. 可独立审查的 PR 和回退点；
6. 对应 Spec 验收 ID 的可追溯证据。

“阶段闭环”不表示每个阶段都已经交付完整 MVP，而是该阶段负责的子系统从输入到输出完整可用，并且后续阶段不需要回头替它补核心逻辑。

## 2. 实现 Agent 执行契约

每个阶段的实现 Agent 必须按以下顺序工作：

1. 阅读 `AGENTS.md`、`docs/PROJECT.md`、本目录的 `intent.md`、`spec.md` 和本计划；
2. 确认前序阶段的退出条件已经满足，不以未合并分支或本地未提交文件作为依赖；
3. 从最新 `develop` 创建本阶段指定的 `feat/*` 分支；若只是修复已交付行为，创建 `fix/*`；
4. 先检查已有 owner、类型、测试和配置，再扩展负责该职责的边界；
5. 完成本阶段全部生产逻辑、迁移、UI、错误处理、测试和必要文档，不把核心工作留给下一阶段；
6. 运行“全阶段公共校验”和本阶段专项校验；
7. 在 PR 描述中记录：实现范围、用户可观察结果、验证命令及结果、对应 AC、未解决风险和明确未做内容；
8. PR 合入 `develop` 后删除短期分支；未满足退出条件时不进入下一阶段。

测试可以在外部边界使用 test double、临时 Git 仓库、临时 HTTP 服务或临时 S3-compatible 服务，但生产路径不得包含只为测试存在的假实现。涉及真实 Provider、GitHub、OSS 和浏览器的阶段还必须执行明确列出的真实 smoke test。

## 3. 分支、发布和自身吃狗粮策略

### 3.1 分支流向

```text
feat/* ─┐
fix/*  ─┴─> develop ──PR──> main ──> SemVer tag

正式版本紧急修复：
main ──> fix/* ──PR──> main ──> patch tag
                 └────同步────> develop
```

- `main`：正式发布分支和 GitHub 默认分支；
- `develop`：下一版本开发集成分支；
- `feat/<short-kebab-name>`：功能或一个计划阶段，从 `develop` 创建并合回 `develop`；
- `fix/<short-kebab-name>`：普通缺陷从 `develop` 创建；正式版本紧急缺陷从 `main` 创建；
- `chore/<short-kebab-name>`：只在独立仓库维护无法归入功能或修复时使用；
- 不创建 `release/*` 或 `hotfix/*`。正常发布直接走 `develop → main` PR，紧急修复仍统一叫 `fix/*`。

`main`、`develop` 都要求 PR、通过必需 checks、解决讨论，并禁止删除和 force-push。单人维护阶段不要求另一位人工批准；出现第二位维护者后再启用至少一人审核。短期分支合并后删除。

这是一套 Gitflow-lite：保留用户指定的 `main + develop`，吸收 GitHub Flow 的短生命周期分支和 PR，不采用完整 Gitflow 的 release/hotfix 长期流程。

### 3.2 与 `scenario-testing` 的关系

`scenario-testing` 是罗网管理测试事实的分支，不属于上述人工开发流：

1. 功能和修复先通过 PR 进入 `develop`；
2. 罗网自身吃狗粮时，把一个 `develop` 候选批次按目标项目规则合入 `scenario-testing`；
3. 罗网在 `scenario-testing` 上维护场景和报告；
4. 人类依据最新相关 Run 决定是否发起 `develop → main` 发布 PR；
5. MVP 不自动把测试结果变成发布 gate，也不把 `scenario-testing` 合回 `main`。

### 3.3 许可证判断

选择 PolyForm Noncommercial 1.0.0，因为它明确只许可非商业目的及列出的个人、教育、公益、政府等用途，符合“公开但不默认授权商业使用”的要求。它限制商业使用，因此不符合 OSI Open Source Definition，项目对外统一称为“公开源码”或 source-available。

参考依据：

- [PolyForm Noncommercial 1.0.0 官方文本](https://polyformproject.org/licenses/noncommercial/1.0.0)；
- [OSI Open Source Definition](https://opensource.org/osd) 第 1、6 条；
- [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)；
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)；
- [Atlassian Gitflow 说明](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow)：完整 Gitflow 已偏重且不适合现代持续交付，因此本项目不照搬 release/hotfix 分支。

## 4. 全阶段公共工程约束

### 4.1 固定技术与运行边界

- Node.js 24、TypeScript ESM、npm lockfile；
- Fastify 5 + React 19/Vite；
- SQLite + Drizzle + `better-sqlite3`；
- Vitest；
- 单应用仓库、单应用容器，不拆微服务；
- API、后台任务和网站共享同一业务 owner，不为相同规则建立重复实现；
- 数据库变更只能通过可重复执行的版本化 migration；
- 外部副作用封装在 GitHub、Git、Provider/Pi、MCP、OSS 等明确 adapter 边界；
- 时间、随机数、ULID、文件系统和外部 adapter 必须可在测试中受控；
- 日志采用结构化输出并统一脱敏，不记录 Secret、Cookie、测试密码、模型隐藏推理或未经处理的工具参数。

### 4.2 Phase 0 必须建立的标准命令

后续每一阶段都必须保持以下命令可用：

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

- `npm test`：单元和组件级集成测试，不依赖公网；
- `npm run test:e2e`：启动真实应用及临时外部依赖，验证阶段级用户流程；
- 需要真实外部凭据的 smoke test 使用单独命令和显式环境变量，不混入默认 `npm test`；
- 任何阶段都不得通过跳过失败测试、降低类型检查或删除安全断言来过关。

### 4.3 每阶段退出时的公共证明

除专项证明外，每阶段至少保存以下 PR 证据：

- 上述标准命令全部通过；
- 生产 Docker 镜像构建通过；
- 新增 migration 能从空库执行，已有库能前向升级；
- 关键失败路径有自动化覆盖；
- `git diff` 和日志样本中没有凭据；
- 没有未完成核心逻辑、调试代码或依赖下一阶段才能工作的生产分支。

### 4.4 外部前置条件和受阻规则

外部真实 smoke 是阶段退出条件，不用生产 mock 替代。所需条件如下：

| 阶段 | 操作者必须提供的非生产资源 |
|---|---|
| Phase 0 | `cynos-ai/luowang` 组织管理员权限；当前已满足 |
| Phase 1 | `LUOWANG_ADMIN_PASSWORD`、`LUOWANG_MASTER_KEY` 和可访问的测试 URL |
| Phase 2 | 对目标测试仓库具备读取、分支写入和 ref 合并权限的 GitHub Token |
| Phase 3 | 可用模型 Provider 凭据，以及支持所选 thinking level 的 Main/Runner/Reviewer 模型 |
| Phase 4 | 非生产 Web 测试环境、Playwright MCP 运行依赖、测试账号和专用 OSS bucket/prefix |
| Phase 5 | GitHub 报告分支写入、PR 和 Issue 权限；带明确测试标记且可清理的 smoke 目标 |
| Phase 6–8 | 前述资源保持可用；允许短时间重启测试实例 |
| Phase 9 | 完整 dogfood 预发布环境、私有 OSS、真实模型和 `cynos-ai/luowang` 写权限 |

凭据只由操作者通过环境变量或网站 Secret Store 提供，不写入文档、fixture、PR 或 CI 日志。若资源/权限不可用：

1. 仍运行不依赖公网的自动化测试并记录结果；
2. 将阶段状态明确报告为 **blocked**，列出缺少的资源和最小权限；
3. 不把 test double 结果当作真实 smoke，也不合并为“阶段完成”；
4. 资源恢复后从真实 smoke 继续，不要求重做仍与当前 commit 匹配的本地证明。

## 5. 阶段总览

| 阶段 | 建议分支 | 独立闭环结果 | 主要验收 |
|---|---|---|---|
| Phase 0 | `feat/p0-foundation` | 公共仓库中的应用骨架可测试、可构建、可用 Docker 启动 | `AC-QUALITY-01` 基线、`AC-DEPLOY-01` 部分 |
| Phase 1 | `feat/p1-secure-console` | 管理员可安全登录、持久化配置、保存但不能取回 Secret；后续 adapter 可注册独立检查 | `AC-DEPLOY-01`、`AC-CONFIG-01`、`AC-SECRET-01` 部分 |
| Phase 2 | `feat/p2-repository-control` | 可连接唯一 GitHub 仓库、准备场景测试分支、同步并查看场景/报告事实 | `AC-GIT-01`、`AC-GIT-03`、`AC-INDEX-01`、`AC-CONNECT-01` 的 GitHub 部分 |
| Phase 3 | `feat/p3-agent-run` | 人工请求可完成 Main → Runner → Reviewer → Main 的本地完整 Run | `AC-RUN-01`、`AC-AGENT-01`、`AC-ZERO-01`、`AC-CONNECT-01` 的 Provider 部分 |
| Phase 4 | `feat/p4-browser-evidence` | UI 场景可真实执行、上传稳定证据、独立看图审核并清理数据 | `AC-BROWSER-01`、`AC-DATA-01`，并闭环 `AC-CONNECT-01` |
| Phase 5 | `feat/p5-archive-progress` | completed Run 可幂等归档、发布报告、处理多个 Issue 并正确推进 | `AC-PROGRESS-01/02`、`AC-ISSUE-01`、`AC-HISTORY-01`、`AC-ARCHIVE-01`、`AC-REPORT-01` |
| Phase 6 | `feat/p6-automation-recovery` | Git/Cron/API/人工请求进入同一持久队列，自动合批并可从重启恢复 | `AC-GIT-02`、`AC-TRIGGER-01/02`、`AC-QUEUE-01`、`AC-RECOVERY-01` |
| Phase 7 | `feat/p7-scenario-lifecycle` | 三种场景模式和陌生项目初始化可在真实 Run/PR/归档流程中闭环 | `AC-SCENARIO-01..05`、`AC-INIT-01` |
| Phase 8 | `feat/p8-operations-ui` | 控制台完整呈现 Git、场景、Run、当前执行和后台任务事实 | `AC-GIT-VIEW-01`、`AC-SCENARIO-VIEW-01`、`AC-RUN-VIEW-01`、`AC-ACTIVE-VIEW-01` |
| Phase 9 | `feat/p9-dogfood-release` | 罗网用自身完成首次可信基线和真实回归，MVP 全量验收后发布 | 全部 AC |

阶段必须按顺序合入。可以在同一阶段内部拆多个原子 commit，但不要并行开发相邻阶段后再一起解决集成问题。

## 6. Phase 0：公共仓库与可执行基础

### 目标和闭环

建立最小但真实可运行的产品壳：源码、网站、API、SQLite、测试、CI 和 Docker 形成同一个构建闭环。完成后，任何人克隆公开仓库都能用固定命令启动应用，看到控制台壳并获得健康状态。

### 实施范围

1. 初始化 npm/TypeScript ESM 工程并提交 lockfile，声明 Node 24 和 `license: PolyForm-Noncommercial-1.0.0`；
2. 建立 Fastify 应用入口、React/Vite 控制台入口和共享类型边界；
3. Fastify 生产模式提供构建后的静态网站和 `/health`；
4. 建立 SQLite 连接、migration runner 和最小系统元数据表，数据位置可配置并默认落到 `/data`；
5. 建立统一配置加载、结构化日志、错误响应和进程优雅退出；
6. 建立 Vitest、格式化、lint、typecheck、build、e2e 脚本；
7. 建立多阶段 Dockerfile、非 root 运行用户、Compose、健康检查和持久化目录；
8. 建立 GitHub Actions，对指向 `develop` 和 `main` 的 PR 执行公共校验和 Docker build；
9. 提供面向公开仓库的最小根 README：项目状态、非商用许可证说明、本地启动和安全警告，不建立重复文档索引；
10. 创建 `develop`，并为 `main`、`develop` 配置禁止 force-push/删除、要求 PR 和必需 checks 的 ruleset。

### 专项验证

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
docker compose up -d --build
curl --fail http://127.0.0.1:<port>/health
docker compose down
```

另外验证：

- 删除本地构建产物后仍能从 lockfile 重建；
- 容器进程不是 root；
- 重启容器后 SQLite 系统元数据仍存在；
- GitHub PR 上 required checks 实际运行；
- GitHub 仓库为 Public，默认分支为 `main`，根目录许可证文本与官方 PolyForm 1.0.0 一致。

### 退出条件

- 公共仓库、分支和规则真实存在；
- 本地与 CI 使用同一组质量命令并通过；
- Docker smoke 通过，无需登录即可访问的只有健康检查和后续明确的公开静态资源；
- 没有业务占位 API、假登录或假 Run。

## 7. Phase 1：安全登录、配置与 Secret 闭环

### 目标和闭环

管理员能够初始化密码、登录控制台、查看和修改 Harness/Repository 两组配置、保存 Secret、看到掩码状态，并对本阶段已经拥有的测试环境 URL 执行连通性检查；后续 adapter 可注册自己的检查。退出或 Token 到期后不能继续访问。

### 实施范围

1. 建立版本化 schema：普通配置、加密 Secret、管理员密码哈希、登录 Token 哈希和过期时间；
2. 使用 Argon2id 验证管理员密码；主密钥只从 `LUOWANG_MASTER_KEY` 读取，Secret 使用认证加密并通过统一 `set/get/delete/has` 边界访问；
3. 实现两小时 opaque Token、SQLite 只存哈希、HttpOnly Cookie、logout、改密撤销、登录限流、写请求 Origin 校验；
4. API 对 Secret 只返回 `configured`/掩码，空值不意外覆盖已有 Secret，显式删除需单独操作；
5. 实现 Harness 配置：语言、Provider、三个角色模型/thinking、本地目录/保留、MCP、OSS、管理员认证；
6. 实现 Repository & Test Environment 配置：仓库、场景分支、Git Token、场景模式、标签、Poll/Cron、环境说明、URL、账号和 Secret；
7. 建立统一 connectivity check 注册/执行/展示边界，并在本阶段只实现测试环境基础 URL 检查；GitHub、Provider/模型、Playwright MCP、OSS 的正式检查分别由 Phase 2、3、4 中拥有对应 adapter 的阶段注册；
8. 未注册的检查在网站明确显示“对应能力尚未提供”，不能返回假成功；
9. 网站提供初始化/登录页、两组配置页、Secret 覆盖/删除确认、检查结果和明确错误状态；
10. 日志、错误和审计活动统一脱敏。

### 专项验证

- 从空卷首次启动、初始化密码、登录、保存普通配置和 Secret，重启后普通配置及 `has(secret)` 保持；
- API、HTML、日志、SQLite 可读列和错误栈中均不能找到原始 Secret；
- 旧 Cookie 在 logout、改密和两小时过期后返回 `401`；
- 错误 Origin 的写请求被拒绝，登录限流生效；
- connectivity check 框架覆盖已注册、未注册、成功、超时和配置缺失；测试环境 URL 检查另覆盖可达和拒绝连接；
- 真实 smoke：使用操作者提供的非生产 URL 完成一次真实检查，不把 URL 中的敏感参数写入日志或 PR。

### 退出条件

`AC-DEPLOY-01`、`AC-CONFIG-01` 和 `AC-SECRET-01` 的本阶段范围通过；connectivity check 扩展点和测试环境 URL 检查可用。`AC-CONNECT-01` 要到 Phase 4 的全部正式 adapter 检查通过后才算完整。任何上层模块都不能绕过 Secret Store 直接读写加密列。

## 8. Phase 2：唯一仓库控制与 Git 事实索引

### 目标和闭环

管理员配置唯一 GitHub 仓库后，罗网可以安全同步工作树、创建或验证场景测试分支、接收人工指定来源并把 Git 中已有场景/报告索引到 SQLite 和网站。

### 实施范围

1. 实现仅面向 GitHub 的 Repository Service：clone/fetch、凭据注入、ref 解析、祖先检查、固定 SHA checkout 和工作树清理；
2. 注册 GitHub/场景测试分支 connectivity check，分别验证读取、非 force 分支写入、PR 和 Issue 所需权限；每项返回可验证依据，无法通过非破坏方式确认的权限标为 `unknown` 而不是假报通过；
3. 场景测试分支不存在时，从用户确认的初始 branch/tag/SHA 创建；存在时只允许向前同步，检测历史断裂并停止；
4. 人工指定其他 ref 时，操作者确认后在最新远端 HEAD 上执行 `merge --no-ff`，记录来源和原 HEAD，使用 non-force push 发布；远端竞争、冲突或失败时清理本地状态并停止，重试通过祖先检查避免重复 merge；
5. 实现场景 Markdown frontmatter 和最终 `report.md` frontmatter 校验；其余 Run Markdown 作为不透明正文索引，无效机器字段记录索引错误且不能污染有效缓存；
6. Repository Indexer 原子同步场景、报告、文件路径、内容、commit、最近同步 SHA/时间，并删除 Git 已不存在的缓存；
7. 建立只读历史上下文查询，统一暴露已索引正式报告和 GitHub Issues；结果必须区分“查询成功但无历史”和“GitHub/索引暂时不可用”，首次运行只在查询成功时返回明确空集合；
8. 提供仓库状态、同步动作、最小 Git 树、场景列表/详情和报告读取页面；
9. Git Token 只在 Repository Service 内使用，不传给命令环境、Agent 或日志。

### 专项验证

- 使用临时 bare Git 仓库覆盖：首次建分支、正常 fetch、前进、历史重写、source 已是祖先、成功 merge+push、远端竞争、重复请求和冲突停止；
- 使用合法/非法/重复场景 ID、最终报告缺字段、其他 Markdown 任意标题和 Git 删除文件验证索引事务；
- 历史上下文查询覆盖空仓库、已有正式报告、open/closed Issue 和 GitHub 暂时不可达；
- 同步中断时网站仍显示上一次完整缓存及其 commit/time，不展示半次同步；
- 真实 smoke：读取 `cynos-ai/luowang`，验证最小权限；在明确确认后创建或验证其 `scenario-testing` 分支，不写场景或报告。

### 退出条件

`AC-GIT-01`、`AC-GIT-03`、`AC-INDEX-01` 和 `AC-CONNECT-01` 的 GitHub 部分通过；目标仓库工作树在每次成功或失败操作后都回到可预测状态。

## 9. Phase 3：人工请求的 Agent Run 本地闭环

### 目标和闭环

一个人工请求能固定目标 SHA，依次运行隔离的 Main A、Runner、Reviewer、Main B，并在本地完成可信的 `passed | failed | blocked` 结论和五个 Markdown 工件；本阶段先用 API/CLI 样例项目完成，不依赖浏览器和远程归档。

### 实施范围

1. 固定并审核 Pi SDK 相关版本，建立 Provider/模型能力和 thinking level 校验，并向 Phase 1 的 connectivity check 边界注册 Provider 认证及三个角色模型检查；
2. 建立 Run Orchestrator、ULID、UTC 时间、不可变 commit 范围和唯一 active run；
3. 建立 `<data>/report/running/<run-id>`，通过受控 writer 管理本阶段正常 Run 的 `plan.md`、`execution.md`、`draft-report.md`、`review.md` 和 `report.md`；`scenario-changes.patch` 到 Phase 7 再加入 writer 允许范围；
4. Main A 通过 Phase 2 的只读历史上下文查询读取已索引正式报告、GitHub Issues 和场景；首次 Run 接收明确空历史。Phase 5 再在同一查询边界补充 SQLite 详细 Run，不改变 Main 工具契约；
5. Runner 只获得固定 target 工作树、受控命令、允许的环境信息和本地工件写入能力，顺序执行并写执行记录与草稿报告；
6. Reviewer 使用新 session，只读计划、执行、报告和证据，写独立审核；
7. Main B 使用新 session 汇总最终报告；只严格校验最终 `report.md` frontmatter、聚合优先级和 Issue 建议，其他四个 Markdown 仅检查存在、非空和角色流程完成；
8. 每个 session 完成或失败后都 dispose；不共享完整对话，只通过文件交接；
9. `finalizeRun` 校验完整性并原子移动到 completed；Agent/进程异常留下明确失败，不伪造报告；
10. 启动被测命令使用显式环境 allowlist，不继承 Harness 高权限 Secret；
11. 支持 Main 与 Reviewer 一致确认后的零场景 passed；场景缺失或影响不明必须 blocked；
12. Phase 7 之前长期场景是只读资产：Main 可以报告覆盖缺口并 blocked，但不产生 `scenario-changes.patch`。场景 patch、策略和 PR 全部由 Phase 7 一次性实现。

### 专项验证

- 准备一个固定 SHA 的最小 API/CLI 样例仓库，真实执行一次 passed Run 并验证五文件内容；
- 制造一个确定产品错误，真实执行一次 failed Run，Reviewer 必须以证据确认；
- 制造凭据/命令不可用，执行一次 blocked Run；
- 提供纯文档变化，验证零场景 passed；再提供影响不明变化，验证不能借零场景通过；
- 运行过程中向目标分支推送新 commit，确认当前 target 不变化；
- 检查 Runner 子进程环境不包含 Git Token、模型 Key、OSS Secret、管理员密码和 master key；
- 真实 Provider connectivity check 能区分认证失败、模型不存在和不支持的 thinking level。

### 退出条件

`AC-RUN-01`、`AC-AGENT-01`、`AC-ZERO-01` 和 `AC-CONNECT-01` 的 Provider/模型部分通过；本地 completed Run 足以由后续独立 Archiver 归档，不依赖进程内隐藏状态。

## 10. Phase 4：浏览器、OSS 证据与测试数据闭环

### 目标和闭环

Runner 能在非生产 Web 测试环境完成 UI 场景、保存并上传证据，Reviewer 能独立查看截图，临时数据能清理；证据或清理失败会可靠地使 Run blocked。

### 实施范围

1. 接入固定版本 `pi-mcp-adapter` 与 `@playwright/mcp`，使用 headless、isolated 和当前 Run evidence 目录，并注册 MCP 进程启动/工具发现 connectivity check；
2. 默认使用 accessibility snapshot/ref 操作，禁用 unsafe 任意代码工具；
3. Runner 模型视觉能力与计划需求不匹配时提前 blocked，不伪造视觉结论；
4. 实现 S3-compatible OSS Adapter：上传、读取/探测、删除测试对象、稳定 object key 和长期地址，并注册使用独立测试对象的 OSS connectivity check；
5. 私有 bucket 未配置 public base URL 时由 Gateway 登录鉴权后临时签名或代理，Git 工件只保存稳定地址；
6. Reviewer 可以通过受控只读方式获取截图证据，不获得测试密码或任意命令；
7. 测试数据以 run-id 标记，场景结束清理，Run 结束兜底清理；外部副作用只允许配置白名单目标；
8. evidence 上传成功后按保留策略清理临时文件；失败时保留本地文件并 blocked。

### 专项验证

- 启动一个真实 UI fixture，执行登录、状态恢复、失败提示和持久化场景；
- 通过临时 S3-compatible 服务执行真实 put/get/delete；再用配置的真实 OSS 做一个最小对象 smoke；
- Reviewer 实际读取截图并对一个视觉事实给出审核；
- 分别注入上传失败、过期/不可访问证据、无视觉模型和清理失败，整体结果均为 blocked；
- 扫描 Git 报告，确认没有短期签名 URL、密码或本地绝对证据路径。

### 退出条件

`AC-BROWSER-01`、`AC-DATA-01` 通过；GitHub、测试环境、Provider/模型、MCP 和 OSS 的正式独立检查全部可用，`AC-CONNECT-01` 首次完整通过；UI Run 与 Phase 3 相同地完成五文件闭环，且证据在 Run 结束后仍可按权限访问。

## 11. Phase 5：归档、Issue 与推进闭环

### 目标和闭环

completed Run 可由独立 Archiver 重复扫描而不产生重复副作用；正式报告进入 Git，多个确认 Bug 分别创建/关联 Issue，并且只有满足 Spec 条件时才推进 last completed target。

### 实施范围

1. 建立 Run Store 和归档状态，批量导入 Run 文件、commit 范围、结果、场景结果、PR/Issue/报告关系；
2. Archiver 以 run-id 幂等执行：导入、发布正常测试报告、Issue、推进和本地保留；本阶段只处理没有 `scenario-changes.patch` 的正常 Run；
3. 正式测试报告发布到 `docs/scenario-testing/reports/<run-id>/`，三文件同一次提交；
4. blocked 且只产生待审核场景变更的说明只进 SQLite，不发布为正式 Git 报告；
5. 按 `luowang-run:<run-id>` 和 `luowang-bug:<bug-key>` 查询后再创建 Issue；link 必须验证目标 Issue；
6. 同一 Run 支持多个 create/link，单项失败保留其余已成功事实并安全重试；
7. 在同一 SQLite 事务中执行推进判断和 last target 更新；
8. passed、failed、blocked、interrupted、报告冲突、Issue 部分失败分别遵循 Spec 推进矩阵；
9. 发布前 fetch，冲突时不 force-push，保留 completed 目录和可见错误；
10. 成功发布后触发 Repository Indexer，保留旧 Run/Issue 历史不变；
11. 通过 Phase 2 已建立的历史上下文查询暴露 SQLite 详细 Run；场景 patch 的解析、策略、提交、PR 和幂等发布均不在本阶段实现，统一归 Phase 7。

### 专项验证

建立故障注入矩阵，至少覆盖：

- passed + 报告成功 → 推进；
- passed + 报告失败 → 不推进；
- failed + 两个 Bug 全部完成 Issue → 推进；
- failed + 一个 Issue 失败 → 不推进，重试只补失败项；
- blocked + 已确认 Bug → 创建/关联 Issue但永不推进；
- 同一 completed 目录扫描三次 → 只有一份报告 commit、每个 bug 一个 Issue、一次推进；
- Git 发布冲突 → 不 force-push，修复冲突条件后可重试；
- 旧 Run 被新 Run 关联使用但内容和关系不被回写。

本阶段自动测试使用临时 Git remote 和可记录请求的 GitHub API test double；另外对真实 GitHub 执行最小权限读写 smoke，测试对象必须带明显测试标记并在完成后清理/关闭。

### 退出条件

`AC-PROGRESS-01`、`AC-PROGRESS-02`、`AC-ISSUE-01`、`AC-HISTORY-01`、`AC-ARCHIVE-01`、`AC-REPORT-01` 全部通过。

## 12. Phase 6：自动触发、持久队列与恢复闭环

### 目标和闭环

Git Poll、Cron、网站人工请求和 API 请求统一进入 SQLite FIFO 队列；系统保持单 active run，正确合并自动请求、保留人工请求，并在重启或归档延迟后恢复到可信状态。

### 实施范围

1. 所有入口只调用同一个 `submitTestRequest` 责任边界；
2. 持久化 FIFO 队列、触发来源、请求文本、目标 ref 和创建时间；
3. Git Poller 只监控场景测试分支，使用 debounce 固定一个最新可测试 target；
4. Cron 有新 commit 时创建批次，无新 commit 时 no-op；
5. 计算 `base_commit`、`target_commit`、`included_commits`，逐 commit 排除纯场景/报告资产变化；
6. 尚未开始的 Git/Cron 自动请求可以合并；manual/api merge 与重测请求不丢失；
7. 人工重测同一 target 生成新 Run ID，即使没有新 commit；
8. 当前 Run 完成后必须等待 Archiver 给出推进/未推进事实，再为下一项读取 base；
9. 启动扫描遗留 running 目录并标记 interrupted，网站允许重跑或清理，不恢复旧 Agent 对话；
10. 定时 Archiver、Indexer、保留清理任务使用防重入和可观测错误状态。

### 专项验证

- 使用 fake clock 验证 Poll 60 秒、Archiver 10 秒、Indexer 5 分钟和可配置 Cron，不做真实等待测试；
- 构造产品 commit、需求 commit、纯场景 commit、纯报告 commit 和混合 commit，验证触发与 included 范围；
- 同时提交多个自动请求和两个人工请求，验证自动合批、人工顺序保留和单 active；
- 在 queued、running、completed-waiting-archive 三个位置分别重启进程，验证恢复结果；
- 当前 Run 期间新增 commit，验证留给下一批；
- 上一 Run blocked/归档失败时，下一批仍从上一次已推进 target 计算。

### 退出条件

`AC-GIT-02`、`AC-TRIGGER-01`、`AC-TRIGGER-02`、`AC-QUEUE-01`、`AC-RECOVERY-01` 通过；任何触发入口都不能绕过队列和 commit 事实计算。

## 13. Phase 7：场景生命周期与陌生项目初始化闭环

### 目标和闭环

罗网可以在三种策略下建立和维护长期场景；需要审核时以 blocked + PR 结束而不等待，允许直接发布时能在同一 Run 验证场景；没有场景的项目能建立最小可信基线。

### 实施范围

1. 实现场景 schema、稳定 ID、三个状态和标签检索/加权，不增加 suite/catalog；
2. Main 只在工作树产生规范化 patch，不直接写远程 Git；
3. 分类 patch 中的新增、修改和 deprecated，严格执行 `autonomous`、`add-only`、`review-all`；
4. 无需审核时，Runner 执行变更后场景、Reviewer 审核，Archiver 直接提交；
5. 需要审核时，Run 按 Spec §8 的特殊文件契约只产生 `scenario-changes.patch + report.md` 并以 blocked 结束；其余四文件标记不适用，Archiver 创建指向场景测试分支的 PR并双向记录 run/target/理由/缺口；
6. 混合 patch 在 add-only 下整体进入 PR，不拆分；场景 PR 默认不创建 Issue；
7. PR 合并不改写旧 blocked Run，也不自动触发；提供人工重测和下一次产品变化自然使用两条路径；
8. 初始化实现 Preflight、静态勘察、低风险运行时侦察、临时能力图、候选综合、策略处理、候选验证、独立审核和最终修订；
9. 冲突证据保持 draft；approved 场景有明确依据，策略允许时至少真实执行一次；
10. 执行初始化停止条件和危险动作禁令，不物理删除场景。

### 专项验证

对一个没有 `docs/scenario-testing` 的样例仓库，分别运行：

- `autonomous`：候选场景真实执行并由 Archiver 直接提交；
- `add-only` 纯新增：直接提交；
- `add-only` 新增+修改混合：整体 PR、Run blocked；
- `review-all`：场景 patch 形成 PR、Run blocked、不挂起 session；两文件 Run 的 `report.md` 仍必须通过 §22.4 frontmatter 校验；
- PR 合并：旧 Run 仍 blocked，纯场景 commit 不自动测试；人工重测可以执行最新场景；
- 初始化资料冲突或环境不可用：只产生 draft/覆盖缺口，不伪造 approved；
- 最终 Git 中不存在 suite、catalog、journey 目录或长期能力图。

同时验证 blocked Run 中存在产品 Bug 时：Bug Issue 正常创建，场景 PR 不关闭或替代产品 Bug。

### 退出条件

`AC-SCENARIO-01` 至 `AC-SCENARIO-05`、`AC-INIT-01` 全部通过；陌生项目初始化和日常场景维护都复用同一 Run/归档主流程。

## 14. Phase 8：完整运维控制台闭环

### 目标和闭环

操作者不读取数据库或服务器文件，也能从网站理解“测试分支在哪里、正在做什么、发生了什么、为何没有推进、下一步能做什么”。

### 实施范围

1. Dashboard 完整呈现场景测试分支 HEAD、last completed target、未纳入 commit、active run、队列、后台任务和依赖健康；
2. Git 树只按 Run Store 标记 included/target/result/PR/Issues，同一 commit 可显示多次 Run；
3. 场景页提供状态/标签/关键词筛选、正文、Git commit、历史 Run 和待审 PR，只读 Git 缓存；
4. Runs 页展示范围、状态、正常 Run 的五文件、特殊场景审核 blocked Run 的实际文件/不适用标记、每场景结果、confirmed Bugs、OSS 证据、commit、PR/Issues 和归档重试；
5. 当前测试页展示阶段、角色、base/target、当前场景、进度、脱敏活动、文件和明确阻塞；
6. 配置页补齐所有字段、掩码、覆盖/删除和检查体验；
7. 采用普通 HTTP + 网站轮询，不提前增加 SSE/WebSocket；
8. 所有页面实现 loading、empty、error、stale cache、401 和恢复行为；
9. 可访问性和窄屏不阻断核心管理操作；前端不渲染不可信 Markdown HTML。

### 专项验证

- Playwright e2e 覆盖首次登录、配置、同步、提交 Run、查看当前进度、查看归档结果、失败重试和 logout；
- 使用固定数据覆盖 passed/failed/blocked/interrupted、零场景、多个 Issue、场景 PR、过期缓存和后台错误；
- 断开 GitHub/OSS/Provider 后，网站保留最后事实并清楚标记陈旧/失败，不显示空白成功；
- 检查 DOM、下载内容和网络响应，不出现 Secret、隐藏推理或未经脱敏工具参数；
- Markdown 注入脚本不能执行。

### 退出条件

`AC-GIT-VIEW-01`、`AC-SCENARIO-VIEW-01`、`AC-RUN-VIEW-01`、`AC-ACTIVE-VIEW-01` 通过，且 `AC-CONFIG-01` 完整回归通过。

## 15. Phase 9：自身吃狗粮、硬化与首次发布

### 目标和闭环

不增加特殊 self-host 代码，让一个已发布候选实例把 `cynos-ai/luowang` 当作普通目标仓库，完成首次场景基线和至少一个真实开发批次的测试；修复暴露问题后完成全量验收并发布 MVP。

### 实施范围

1. 构建独立候选容器，使用持久化卷和非生产预发布地址；
2. 把 `cynos-ai/luowang` 配置为唯一目标仓库，目标分支为 `scenario-testing`，测试来源为 `develop` 候选批次；
3. 配置真实 Provider、Main/Runner/Reviewer、Playwright MCP、私有 OSS 和测试账号；
4. 按陌生项目流程初始化少量核心场景，禁止为追求数量铺场景；
5. 至少执行一次 passed 流程、一次可控 blocked/恢复流程和一次同 target 人工重测；
6. 用真实运行验证报告 Git 提交、Indexer 回读、Issue 幂等、队列、Cron/Poll、重启和保留策略；
7. 完成威胁检查：非 root、无 Docker socket、端口默认只绑定 `127.0.0.1`、Secret 环境隔离、登录限流、Origin、Cookie、日志脱敏；
8. 验证数据库备份/恢复和 running/completed 人工清理；
9. 逐项执行 Spec §23 的 34 个 AC，保存命令、Run URL/ID、commit、PR/Issue 和截图证据；
10. 发现问题在独立 `fix/*` 修复并重新跑受影响 AC，不在验收分支顺手重构；
11. 更新公开 README 的实际部署方式、安全边界、许可证和 MVP 限制；
12. 发起 `develop → main` PR，所有 checks 和验收通过后合并，创建 `v0.1.0` tag。

### 专项验证

除所有公共命令外，建立并运行一个聚合命令：

```bash
npm run test:acceptance
```

该命令负责可自动化的 AC；依赖真实外部系统的 AC 由 dogfood Run 提供证据。最终必须证明：

- 从空卷部署到首次登录和配置成功；
- 自身场景初始化没有 suite/catalog/长期状态图；
- 真实 UI Run 的五文件、OSS 证据、Git 三报告、SQLite 详情一致；
- passed/failed/blocked 的推进矩阵和多个 Issue 幂等行为正确；
- 纯测试资产 commit 不触发，产品/需求 commit 正确合批；
- 重启不恢复 Agent 对话、不伪造结果；
- 所有 Secret 扫描为阴性；
- `npm test`、typecheck、生产 build、e2e smoke、Docker smoke 和 acceptance 全部通过。

### 退出条件

1. Spec §23 全部 AC 有可追溯的通过证据，没有“未运行但视为成功”；
2. dogfood 发现的阻断问题已经修复并复测；
3. `main` 上的发布 commit 与 `v0.1.0` tag 一致；
4. 公开仓库明确显示 PolyForm Noncommercial 1.0.0，且文案没有误称 OSI Open Source；
5. MVP 非目标没有被悄悄实现，后续候选需求回到新的 `docs/changes/<change-id>/`。

## 16. 验收追踪矩阵

| Spec 验收 ID | 首次闭环阶段 | 最终复验 |
|---|---:|---:|
| `AC-DEPLOY-01` | Phase 1 | Phase 9 |
| `AC-CONFIG-01` | Phase 1 | Phase 8、9 |
| `AC-CONNECT-01` | Phase 2 完成 GitHub、Phase 3 完成 Provider、Phase 4 完成 MCP/OSS 后闭环 | Phase 9 |
| `AC-GIT-01`、`AC-GIT-03`、`AC-INDEX-01` | Phase 2 | Phase 9 |
| `AC-RUN-01`、`AC-AGENT-01`、`AC-ZERO-01` | Phase 3 | Phase 9 |
| `AC-BROWSER-01`、`AC-DATA-01` | Phase 4 | Phase 9 |
| `AC-PROGRESS-01/02`、`AC-ISSUE-01`、`AC-HISTORY-01`、`AC-ARCHIVE-01`、`AC-REPORT-01` | Phase 5 | Phase 9 |
| `AC-GIT-02`、`AC-TRIGGER-01/02`、`AC-QUEUE-01`、`AC-RECOVERY-01` | Phase 6 | Phase 9 |
| `AC-SCENARIO-01`、`AC-SCENARIO-02`、`AC-SCENARIO-03`、`AC-SCENARIO-04`、`AC-SCENARIO-05`、`AC-INIT-01` | Phase 7 | Phase 9 |
| `AC-GIT-VIEW-01`、`AC-SCENARIO-VIEW-01`、`AC-RUN-VIEW-01`、`AC-ACTIVE-VIEW-01` | Phase 8 | Phase 9 |
| `AC-SECRET-01` | Phase 1、3 持续建立 | 每阶段回归，Phase 9 汇总 |
| `AC-QUALITY-01` | Phase 0 建立 | 每阶段必须通过，Phase 9 汇总 |

## 17. 停止条件

以下条件全部满足时，本计划结束：

- Phase 0–9 均通过各自退出条件并已合入 `develop`；
- Phase 9 全量 AC 通过；
- dogfood Run 能被公开仓库中的 commit、场景、报告和 Issue 事实复核；
- `develop → main` 发布 PR 已合并并创建 `v0.1.0`；
- 没有为了下一版本预先实现多仓库、多租户、并发 worker、通用工作流、发布 gate 或不可信仓库沙箱。

若某阶段发现 Spec 本身存在产品冲突，停止该阶段并先修改同目录 `intent.md`/`spec.md`，由项目负责人确认后再更新本计划；不能让实现 Agent自行改变产品边界后继续。
