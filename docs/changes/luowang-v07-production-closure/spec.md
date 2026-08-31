# 罗网 v0.7 生产闭环补齐 Spec

- 状态：Implementation Baseline v0.4
- 关联 Intent：[intent.md](./intent.md)
- 实现计划：[plan.md](./plan.md)
- 上游规格：[罗网 Harness MVP Spec](../luowang-harness-mvp/spec.md)
- 权威设计：`罗网（LuoWang）场景测试 Harness 设计 · MVP Implementation Baseline v0.7`

## 1. 规格范围与优先级

本 Spec 只覆盖以下增量：角色工作方法装载、首次创建/人工 merge 与固定 target、测试数据清理确认、实时场景进度、Main Planning 历史 Run、验收分层、外部资源交付和后续发布。

发生冲突时：

1. v0.7 PDF 的产品和架构边界优先；
2. 本 Spec 是这些边界在当前代码上的增量解释，覆盖上游 MVP Spec 中同主题的旧实现说明；
3. 未被本 Spec 修改的认证、场景模式、归档、Issue、推进、Git allowlist、单实例和部署规则继续遵循上游 MVP Spec；
4. 实现 Agent 不能借“内部实现细节”改变本 Spec 的用户可观察行为。

## 2. 已确认的当前事实

实现以当前 `develop` 为起点，并把下列事实作为回归基线：

- `agents.main`、`agents.runner`、`agents.reviewer` 三组 Agent 配置已存在；正常 Run 创建 Main · 规划、Runner、Reviewer、Main · 最终汇总四个独立 Session，生产 Session 使用 Pi SDK；
- ambient extensions、Skills、Prompt Templates、Themes 和 Context Files 已关闭；
- 当前角色方法硬编码在 Orchestrator，完整提示词同时进入 system prompt 和首条用户消息；
- `/api/repository/scenario-branch` 在队列外同步创建首次场景分支，`/api/repository/merge` 直接执行 merge，`/api/runs` 接受任意 `targetCommit`；
- 默认 TestDataManager 没有清理实现，登记数据后无法确认已清理；
- `currentScenario` 和 `scenarioProgress` 只初始化、不随真实 Runner 更新；
- Run Store 已保存详细 Run，但 Main · 规划上下文只包含正式报告摘要和 GitHub Issues；
- Phase 9 本地 acceptance 使用 FixtureSessionFactory，live smoke 只覆盖 GitHub 的有限路径；
- `v0.1.0` 已发布，必须保持不可变。

## 3. Built-in Role Instructions 与 Prompt 组装

### 3.1 设计选择

罗网不使用 Pi Skills。Main、Runner、Reviewer 的业务职责固定，应用必须在创建 Session 前从自身发布物中确定性、完整加载 Built-in Role Instructions（内置角色指令），而不是让模型发现或读取 Skill。

固定资源为：

```text
resources/agent-roles/
├── common.md
├── main-planning.md
├── runner-execution.md
├── reviewer-audit.md
├── main-finalization.md
└── scenario-initialization.md
```

这些 Markdown 文件是罗网发布物中的固定角色说明，不是 `SKILL.md`，不遵循 Pi Skill 格式，也不参与 Pi 的全局、用户、宿主机或项目自动发现。构建产物和 Docker 镜像必须包含它们；任一必需文件缺失、为空或不可读时，对应 Session 创建失败并给出不含本地敏感路径的明确错误。

Session 创建继续保持：

```text
skills = []
noSkills = true
noPromptTemplates = true
noContextFiles = true
noTools = builtin
```

不得使用 `skillsOverride`，不得开放通用 `read`，不得加载目标仓库中的 `.pi/skills`、`.agents/skills`、`AGENTS.md` 或其他角色资源，也不得允许网站配置任意角色指令路径。

### 3.2 三个 Agent 配置与四个独立 Session

罗网只有三组可配置 Agent：

```text
agents.main
agents.runner
agents.reviewer
```

正常 Run 创建四个全新的独立 Session：

```text
Main Planning Session
→ Runner Session
→ Reviewer Session
→ Main Finalization Session
```

面向用户统一显示：

```text
Main · 规划
Runner
Reviewer
Main · 最终汇总
```

Main Planning Session 和 Main Finalization Session 共同使用 `agents.main` 的 Provider、模型和 thinking 配置，但它们是两个新建、互相隔离的 Session：不共享完整对话，使用不同内置角色指令和不同受控工具，只通过落盘 Markdown 工件交接。不得增加 `agents.planner`、`agents.finalizer`、第四个模型字段、第四个 Provider 检查或第四组 live 模型输入。

初始化流程可以创建多个 Main Planning Session 和多个 Runner Session；每次都必须新建并隔离，但分别复用 `agents.main` 和 `agents.runner` 配置。内部类型为兼容现有数据可以继续使用 `main-a`、`main-b`，不要求迁移；网站、当前执行页面、活动记录和报告不得显示这些内部名称。

### 3.3 四类 Session 职责与装载

| Session | 固定装载 | 初始化时附加 | 职责与硬边界 |
|---|---|---|---|
| Main · 规划 | `common.md` + `main-planning.md` | `scenario-initialization.md` | 理解请求、需求和累计 diff；阅读项目理解、场景和相关历史；维护或选择场景；形成 `plan.md`；必要时生成受限场景 patch；不执行测试 |
| Runner | `common.md` + `runner-execution.md` | 无 | 顺序执行计划；使用受控命令、Playwright MCP 和测试账号；创建、登记、清理测试数据；保存证据；写 `execution.md` 和 `draft-report.md` |
| Reviewer | `common.md` + `reviewer-audit.md` | 无 | 独立读取本次工件和受控证据；审核截图和清理证据；判断 Bug、blocked 和零场景结论；写 `review.md`；不执行命令、不获取测试账号 |
| Main · 最终汇总 | `common.md` + `main-finalization.md` | `scenario-initialization.md` | 读取前置工件和 Reviewer 结论；从本次草稿形成 Bug 候选并受限查询相似历史 Issue/Run；按 `blocked > failed > passed` 聚合；决定 confirmed Bugs 的 Issue create/link；写 `report.md`；初始化 Run 可按 Reviewer 意见修订尚未发布的场景 patch，但修订后未重新执行必须保持 blocked |

初始化中的“静态勘察”和“候选综合”都是 Main Planning Session；“运行时侦察”和“候选验证”都是 Runner Session。职责相同的多次 Session 仍不能共享完整对话，只能读取当时允许的落盘工件和角色裁剪上下文。

实现可以在构建时把 Markdown 编译为模块，或在启动时从固定安装目录读取；无论采用哪种方式，生产 Session 获得的内容必须只来自当前罗网版本的固定 allowlist，不能接收 Agent 或网站指定路径。

### 3.4 Prompt 分层

每个 Session 的输入固定分成：

```text
System Prompt
= 角色身份
+ common Role Instructions
+ 当前阶段 Role Instructions
+ 可选初始化规则
+ 输出契约

User Message
= 当前任务
+ 经过角色裁剪的动态 Run 上下文
```

同一完整角色说明不能同时进入 system prompt 和 user message。动态值不写入内置角色指令：run-id、请求、base/target/included commits、阻塞原因、历史摘要和证据引用都属于本次 user message 或受控工具结果。

内置角色指令不提供权限。权限只由 custom tools、Secret Store、adapter、writer、路径 allowlist 和 patch 校验强制控制；Prompt 声明不能扩大工具、Secret 或写入范围。

### 3.5 角色动态上下文

- **Main · 规划**：请求、trigger、base/target/included commits、场景模式、初始化标记、已索引场景摘要，以及有限的历史报告/Run/Issue 查询能力；
- **Runner**：run-id、固定 target、计划、工作场景、非生产环境工具和 Harness 已确认阻塞原因；不直接注入历史 Issues 或 Git Token；
- **Reviewer**：run-id、固定 target、本次工件、证据引用和 Harness 阻塞原因；可以对已经读取的当前 Run 清理证据作结构化确认，但不获得目标环境命令、历史 Issue 列表、测试账号或任意仓库写入能力；
- **Main · 最终汇总**：固定 Run 范围、本次四个前置工件、Reviewer 结论和受限的 `query_issue_candidates`；它先从 `draft-report.md`、`review.md` 形成 Bug 候选，再按标题/关键词/bug key 查询可能相同的 Issue/Run；不预先依赖尚未生成的 `confirmed_bugs`，也不获得通用历史查询、目标仓库通用读取或命令能力。

### 3.6 内置角色指令内容规则

内置角色指令固定以下方法：

- 已确认规格和长期场景回答“应该是什么”；代码只回答“怎么调用”和“当前实际怎样”，不能用当前实现反推正确期望；
- Main · 规划明确记录选择理由、证据优先级和覆盖缺口；
- Runner 不修改产品或场景，按顺序执行，记录实际观察、决定性/辅助证据、偏差、Secret 边界和清理；
- Reviewer 先看固定 Run/场景期望和原始证据，最后才看 Runner 草稿；Runner 报告是待审核假设，不是事实；
- 不影响验证目标的偏差可以记录后继续，影响前置、操作语义或断言的偏差必须 blocked；
- Main · 最终汇总只根据已落盘事实和审核结论聚合，不发明执行事实，不回写旧结果；
- 每份内置角色指令使用“目标、硬边界、顺序、输出契约、失败规则、反模式”的稳定结构。

不引入 suite/catalog、长期能力图、多 checkpoint、审批 hash、workflow gate、大量状态 JSON、五状态、三轴结果、发布 gate、pi-subagents、自测和公共 OSS 规则。

### 3.7 可验证性

每份内置角色指令固定逻辑 ID 和内容格式版本；运行/验收以 `逻辑 ID + 应用版本 + 内容 SHA-256` 标识实际装载版本。验收报告记录这些标识，但不创建新的 Run 状态文件。测试必须证明：

- 四类 Session 只装载自己的内置角色指令；
- ambient Skills、Prompt、Context、用户/宿主机/目标仓库资源即使存在也不会进入 Session；
- system prompt 不包含其他角色的专属规则；
- user message 不重复完整内置角色指令；
- 工具 allowlist 不因指令内容改变；
- 配置仍只有 Main、Runner、Reviewer 三组，Main 的两个 Session 使用同一配置但对话和工具隔离；
- 面向用户只显示 Main · 规划、Runner、Reviewer、Main · 最终汇总。

## 4. 固定场景测试分支上的人工请求

### 4.1 请求种类

现有 SQLite FIFO 扩展为三种业务请求，不增加通用工作流状态机：

| 请求 | 输入 | 调度时行为 |
|---|---|---|
| `automatic-head` | Git/Cron 请求文本 | 使用调度时已计算的场景测试分支最新可测试 HEAD；仍允许自动请求合批 |
| `manual-current-head` | 人工/API 请求文本、可选 `initialization` | fetch 后固定当前远端场景测试分支 HEAD；人工请求不合并、不丢失 |
| `manual-merge-source` | 人工请求文本、`sourceRef`、明确确认、可选 `initialization` | 分支存在时执行 `merge --no-ff`；分支不存在且 `initialization=true` 时从解析后的 source commit 首次创建；两种路径都先固定 prepared/resolved，再创建 Run |

首次创建不是第四种请求，继续复用队列已有的 `initialization` 事实。队列 migration 必须增加并持久化 `request_kind`、`source_ref`、`prepared_merge_commit`、`resolved_target_commit`；字段使用数据库命名，API 可继续使用对应 camelCase。`prepared_merge_commit` 和 `resolved_target_commit` 是请求幂等事实，不是通用 checkpoint 或工作流状态。不得把 branch/tag/任意 SHA 继续伪装成可直接 checkout 的 `targetCommit`。

远端场景测试分支不存在时，`automatic-head` 不产生可测试批次；已排队的 `automatic-head` 或 `manual-current-head` 必须明确失败且不创建 Agent Run。`manual-merge-source` 只有携带 `initialization=true` 才能进入首次创建特例；否则明确失败并提示以初始化请求重提。

### 4.2 API 和网站行为

- 网站“合并 branch/tag/SHA”提交 `manual-merge-source`，返回 queue ID，不再同步返回已经完成的 merge；请求可以明确携带 `initialization=true`；
- 首次创建场景分支使用同一 merge-source 入口，提交用户确认的 `sourceRef`、`confirmed=true`、`initialization=true`，不能先创建分支再另行触发初始化 Run；
- `POST /api/repository/scenario-branch` 不再允许在队列外同步调用 `ensureScenarioBranch()` 产生 Git 副作用；兼容期若保留该端点，只返回明确的迁移错误并指向 merge-source initialization 入口，不能自行创建分支或 Run；
- 普通 `POST /api/runs` 只提交 `manual-current-head`，不接受调用者指定 target commit；旧字段若保留兼容期，任何非空值必须被拒绝并提示改用 merge-source 或 Run 重测入口，不能静默绕过；
- 已有 Run 的“重测”复用原请求说明/场景意图，但在真正调度时固定**当前**场景测试分支 HEAD；本变更不提供分支已经前进后任意回放历史 SHA 的通用入口；
- 场景分支已存在时，初始化请求可以使用 `manual-current-head + initialization=true`，或使用 `manual-merge-source + initialization=true` 先纳入 source 再直接创建一个初始化 Run；
- API 响应和网站显示 queued、merge/running、waiting archive、completed/failed/interrupted 等现有事实，不增加跨 Run checkpoint。

### 4.3 固定 merge/首次创建结果、Git 可达性与恢复幂等

`manual-merge-source` 在罗网的**本地持久 Git 仓库**中为每个队列请求使用确定性 internal ref：

```text
refs/luowang/merge-requests/<queue-id>
```

该 ref 不是业务分支，只用于让 prepared commit object 在进程重启、临时工作区清理和本地 Git GC 后仍可达；它不得被 push 到目标仓库，也不得加入任何默认 push refspec。

远端 `scenario-testing` 已存在时，执行顺序固定为：

```text
解析 source ref
→ 基于当时远端 scenario-testing HEAD 生成本地 merge commit
→ 创建本地 internal ref 指向该 commit
→ 持久化 prepared_merge_commit
→ non-force push prepared commit 到远端 scenario-testing
→ 持久化 resolved_target_commit
→ 使用 resolved_target_commit 创建且只创建一个 Run
→ 请求 completed 或明确 failed/interrupted 后清理 internal ref
```

远端 `scenario-testing` 在该请求被调度并 fetch 后仍不存在，且请求携带 `initialization=true` 时，首次创建特例固定为：

```text
解析 sourceRef 并固定 source commit
→ 创建本地 internal ref 指向 source commit
→ 持久化 prepared_merge_commit = source commit
→ 以“远端 ref 必须仍不存在”为前置条件创建 scenario-testing
→ 持久化 resolved_target_commit = 已发布的同一 source commit
→ 使用 resolved_target_commit 创建且只创建一个 initialization Run
→ 请求 completed 或明确 failed/interrupted 后清理 internal ref
```

首次创建没有已有 HEAD，因此不生成伪造的 merge commit；字段名仍为 `prepared_merge_commit`，但在该特例中它表示已准备发布且由 internal ref 保持可达的 source commit。远端创建必须是 compare-and-create/expected-absent 的 non-force 写入：只能从不存在创建，不能覆盖或推进刚被其他操作者创建的同名 ref。

两条路径共同遵守：

- `sourceRef` 只在首次准备时解析一次；internal ref 创建后不再重新解析可能移动的 branch/tag，也不根据后续 HEAD 重建 commit；
- `prepared_merge_commit` 必须在 push 前提交到 SQLite，且此时 internal ref 必须存在并指向同一 SHA；成功 push 后，`resolved_target_commit` 固定为已经发布到场景测试分支的同一 commit；Orchestrator 只能接收该字段，不能重新读取移动中的 HEAD 替换 target；
- 已有分支路径中，来源已经是场景测试分支祖先时不创建重复 merge commit；internal ref 指向当时远端 HEAD，再把该 SHA 持久化为 prepared/resolved，仍可创建本次人工 Run；
- 首次创建路径中，prepared 后无论 push 返回成功、拒绝、连接中断还是进程退出，都使用同一可恢复判定：先校验 internal ref 并 fetch；远端 ref 仍不存在则只重试 compare-and-create 同一 prepared SHA；远端历史已包含 prepared 则说明该不可变 target 已发布，补写 `resolved_target_commit = prepared_merge_commit`，但绝不采用较新的远端 HEAD；远端 ref 已存在且历史不包含 prepared 才是竞争失败，不转成普通 merge、不重建 commit，也不创建 Run；
- 首次创建的 expected-absent 条件绝不允许本请求推进或覆盖已存在的 ref；“远端已包含 prepared”是幂等发布成功，不是改用竞争 HEAD。协议不持久化或依赖进程内 push outcome，避免在收到结果后、写 terminal/resolved 前再次崩溃产生不可恢复歧义；
- 进程在 prepared 后、push 前退出时，恢复逻辑必须从 internal ref 读取并校验同一 object；临时 clone、merge 工作树或进程内对象都不能成为唯一来源；
- prepared 存在但 internal ref 缺失/指向其他 SHA，且远端也不包含 prepared commit 时，请求明确失败，不重新生成 merge；如果远端已包含 prepared，则按已成功 push 恢复并持久化同一 resolved；
- 进程在 push 后、写入 resolved 前退出时，恢复逻辑 fetch 远端并检查是否已包含 `prepared_merge_commit`；已包含则持久化同一 `resolved_target_commit`，不得重复 merge、重复建分支或改用更新后的 HEAD；
- `resolved_target_commit` 已存在时，恢复逻辑只校验该 commit 已发布在远端场景测试分支历史中，然后创建或关联唯一 Run；首次创建请求的 Run 必须保留 `initialization=true`；即使场景分支后来又有新 commit，本请求 target 也不改变；
- internal ref 已创建但 SQLite 尚无 prepared（进程恰在两步之间退出）时，不猜测或重做 merge/首次创建：当前请求明确失败并清理该 ref；没有对应队列行的孤儿 ref 也在启动对账后清理；
- internal ref 在 `queued`、`running`、`waiting_archive` 期间不得被普通 workspace cleanup、fetch/prune 或 GC 删除；只在请求进入 terminal 状态后幂等清理；清理失败记录脱敏运维错误但不得改变已经固定的 Run target；
- `sourceRef` 无法解析、merge 冲突、远端竞争或 push 失败时，请求以明确失败结束，不创建 Agent Run、不修改产品代码、不推进 target，并清理 internal ref；
- 人工 merge 请求不参与自动请求合批；远端写入继续禁止 force-push。

### 4.4 `v0.1.0` 旧队列行迁移

旧 schema 的 `target_ref` 不能被静默解释成已确认的 `source_ref`。migration 和启动恢复使用以下固定规则：

| 旧行 | 新 `request_kind` | 处理 |
|---|---|---|
| `trigger=git|schedule`，`status=queued` | `automatic-head` | 保留旧 `target_ref` 只作历史审计；新调度不直接使用它，轮到时按当前 automatic-head 规则固定场景分支可测试 HEAD |
| `trigger=manual|api`，`status=queued`，`target_ref IS NULL` | `manual-current-head` | 正常保留排队，轮到时固定当前场景分支 HEAD |
| `trigger=manual|api`，`status=queued`，`target_ref IS NOT NULL` | `manual-current-head` | migration 直接标记 `failed`，错误说明旧任意 target 不会自动升级成 merge 授权；操作者必须通过新 merge-source 入口重新提交 |
| `status=running` 且 `run_id IS NULL` | 按上述 queued 规则 | automatic 或无 target 的 manual/api 可重新排队；带旧 target 的 manual/api 标记 failed，不执行旧 target |
| `status=waiting_archive` 且 `run_id IS NULL` | 按 trigger 归类 | migration 统一标记 `failed`，错误说明等待归档请求缺少 Run ID；不得重新排队、merge 或创建 Run |
| `status=running|waiting_archive` 且已有 `run_id` | 按 trigger 归类 | 只恢复既有 Run/归档，不重新调度；`resolved_target_commit` 从该 Run/Recovery 的已固定 target 回填（可取得时） |
| `status=completed|failed|interrupted` | 按 trigger 归类 | 作为历史只读记录保留，不重新执行；有已存 Run 时可从 Run Store 回填 resolved，无值则保持 null |

旧 `target_ref` 列可以为兼容读取保留，但新请求不再写入，调度器也不得把它当作 source 或 resolved target。migration 必须在同一事务中先回填 `request_kind` 再处理旧 pending 行；错误信息不得包含 Secret。旧 automatic 行在新语义下按调度时 HEAD 执行，旧 manual/api 任意 target 宁可显式失败，也不能在没有新的 merge 确认时推进 `scenario-testing`。

## 5. 测试数据生命周期

### 5.1 数据状态

TestDataManager 对当前 active Run 维护最小内存事实：

```text
registered → cleanup-claimed → verified-cleaned
```

这不是长期场景状态机，不新增 Run 文件或 SQLite checkpoint。进程退出时 Run 按既有规则 interrupted，不恢复 Agent 对话。

每条记录至少包含：稳定 ID、可选场景 ID、脱敏说明、登记时间、清理声明、Harness 管理的证据引用和最终核验来源。ID 必须使用当前 run-id 前缀或可关联值，不能包含密码、Token 或真实用户隐私。

`cleanup-claimed` 只是 Runner 声明，不能让 Run 通过；只有以下任一方式能产生 `verified-cleaned`：

1. 受控清理 adapter 对该 ID 执行删除并独立查询确认不存在，返回 Harness 生成的核验 receipt；
2. Runner 使用受控 UI/API/命令工具删除后，由 Harness 直接捕获删除后查询的真实响应/输出，或接收 Playwright MCP 直接生成的删除后截图；Reviewer 实际读取该证据后，通过专用确认工具判定足以证明清理。

Markdown、自填字符串、任意 URL、没有被 Harness Evidence Store 管理的路径，或 Runner 单独调用“已清理”工具，都不能成为 `verified-cleaned`。Agent 不能提交 evidence 正文、状态码、退出码或内容摘要来伪装工具结果。

### 5.2 Runner 和 Reviewer 工具

Runner 获得：

- `get_test_data_prefix`；
- `register_test_data`；
- `submit_test_data_cleanup_claim`：只能为当前 Run 已登记 ID 提交清理声明，并引用一个或多个已存在、由当前 Run Evidence Store 管理的脱敏证据 ID；它只进入 `cleanup-claimed`；
- `list_pending_test_data`：只返回当前 Run 尚未 `verified-cleaned` 的脱敏条目。

Reviewer 获得 `verify_test_data_cleanup`：只能处理当前 Run 的 cleanup claim；对应 evidence 必须存在，并且 Reviewer 已通过受控 evidence reader 实际读取。Reviewer 可以确认或拒绝，不能执行删除、访问测试账号或提供任意证据路径。

需要文本清理证据时，不提供接受 Agent 任意 `content` 的保存工具。Evidence Store 只能从以下受控执行结果直接生成记录：

- 清理 adapter 的删除后查询响应；
- 受控 API 查询工具的真实响应；
- 受控、只读、与已登记测试数据 ID 绑定的查询命令实际输出。

任意 `echo`/`printf`、自由文本命令或仅复述结论的输出不能成为合格清理证据。Runner 可以选择已登记数据 ID 和 allowlist 内的查询操作/参数，但不能提供响应正文。Harness 在工具/adapter 返回时捕获真实 payload，完成 Secret 脱敏后把可审核内容及其 metadata 写入 evidence；每条至少记录：来源工具/adapter ID、当前 Run ID、测试数据 ID、查询时间、HTTP 状态码或进程退出码、脱敏后内容摘要和 SHA-256。文件名、类型、大小、路径和响应脱敏继续受当前 Run Evidence Store allowlist 约束。Playwright MCP 直接产生的删除后截图仍可作为图像证据。

`submit_test_data_cleanup_claim` 只能引用上述 Harness 生成的 evidence ID 或受控 Playwright 截图 ID；`cleanup_test_data` 不再在没有真实 adapter 时假称统一删除。

### 5.3 场景结束和 Run 结束

- Runner 在每个创建数据的场景结束前执行删除、保存删除后核验证据并提交 cleanup claim；
- Runner 结束后，Harness 可以先让受控 adapter 对 pending 条目兜底删除和独立核验；其余 claim 交给 Reviewer 读取证据并确认；
- Reviewer 完成后、Main · 最终汇总前，Harness 对全部登记项做最终核对；任何仍为 registered、cleanup-claimed、被 Reviewer 拒绝或 adapter 核验失败的项目都加入 blocking reason；
- 最终结果必须 blocked，execution/report 列出脱敏残留 ID、声明/核验状态和原因；
- 没有登记数据或全部 `verified-cleaned` 时，默认生产配置可以正常完成，不要求虚假的空清理 adapter；
- 本变更不开放网站任意清理命令、任意数据库写入或目标项目脚本路径配置。

## 6. 当前场景与实时进度

Gateway 内存是当前 Run 状态的 owner，不在每一步写 SQLite。

Runner 在执行前声明本次实际执行顺序，Harness 验证场景 ID 来自 Main 计划/当前工作场景；然后通过受控工具更新：

- 总场景数；
- 已完成场景数；
- 当前场景 ID 和名称；
- 场景开始/完成的脱敏活动和更新时间。

建议工具契约为：

```text
begin_scenario_execution(scenario_ids[])
start_scenario(scenario_id)
finish_scenario(scenario_id)
```

确切函数名可由实现选择，但必须满足：不能开始未声明场景、不能重复完成、完成数不能超过总数、零场景显示 `0/0` 且当前场景为空。初始化侦察没有正式候选场景时显示阶段活动而不是伪造场景。

进度只用于真实可观察状态，不替代最终 `report.md` 的场景结果。Agent 异常时保留最后一次活动并进入现有失败/interrupted 流程。

## 7. Main Planning 的历史 Run 查询

在现有 Run Store/Recovery Store owner 上增加 Main Planning 专用只读查询，不建立第二份历史源。

查询默认返回有限、脱敏摘要，每条可包含：

- run-id、status、result、trigger、request 摘要；
- base/target/included commits、开始/结束时间；
- scenario results、confirmed bug 标识、Issue URLs；
- scenario PR URL；
- report/scenario/archive 状态和脱敏错误；
- initialization、special blocked、interrupted 标记。

Main Planning 的 `query_run_history` 支持按当前 commit 范围、场景 ID、Issue/bug key 和最近数量筛选；默认上限 20，硬上限 100。

Main Finalization 不依赖尚未生成的 `confirmed_bugs` 预注入摘要，而获得独立的受限只读工具：

```text
query_issue_candidates({
  title?: string,
  keywords?: string[],
  bug_key?: string,
  limit?: number
})
```

输入契约：

- `title`、非空 `keywords`、`bug_key` 至少提供一个；全部 trim 后校验，不接受控制字符；
- `title` 最长 200 字符；`bug_key` 最长 128 字符；`keywords` 为 1–8 个去重字符串，每项 2–64 字符；
- `limit` 是 1–100 的整数，默认 20；
- 匹配前统一 Unicode NFKC、转小写并折叠空白；bug key 精确匹配优先，其次是规范化标题精确/互相包含，再按关键词在 Issue title、StoredRunIssue title/bug key 中的命中数匹配；
- 去重后稳定排序：exact bug key、exact title、关键词命中数降序、Issue `updatedAt` 降序、Issue number 降序；相关 Run 按 finishedAt 降序、run-id 降序。

结构化返回固定为：

```text
{ status: "ok", candidates: [...] }
{ status: "empty", candidates: [] }
{ status: "unavailable", candidates: [], message: "脱敏原因" }
```

`ok` 只能用于非空结果；`empty` 只表示查询成功但无匹配；依赖失败必须是 `unavailable`。candidate 可以包含 Issue number/title/url/state、匹配原因/bug key，以及关联 Run 的 run-id/result/scenario IDs/target commit；不返回完整工件、模型对话、测试账号、Secret 或未脱敏工具参数。

使用顺序和反循环边界：

1. Main · 最终汇总先读取本次 `draft-report.md`、`review.md` 和其他允许工件，自行形成一个或多个 Bug 候选；
2. 再按每个候选调用工具；一个 Main Finalization Session 最多调用 10 次；同一规范化查询只有首次结果为 `unavailable` 时可以重试一次，`ok`/`empty` 不得原样重复查询；
3. 第二次 unavailable 或总预算耗尽后记录覆盖缺口并继续最终汇总，不能循环调用，也不能把 unavailable 当 empty；
4. 工具只读，不能创建、修改、关闭或评论 Issue；最终 create/link 决定仍由 Main · 最终汇总写入 `report.md`，后续受控 Issue owner 执行；
5. 不增加 Reviewer 结构化 Bug 输出、中间状态文件或新的长期事实源。

Main · 规划只获得 `query_run_history`；Main · 最终汇总只获得 `query_issue_candidates`；Runner 和 Reviewer 两者都没有。SQLite/GitHub 查询失败与“成功但无候选”必须区分，失败时对应 Main 记录覆盖缺口，不能当作空结果。

## 8. 验收分层和命令语义

### 8.1 三层证明

| 层级 | 目的 | 是否允许外部 Secret | 是否可单独声明发布完成 |
|---|---|---:|---:|
| 单元/组件回归 | 验证确定性规则、错误和边界 | 否 | 否 |
| 本地生产路径集成 | 真实调用 `createAgentSession()`、资源装载和工具循环；外部 Git/HTTP/S3 可使用临时服务 | 否 | 否 |
| live 联合验收 | 真实 GitHub、Provider、Pi、Playwright MCP、OSS、非生产应用和账号 | 是，由操作者本地提供 | 是，且必须全部通过 |

本地生产路径集成不能再用 FixtureSessionFactory 代替 Pi Session factory。可以使用本地可控模型协议服务使输出确定，但必须真实经过 Pi SDK 的 Session、模型消息、custom tool 调用、内置角色指令 system prompt 和 dispose。

local 至少证明两类生产流程：

1. 普通 Run：Main Planning Session → Runner Session → Reviewer Session → Main Finalization Session，四个 Session 独立创建和 dispose，并产出五个 Markdown 工件；
2. 陌生项目初始化：Main Planning Session 静态勘察 → Runner Session 运行时侦察 → **新的** Main Planning Session 候选综合 → **新的** Runner Session 候选验证 → Reviewer Session → Main Finalization Session。

初始化还必须分别覆盖：

- **直接新增并验证**：执行上述完整六 Session 序列，候选综合产生可直接应用的新场景，新的 Runner Session 执行候选验证，之后 Reviewer 和 Main Finalization 均运行；
- **需要场景 PR 时立即 blocked**：固定执行 Main Planning 静态勘察 → Runner 运行时侦察 → **新的** Main Planning 候选综合，共三个真实 Agent Session；策略判断候选 patch 需要人工审核后立即结束，不创建候选验证 Runner、Reviewer 或 Main Finalization Session，不执行未审核场景，也不等待人类；Harness 确定性生成特殊 blocked `report.md`，Archiver 随后创建场景 PR；
- **特殊 Run 工件**：最终持久化工件严格只有 `scenario-changes.patch` 和 `report.md`；`plan.md`、`execution.md`、`draft-report.md`、`review.md` 对该特殊 Run 标记为不适用。三个 Session 在 running workspace 产生的临时交接文件可以用于当次流程，但 `RunWorkspace.finalize({ specialScenarioReview: true })` 必须按两文件 allowlist 选择性完成，不能把整个 running 目录原样 rename 后让额外 Markdown 残留；completed artifact list 必须精确等于 patch + report，`isSpecialScenarioReviewRun()` 的两文件识别契约保持；
- **最终修订未重跑**：只适用于已经进入 Reviewer/Main Finalization 的直接新增验证路径；Main · 最终汇总按 Reviewer 意见修订尚未发布 patch 后，因修订内容没有新的 Runner Session 重新执行，结果必须保持 blocked。

直接新增路径中的多个 Main Planning Session 和多个 Runner Session 不共享完整对话，每个 Session 只获得自己的内置角色指令和受控工具；所有实际创建的 Session 都必须 dispose。

merge 冲突、归档失败重试、Indexer 暂时不可用、进程重启和队列恢复属于确定性本地验收：使用真实生产代码和本地 Git、HTTP、S3-compatible 服务完成，不要求在 live GitHub 或官网环境制造故障。

### 8.2 标准命令

最终提供清晰分开的命令；具体脚本名至少满足以下语义：

```bash
npm run test:acceptance:local
npm run test:acceptance:live
npm run test:acceptance:release
```

- `local`：不读真实凭据，CI 可稳定执行；只报告 local passed；
- `live`：缺少任一必需输入时输出具体 missing/blocked 列表并非零退出；不执行部分资源后把整体写 passed；
- `release`：先运行所有公共质量命令和 local，再运行 live；任何 failed 或 blocked 都非零退出；
- 可以保留 `npm run test:acceptance` 作为兼容别名，但必须明确指向 local，输出不能称为全量或 release acceptance。

### 8.3 报告

验收报告明确包含：

```text
local.status
live.status
release.status
resourceChecks[]
AC evidence[]
commands[]
```

每个 AC 的证据必须对应自身行为，不能只因共享 proof 分组为真就批量标记 passed。报告可以保存仓库 URL、commit、Run ID、PR/Issue URL、模型 ID、OSS object key 和截图文件名；不得保存任何 Token、Key、密码、Cookie、Authorization、短期签名 URL或模型隐藏推理。

## 9. Live 验收的人类输入契约

### 9.1 测试项目与 GitHub

默认目标：

```text
https://github.com/cynos-ai/cynos-website
```

项目负责人在 live 前确认或明确替换。目标必须可信、非罗网仓库并允许测试写入；live 的首次建分支用例开始时，已配置的 `scenario-testing` 必须不存在，且操作者确认可从指定初始 commit 创建。不能安全提供“分支不存在”前置条件时必须换用新的独立测试仓库，不能删除含有人类资产的既有分支来凑验收。Token 使用 fine-grained repository access，仅限该仓库：

| 权限 | 最小值 | 用途 |
|---|---|---|
| Metadata | Read | 读取仓库基本信息 |
| Contents | Read and write | clone/fetch、创建/推进场景测试分支、发布场景和报告 |
| Pull requests | Read and write | 场景审核 PR |
| Issues | Read and write | 创建/关联 confirmed bugs |

不要求 Administration、Actions、Packages、Deployments 或组织级权限。人类还需确认该测试身份可以在 ref 不存在时创建场景测试分支、之后执行 non-force push 或创建 PR，并允许验收结束后关闭明显测试 PR/Issue；长期验收证据是否保留由项目负责人决定。

### 9.2 非生产应用

必须提供：

- Base URL 和环境说明；
- 明确“不是生产环境、无真实用户数据”的确认；
- 至少一个可正常通过的 API/UI 流程；
- 两个相互独立、可逆、可分别复位的可控产品失败条件，用于同一 Run 产生两个不同 confirmed bugs；
- 一个可控环境/依赖阻塞条件及复位方式；
- 可创建、查询和删除 run-id 前缀测试数据的 UI/API，以及能独立证明删除后不存在的脱敏查询或截图；
- 允许访问的外部目标 allowlist；没有授权的邮件、支付、生产发布等副作用必须禁用。

### 9.3 账号

至少提供一个专用测试账号；多角色场景按需增加。每个账号只向 Runner 暴露，输入包括别名、角色、用户名和密码。不能使用个人账号、生产账号或真实用户凭据。live 结束后，人类确认账号继续保留还是轮换/撤销。

### 9.4 Provider 和模型

人类提供：

- Provider 标识和 API Key；
- Main 模型 ID、Runner 模型 ID、Reviewer 模型 ID；
- 各角色 thinking level；
- Reviewer 对图像输入的支持确认；
- 可接受的调用额度、网络出口和超时窗口。

默认可以沿用当前约定的 DeepSeek 文本/视觉模型，但 v0.7 不绑定单一厂商；真实验收以网站实际可解析、已认证的模型为准。

### 9.5 OSS

使用私有 S3-compatible bucket 和专用 prefix。输入包括 endpoint、region、bucket、object prefix、Access Key ID 和 Access Key Secret。凭据只允许在该 prefix 执行 put/get/head/delete/list（若实现检查确有需要）；不能授予整个账号的管理权限。live 必须证明上传、稳定读取、Reviewer 看图和测试对象删除。

### 9.6 候选实例和发布

候选实例需要：

- `LUOWANG_ADMIN_PASSWORD`；
- `LUOWANG_MASTER_KEY`；
- 可选 `LUOWANG_ALLOWED_ORIGIN`；
- 持久化卷、仅本地或非生产入口、访问 GitHub/Provider/OSS/样例应用的网络；
- `cynos-ai/luowang` 的 PR 和最终 tag 权限。

### 9.7 建议的本地 Secret 变量

实现 live runner 时使用以下稳定名称，或提供一一对应的受控配置文件；示例文件只能包含字段名和假值：

```text
LUOWANG_LIVE_REPOSITORY
LUOWANG_LIVE_INITIAL_REF
LUOWANG_LIVE_GITHUB_TOKEN
LUOWANG_LIVE_BASE_URL
LUOWANG_LIVE_TEST_USERNAME
LUOWANG_LIVE_TEST_PASSWORD
LUOWANG_LIVE_PROVIDER
LUOWANG_LIVE_PROVIDER_API_KEY
LUOWANG_LIVE_MAIN_MODEL
LUOWANG_LIVE_RUNNER_MODEL
LUOWANG_LIVE_REVIEWER_MODEL
LUOWANG_LIVE_OSS_ENDPOINT
LUOWANG_LIVE_OSS_REGION
LUOWANG_LIVE_OSS_BUCKET
LUOWANG_LIVE_OSS_PREFIX
LUOWANG_LIVE_OSS_ACCESS_KEY_ID
LUOWANG_LIVE_OSS_ACCESS_KEY_SECRET
```

thinking level、环境说明、额外账号和外部 allowlist 可以使用非 Secret 配置或 JSON 输入。所有 Secret 变量必须从子进程环境和报告中脱敏；CI 不保存这些值，fork PR 不运行 live。

## 10. 输入缺失和失败行为

| 情况 | 必须行为 |
|---|---|
| 内置角色指令缺失/错误 | Session 不启动，Run 明确失败或 blocked；不退回 Pi Skills 或 ambient 资源 |
| 普通 Run 指定任意 target | `400` 拒绝并提示固定分支入口 |
| 场景分支不存在但请求不是 `manual-merge-source + initialization=true` | 不创建分支和 Agent Run；automatic 不产生批次，current-head/非初始化 merge-source 明确失败 |
| 直接调用旧 `POST /api/repository/scenario-branch` | 不产生 Git 副作用，明确提示改用排队的 merge-source initialization 入口 |
| merge conflict/首次创建时远端历史不含 prepared/其他远端竞争 | 队列请求失败，不创建 Run、不推进、不自动改代码、不改用其他 HEAD，清理本地 internal ref |
| prepared 未发布且 internal ref 缺失/不匹配 | 请求失败，不重做 merge/建分支、不改变 target；若远端已包含 prepared 则按成功 push 恢复 |
| 数据只有 Runner 清理声明、Agent 自填文本、证据未受控/未读取、Reviewer 拒绝或 adapter 未确认 | Run blocked，列脱敏残留和核验状态 |
| Runner 没有场景 | 显示 `0/0`；是否 passed 仍执行既有零场景审核规则 |
| Run 历史或 Issue 候选查询失败 | 标记 unavailable，不伪装空历史/空候选 |
| local 通过、live 未配置 | local=passed、live=blocked、release=blocked，release 命令非零 |
| Provider/MCP/OSS/GitHub 任一 live 检查失败 | live failed/blocked，不发布 |
| 清理失败 | 保留证据和残留清单，不把 Run 或 release 写成 passed |

## 11. 兼容与迁移

- SQLite schema 变更使用版本化、可重复执行 migration；现有队列、Run 和归档数据必须前向升级；
- API 删除或拒绝 `targetCommit` 时更新网站和测试；如保留过渡字段，只能明确报错，不能继续执行旧的不安全语义；旧 `/api/repository/scenario-branch` 同样不得保留同步写分支语义；
- 已有 completed/、报告、Issues、场景 PR、last completed target 和 `v0.1.0` tag 不修改；特殊场景审核 Run 继续只以 patch + report 识别；
- `refs/luowang/merge-requests/*` 只存在于罗网本地持久 Git 仓库，不迁移为目标仓库分支、不写入远端；升级启动时只对账和清理没有对应请求的孤儿 ref；
- 内置角色指令资源属于罗网发布物，不是 Pi Skills，不写目标仓库；
- 本地 acceptance 结果命名变化要提供 README 迁移说明；
- 原生 `better-sqlite3` 在没有匹配预编译包时需要 `python3`、`make`、`g++`，README 优先推荐 Docker 并说明本地依赖。

## 12. 发布规则

1. README 在首个修复 PR 中先纠正当前状态，不等 live 完成后才修文案；
2. 所有实现先通过短期分支 PR 合入 `develop`；
3. live 前允许 `develop` 包含已完成的确定性修复，但不得创建发布 tag；
4. `npm run test:acceptance:release` 通过且证据可复核后，项目负责人选择下一个 SemVer；
5. 通过 `develop → main` PR 发布，tag 指向 main 的发布 commit；
6. `v0.1.0` 永远不移动、不删除、不重写。

## 13. 验收条件

1. **AC-CLOSURE-INSTR-01**：Main Planning、Runner、Reviewer、Main Finalization 四类 Session 只装载对应的罗网 Built-in Role Instructions；ambient Skills、Prompt、Context 和用户/宿主机/目标仓库资源不会进入 Session；配置仍只有 Main、Runner、Reviewer 三组；
2. **AC-CLOSURE-INSTR-02**：固定角色指令只进入 system prompt 一次，user message 只包含当前任务和角色裁剪的动态上下文；角色工具权限与上游安全边界不变；
3. **AC-CLOSURE-INSTR-03**：Role Instructions 内容包含证据优先级、代码不得反推期望、独立审核、清理、偏差和反模式，但没有引入 suite/catalog/checkpoint/新结果状态/发布 gate；
4. **AC-CLOSURE-MERGE-01**：人工 branch/tag/SHA 请求进入 FIFO；远端场景分支已存在时按顺序生成 `merge --no-ff` commit，尚不存在且 `initialization=true` 时把解析后的 source commit 作为 prepared；两者都先创建本地 `refs/luowang/merge-requests/<queue-id>`、持久化 `prepared_merge_commit`、non-force 发布、持久化同值 `resolved_target_commit`，并且只创建一个以该不可变 commit 为 target 的 Run；首次路径的 Run 保留 initialization，internal ref 从不推送；
5. **AC-CLOSURE-TARGET-01**：普通人工/API Run 不能直接指定任意 target；自动、人工和初始化 Run 的 target 都是远端场景测试分支历史上的不可变 commit；场景分支不存在时 automatic/current-head 不创建 Run，首次建分支不能在队列外发生；
6. **AC-CLOSURE-MERGE-02**：internal ref 保证普通 merge 和首次建分支的 prepared object 经重启、临时工作区清理和 Git GC 后仍可达；结合 `prepared_merge_commit`、`resolved_target_commit` 和唯一 Run 关联，使 merge 冲突、首次创建时远端不含 prepared 的竞争、push 前后重启恢复不重复 merge/建分支、不改用其他 HEAD、不改变本次 target、不创建错误 Run；请求 terminal 后幂等清理 internal ref；
7. **AC-CLOSURE-DATA-01**：Runner 可以登记并实际删除测试数据，但只有受控 adapter 独立核验，或 Reviewer 读取 Harness 直接捕获的 adapter/API/只读查询输出或 Playwright 截图并确认，才能成为 `verified-cleaned`；无 adapter 时全部经 Reviewer 确认的生产 Run 可以完成；
8. **AC-CLOSURE-DATA-02**：Agent 自填 evidence 正文/状态/摘要、纯 Runner 声明、未受控/未读取证据、Reviewer 拒绝、pending 或兜底核验失败都使 Run blocked；合格文本证据记录来源、Run/data ID、时间、状态码/退出码和脱敏摘要/hash，且 Secret 不泄漏；
9. **AC-CLOSURE-ACTIVE-01**：真实 Runner Run 在网站依次显示总数、当前场景、已完成数和脱敏活动；零场景、Agent 异常和初始化侦察显示正确；
10. **AC-CLOSURE-HISTORY-01**：Main Planning 可通过 `query_run_history` 查询有限历史 Run；Main Finalization 先读本次草稿形成 Bug 候选，再通过只读 `query_issue_candidates` 的受限 schema、稳定匹配/排序和 20/100 结果限制查询 Issue/相关 Run 并决定 create/link；返回严格区分 ok/empty/unavailable，同一 unavailable 最多重试一次且 Session 总调用不超过 10；Runner 和 Reviewer 无历史查询工具；
11. **AC-CLOSURE-PI-01**：本地生产路径集成从远端尚无 `scenario-testing` 开始，经 `manual-merge-source + initialization=true` 首次创建并只创建一个陌生项目初始化 Run；该 Run 用真实 `createAgentSession()` 覆盖 Pi 模型消息、内置角色指令、custom tool 循环、同角色 Session 对话隔离及每个 Session dispose；直接新增并验证走完整六 Session 和五个 Markdown 工件；场景 PR 路径只创建 Main Planning → Runner → 新 Main Planning 三个 Session，策略判断后立即 blocked，不创建候选验证 Runner/Reviewer/Main Finalization，special finalize 排除临时普通工件，最终只持久化 `scenario-changes.patch`、Harness 生成的 `report.md`，并被 `isSpecialScenarioReviewRun()` 识别；最终汇总修订未发布 patch 但未重跑时仍 blocked；普通四 Session Run 另行通过；FixtureSessionFactory 不能作为本 AC 证据；
12. **AC-CLOSURE-ACCEPT-01**：local、live、release 三种验收状态和命令分离；live blocked 时 release 非零，README 不再称其为全量完成；
13. **AC-CLOSURE-ACCEPT-02**：每个受影响 AC 有独立、可追溯证据，不能依靠一个粗粒度 proof 批量标记通过；
14. **AC-CLOSURE-LIVE-01**：真实 GitHub + Provider + Pi + Playwright MCP + 私有 OSS + 非生产应用完成至少一个含 UI 截图和数据创建/清理的 passed Run；
15. **AC-CLOSURE-LIVE-02**：live 从真实目标仓库尚无 `scenario-testing` 开始，以 `manual-merge-source + initialization=true` 完成首次 non-force 创建、prepared/resolved 恢复事实和唯一初始化 Run；另外验证含两个 confirmed Bugs/Issues 的 failed Run、blocked 不推进、已有分支 merge-source、场景 PR、当前 HEAD 人工重测、正式报告、Indexer 回读和实时进度；
16. **AC-CLOSURE-SECRET-01**：所有 live Secret 只从受控输入进入候选实例/Secret Store，不出现在命令输出、环境回显、API 响应、日志、工件、Git、PR/Issue 或验收报告；
17. **AC-CLOSURE-DOC-01**：README 准确说明 Docker 优先、本地原生编译依赖、local/live 验收边界和实际发布状态；
18. **AC-CLOSURE-RELEASE-01**：全部验收通过后发布新的 SemVer，tag 与 main 发布 commit 一致，`v0.1.0` 保持原指向。
