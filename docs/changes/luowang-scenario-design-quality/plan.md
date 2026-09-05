# 场景维护与初始化质量改进 Plan

- 日期：2026-09-05
- 状态：工程 Phase 0–4 已完成；Phase 5 真实模型质量对比未运行（blocked）
- 依据：[intent.md](./intent.md)、[spec.md](./spec.md)

实施分支证明（2026-09-05）：分支为 `feat/scenario-design-quality`，基于
`develop@09dbed0`；实现提交为 `9e41cf5`。在实现开始前，当前分支的
`git ls-tree -r --name-only HEAD docs/changes/luowang-scenario-design-quality` 已列出且追踪以下三份文档：
`intent.md`、`spec.md`、`plan.md`（文档提交为 `38ba5bf`、`2bac167`）。

## 1. 实施原则与顺序

本计划以 `09dbed0` 为代码检查基线。实现时从最新 `develop` 建立 `feat/scenario-design-quality`，若下列 owner 已有增量修改，先核对调用关系并在原职责边界内集成，不另起一套规划或场景系统。

依次完成变更证据、显式选择与设计方法、初始化交接与审核、工程回归、真实质量对比。先补能影响后续判断的工具和交接，再验证提示词质量；不以更长的指令掩盖输入不可用。

所有实施阶段通过功能分支 PR 进入 `develop`，不直接提交或 force-push `develop`/`main`。本计划不包含发布 PR、SemVer tag、生产部署或真实官网资产写入。

## 2. Phase 0：需求基线

- [x] 在同一稳定 change 目录编写 Intent，明确问题、结果、影响、约束、非目标和真实评测前置。
- [x] 编写 Spec，定义固定变化证据、维护决策、写作契约、初始化交接、执行清单与质量证明。
- [x] 在上述范围稳定后编写本 Plan，给出修改 owner、风险和逐项完成证明。

完成证明：目录只包含 intent/spec/plan；链接、AC 引用和内容一致性检查通过。实现前的分支和文档存在性已由上述 Git 事实确认。文档完成不代表功能、提示词优化或模型效果完成。

## 3. Phase 1：Main 的固定变化证据

### 修改范围

- `src/server/repository/git-repository.ts`：复用已有固定 commit、changed paths、文件读取与 Git 调用模式，补文本 diff 和分页能力。
- `src/server/runs/agent-session.ts`：增加仅 Main Planning 使用的只读比较工具；保留 Runner 既有工具边界。
- `src/server/runs/orchestrator.ts` 的 `targetToolOptions` 和上下文组装：绑定本 Run base/target，补场景 description、索引状态、语言和标签配置。
- 相应 repository、角色工具和 Run 测试；必要的内部类型随 owner 就近维护。

### 实施顺序

1. 明确返回契约和服务端上限，区分无基线、空结果、分页未完、不可读与依赖错误。
2. 实现变更路径与前后内容读取，按净 diff 表达现存变化；不改 included commits 和触发排除规则。
3. 将路径、敏感内容、旧版本读取、rename 两端及游标校验放在工具执行边界；不要只写进提示词。
4. 为 Main 接入新工具和检索摘要，确保从固定 target 校验场景，不依赖索引恰好最新。

### 完成证明

- 新增、修改、删除、rename 在固定 base/target 返回正确事实；远端 HEAD 移动后同一 Run 的结果保持一致。
- base 为 null、base 等于 target、先改后撤销、只有测试资产变化、分页续读和超限内容各有明确结果。
- 删除前凭据、敏感 rename、越界路径、symlink/submodule 和跨范围游标被拒绝；工具错误不泄露原始敏感参数。
- Runner、Reviewer、Finalization 不获得新增读取权限；陈旧索引可回到 target 获取真实场景。

实际证明：`tests/scenario-design-quality.test.ts` 的固定 target 变化证据、增改删/rename、二进制、symlink/submodule、分页、游标绑定、不可读/依赖失败和远端 HEAD 移动用例通过；与执行清单和 Phase 3/4 交接专项合计 6 个测试文件、56 个测试通过（退出码 0）。`tests/phase3.test.ts` 的 Main-only 工具边界检查也通过。工程边界已证明，未把固定本地模型输出当作质量效果证明。

对应：AC-SDQ-01、AC-SDQ-02、AC-SDQ-03。

## 4. Phase 2：显式执行选择与场景设计方法

### 修改范围

- `resources/agent-roles/common.md`、`main-planning.md`：证据用途、维护决策、场景模板、语义去重、稳定 ID 与可判定断言。
- `src/server/runs/orchestrator.ts` 的 Main 输出契约、`progressScenarios` 和最终结果一致性校验。
- `src/server/runs/scenario-progress.ts`：消费同一清单，校验声明和实际完成范围。
- `tests/phase3.test.ts`、既有进度与角色装载测试，以及必要的计划解析专项测试。

### 实施顺序

1. 在现有 Run owner 内增加 Spec 规定的 Markdown 执行区解析；解析结果供 Runner 许可、进度和结果核对复用，不新增持久化清单。
2. 排除正文提及、历史引用、draft/deprecated 候选；旧 Run 只读路径不使用新契约追溯拒绝历史。
3. 编写重构、实现修复、已确认契约变更、新能力、废弃、冲突的决策规则和简短正反例。
4. 提供既有五字段 frontmatter 与正文模板，要求前置、关键断言、证据及清理可复现。
5. 确保计划保留 Reviewer 所需的期望与依据摘要，且这些说明不会扩大执行集合。

### 完成证明

- 构造计划同时包含“执行 A、排除 B、历史 C、draft D”，生产选择和进度只允许 A。
- 重复标题/ID、未知 ID、禁止状态、漏执行、声明子集与结果不一致均不能通过；有依据的空清单保持有效。
- 普通 Run 应用场景 patch 后按同一工作场景核对清单；保持稳定 ID rename 兼容。
- 指令通过既有 loader 装载，system/user 不重复；本地流程能生成符合契约的计划与 patch。
- 本阶段仅完成质量规则与工程行为证明，不将固定模型返回值当成真实设计效果。

实际证明：`tests/scenario-design-quality.test.ts` 4/4、`tests/closure4-progress.test.ts` 5/5、`tests/closure6-acceptance-layering.test.ts` 13/13、`tests/phase3.test.ts` 19/19 及关联生产 Pi 用例均通过。计划正文中的 ID、历史/draft/deprecated 引用不会扩大执行集合；重复/未知/非 approved/乱序/漏执行结果会拒绝。角色资源仍由既有 loader 确定性装载。

对应：AC-SDQ-04、AC-SDQ-05、AC-SDQ-08、AC-SDQ-11 的工程部分。

## 5. Phase 3：初始化计划交接与独立审核

### 修改范围

- `resources/agent-roles/scenario-initialization.md`：能力/风险表、证据冲突、候选综合和停止标准。
- `resources/agent-roles/runner-execution.md`、`reviewer-audit.md`、`main-finalization.md`：当前阶段输入、正式清单、设计审核与摘要消费。
- `src/server/runs/orchestrator.ts` 的候选 Main 工具、计划更新、无 patch 验证分流、浏览器前置重查、Reviewer 契约和特殊报告生成。
- `tests/acceptance/local-model-protocol.ts`、`tests/closure6-production-pi.test.ts`、初始化和场景生命周期测试。

### 实施顺序

1. 给候选 Main 增加同一 `write_plan`，限制仍为本 Run 的 `plan.md`，不开放新的任意 writer；包括无 patch 复用已有场景、没有可信候选两种情况，结束前都必须成功更新计划。
2. 明确先读取静态计划和侦察工件，再生成候选与新计划；保留必要侦察摘要，避免验证阶段覆写执行工件后丢失候选依据。
3. 解除初始化验证对 `scenarioDecision === 'applied'` 的依赖。需要审批的 patch 保持三 Session 特殊分流；其余路径有 patch 则先应用、无 patch 则使用固定 target 的已有工作场景，统一核对执行清单、状态与关键前置，重查更新计划是否要求 UI/MCP，并进入正式验证 Runner、Reviewer 和最终 Main。空清单也声明零场景并走独立审核，不能因无 patch 或无可信场景直接通过。
4. 统一 Reviewer 的读取顺序：期望和 patch、原始证据、执行记录与草稿；审核可执行性、覆盖缺口和断言来源。
5. 保持三 Session 人工审核分流与特殊两工件协议，在 Harness 特殊报告中保留脱敏的必要候选/缺口摘要；不得复制整份未筛选计划。
6. 调整本地模型协议的阶段识别。当前以“有 patch writer、无 plan writer”识别候选 Main，新增 plan writer 后必须显式区分静态与候选阶段，不能被路由回静态阶段。

### 完成证明

- 静态计划只知道能力 A；侦察发现 B；候选 Main 写入含 B 的新计划和 patch；验证 Runner 与 Reviewer 实际读取新计划，不预埋 B 的最终 ID。
- 候选计划新增 UI 验证时重新检查浏览器前置；不可用时不能沿用第一次无 UI 判断而通过。
- 写计划失败、patch 校验失败、清单与工作场景不一致有明确失败事实，不执行旧计划冒充新候选验证。
- 初始化对已有资产按计划选择，不全量执行所有非 deprecated 文件；不确定 draft 不计为正式通过。
- 增加无 patch 复用用例：target 已有 approved 场景 A、B，候选 Main 只更新计划选择 A；真实生产路径仍创建六个隔离 Session，正式验证只声明并完成 A，Reviewer 读取该次验证工件，最终结果与清单一致。不得预造无意义 patch 来进入验证。
- 无 patch、空清单分别覆盖有依据无需测试与场景缺失/期望不明：前者通过既有零场景独立审核，后者 blocked；新计划要求 UI 而前置不可用时也不能通过。
- 普通四 Session、初始化六 Session、人工审核三 Session 分别验证工具、独立 ID、dispose 和工件边界；特殊报告摘要无 Secret。
- 最终 Main 修订 patch 但不重跑仍 blocked；场景三种维护模式和历史报告不可改写规则回归通过。

实际证明：`tests/closure6-production-pi.test.ts` 8/8、`tests/phase4-orchestrator.test.ts` 7/7、`tests/phase3.test.ts` 中候选计划写入失败、候选 patch 校验失败、计划/工作场景不一致等新增用例均通过。生产 Pi 路径实际创建普通 Run 四个 Session、初始化六个隔离 Session；人工审核路径停止在三个 Session 并只保留两份特殊工件。无 patch 复用 approved 场景、依据充分的 0/0 和最终修订未重跑 blocked 均有覆盖。

对应：AC-SDQ-06、AC-SDQ-07、AC-SDQ-09、AC-SDQ-10 及 AC-SDQ-11 的工程部分。

## 6. Phase 4：生产路径工程回归

### 范围与执行

- 将新增事实、选择、交接和边界测试纳入已有 local acceptance 映射，每个 AC 引用自己的证据，不把整个阶段统一标为通过。
- 先运行受影响的 repository、Run、场景进度、角色指令和生产 Pi 测试，处理实际失败后再做完整检查。
- 在 Docker `quality` target 中运行 format、lint、typecheck、unit、build、headless E2E 和 `test:acceptance:local`；若 local 已执行某项完整检查，保留其证明，不为同一版本重复运行。
- 验证构建后的六份角色资源和指令 hash，保持 runtime 使用相同发布物；不依赖宿主机 Chromium。
- 检查外部路径、错误和输出脱敏，以及场景 patch、特殊工件、历史报告和归档回归。

### 完成证明

保存当前 commit、quality 镜像标识、实际命令、退出码、测试结果和逐 AC 证据。标明哪些属于确定性工具/流程证明，哪些质量项仍等待真实模型复核。工程阶段完成时可报告“工程检查通过、模型效果未验证”，不得称完整质量改进已验收。

实际证明（实现提交 `9e41cf5`，宿主机 Windows）：

| 检查 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm run format:check` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run typecheck` | 0 | 通过 |
| `npm test` | 0 | 25 个测试文件、147/147 tests 通过；测试脚本固定 30s test timeout、15s hook timeout |
| `npm run build` | 0 | server/client 构建通过（仅有 chunk size warning） |
| `npm run test:e2e` | 0 | smoke 与 Phase 8 headless UI smoke 通过 |
| `npm run test:acceptance:local` | 0 | `local=passed`；报告为 `.cynos/acceptance/2026-09-05T15-37-21-891Z-local/report.json` |
| `npm run test:acceptance:live` | 1 | 输入门禁按预期 `live=blocked`，未调用真实外部系统 |

Docker 证明使用 Dockerfile/CI 中的 pinned Node digest、npm 镜像、Playwright 下载源和 Debian 镜像：`docker build --target quality ... --tag luowang:scenario-design-quality-quality .` 退出码 0，quality 镜像 ID 为 `sha256:faf5d390a90bb395932d207779fd2407b8337eda9fbbc2fd65b932f1397bb56d`，镜像内 `verify:browser` 通过；`docker run --rm --init --ipc=host luowang:scenario-design-quality-quality npm run test:acceptance:local` 退出码 0，`local=passed`、`live=blocked`、`release=blocked`。逐项 local AC 映射和全部工程 proof 均通过，`sdq12` 保持 `not_run`。

本机尝试构建 `runtime` target 时，Docker 未命中 browsers 中间层；显式 cache source 又返回 registry cache importer `403 Forbidden`，为避免重复下载而停止，故不把 runtime 本机尝试记为通过。PR 的 quality workflow 仍会构建 runtime 并执行生产 Chromium 验证。该环境限制不影响已完成的 quality target 证明。

对应：AC-SDQ-01–11 的工程证明，以及 AC-SDQ-12 的本地/真实结果分层。

## 7. Phase 5：真实模型质量对比

### 输入准备

- 冻结本变更前的应用与角色资源版本作为基线，冻结实施后的候选版本；使用相同模型、Thinking、人工请求和场景模式。
- 以固定 `cynos-ai/cynos-website` 事实或其脱敏离线开发夹具准备 Spec §8.2 的八类输入，固定 base/target、场景和必要侦察记录。离线夹具不构成另一个受管理测试目标。
- 另为 Reviewer 冻结至少四组工件：无依据断言、已识别核心能力覆盖遗漏、计划与执行结果不一致，以及无错误对照。冻结 plan、必要 patch、原始证据、execution 和 draft-report；两版本共用同一组工件，不使用各自规划输出作为对比输入。
- 在运行前写明每例预期决策、必需风险、禁止猜测的期望及人工复核规则；Reviewer 另列应检出的问题、充分证据与不应报告的问题，评分答案不进入 Session，不拿模型答案反向定义标准。
- 使用既有 Secret Store 配置模型凭据；确认覆盖规划与 Reviewer 两组评测的模型调用预算及所需非生产条件。本计划不授权额外生产访问、真实业务数据或远端发布。

### 执行与复核

1. 通过生产规划 Session 和实际工具运行两版本，八类输入每例各三次，输出保存到本地隔离 Run workspace。
2. 另通过生产 Reviewer Session 和实际工件/证据读取工具运行固定工件案例，两版本每例各三次；收集 `write_review` 输出和实际读取顺序，验证 Reviewer 先核对期望与原始证据再读草稿。不能以人工审阅规划输出代替这组调用，也不扩大 Reviewer 的工具权限。
3. 设计评测不调用 Archiver 发布，不创建官网数据或执行目标环境操作；初始化可复用固定侦察工件比较候选综合，Reviewer 使用冻结证据，工程完整六 Session 证明由 Phase 4 承担。
4. 两组均保留成功、失败、缺少工具和未完成结果；人工按同一标准复核。规划记录无依据断言、漏风险、重复、无谓修改、不可执行和交接错误；Reviewer 单独记录已知问题漏检、无证据误报及读取顺序违约，无错误对照不能因过度报错被算作优秀审核。
5. 按 Spec 的改善标准分别汇总两组指标并共同判断，同时记录耗时、工具调用和可取得的 token 用量。不能只展示最优输出或一次成功，也不能把规划质量提升归因于 Reviewer。
6. 未达到标准时保留退步事实，修订后重跑受影响案例及完整对比矩阵；不以增加场景数量代替质量改善。

### 完成证明

脱敏评测输入清单、版本标识、全部输出、逐例复核和对比结果保存于 `.cynos/acceptance/`，分别标注规划与 Reviewer 的证据，在本计划补充非敏感证据位置和实际状态。AC-SDQ-09 的真实质量证明必须来自固定工件的真实 Reviewer 输出和读取记录；未运行这组评测时，即使规划对比或本地流程通过，该 AC 仍保持未完成。凭据、预算或外部条件缺失时记录未运行/受阻及原因，Phase 5 保持未完成，不用本地协议模拟出质量通过。

实际状态：Phase 5 未运行（`not_run/blocked`）。`npm run test:acceptance:live` 在输入检查阶段退出码 1；固定 `cynos-ai/cynos-website` 的不可变快照、非生产 URL/合成账号、GitHub/Provider/OSS 受控凭据、视觉 Reviewer 条件以及明确模型调用预算均未提供。本地 acceptance 报告中的工程 proof 全部通过，但 AC-SDQ-04/05/06/09/12 的真实模型部分仍为 `not_run`；没有基线/新版八类输入三次重复计数、Reviewer 固定工件读取记录或人工复核结论，因此本变更不声称真实场景设计质量已经改善。

对应：AC-SDQ-04、AC-SDQ-05、AC-SDQ-06、AC-SDQ-09 的实际输出质量，以及 AC-SDQ-12。

## 8. 风险与控制

| 风险                                 | 控制与验证                                                             |
| ------------------------------------ | ---------------------------------------------------------------------- |
| diff 过大或已删除文件泄露敏感内容    | 服务端分页与范围绑定，旧内容和 rename 两端同等过滤，测试截断与错误路径 |
| 更丰富的分析正文导致额外场景被执行   | 先落地显式清单，测试排除项、历史 ID 和 draft 引用                      |
| 初始化新计划与 patch、浏览器前置脱节 | 候选结束后统一核对，后续只读新计划，新增 UI 重新评估                   |
| 侦察记录被验证阶段覆写后失去依据     | 候选 Main 在同一计划保留必要事实摘要，Reviewer 不依赖旧对话            |
| 特殊报告为了保留理由扩大持久化范围   | 仅摘要进入既有 report，保留两工件 allowlist 和脱敏检查                 |
| 指令膨胀、顺序冲突或示例被机械照抄   | 规则按角色归属编写，少量示例，生产装载检查与跨案例评测                 |
| 固定模拟掩盖真实设计问题             | 工程与模型质量分层，基线/新版同输入重复对比，人工复核全部结果          |

## 9. 验收追踪与当前状态

| 验收项                          | 实施/证明阶段 | 当前状态 |
| ------------------------------- | ------------- | -------- |
| AC-SDQ-01、AC-SDQ-02、AC-SDQ-03 | Phase 1、4    | 工程通过   |
| AC-SDQ-04、AC-SDQ-05            | Phase 2、4、5 | 工程通过；真实模型部分未运行   |
| AC-SDQ-06、AC-SDQ-09            | Phase 3、4、5 | 工程通过；真实模型部分未运行   |
| AC-SDQ-07、AC-SDQ-10            | Phase 3、4    | 工程通过   |
| AC-SDQ-08                       | Phase 2、3、4 | 工程通过   |
| AC-SDQ-11                       | Phase 2、3、4 | 工程通过   |
| AC-SDQ-12                       | Phase 4、5    | 工程/本地通过；真实评测未运行   |

Phase 0–4 的工程实施和证明已完成；Phase 5 因外部输入缺失保持 `not_run/blocked`。分支 PR 仍需向 `develop` 提交并通过仓库 CI；即使 PR 合并，缺少真实质量证据时也不能宣称提示词或场景设计质量已提升。
