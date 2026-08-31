# 罗网 v0.7 生产闭环补齐 Spec

- 状态：Implementation Baseline v0.1
- 关联 Intent：[intent.md](./intent.md)
- 实现计划：[plan.md](./plan.md)
- 上游规格：[罗网 Harness MVP Spec](../luowang-harness-mvp/spec.md)
- 权威设计：`罗网（LuoWang）场景测试 Harness 设计 · MVP Implementation Baseline v0.7`

## 1. 规格范围与优先级

本 Spec 只覆盖以下增量：角色工作方法装载、人工 merge 与固定 target、测试数据清理确认、实时场景进度、Main 历史 Run、验收分层、外部资源交付和后续发布。

发生冲突时：

1. v0.7 PDF 的产品和架构边界优先；
2. 本 Spec 是这些边界在当前代码上的增量解释，覆盖上游 MVP Spec 中同主题的旧实现说明；
3. 未被本 Spec 修改的认证、场景模式、归档、Issue、推进、Git allowlist、单实例和部署规则继续遵循上游 MVP Spec；
4. 实现 Agent 不能借“内部实现细节”改变本 Spec 的用户可观察行为。

## 2. 已确认的当前事实

实现以当前 `develop` 为起点，并把下列事实作为回归基线：

- 四个独立 Agent Session 和角色 custom tools 已存在，生产 Session 使用 Pi SDK；
- ambient extensions、Skills、Prompt Templates、Themes 和 Context Files 已关闭；
- 当前角色方法硬编码在 Orchestrator，完整提示词同时进入 system prompt 和首条用户消息；
- `/api/repository/merge` 直接执行 merge，`/api/runs` 接受任意 `targetCommit`；
- 默认 TestDataManager 没有清理实现，登记数据后无法确认已清理；
- `currentScenario` 和 `scenarioProgress` 只初始化、不随真实 Runner 更新；
- Run Store 已保存详细 Run，但 Main 上下文只包含正式报告摘要和 GitHub Issues；
- Phase 9 本地 acceptance 使用 FixtureSessionFactory，live smoke 只覆盖 GitHub 的有限路径；
- `v0.1.0` 已发布，必须保持不可变。

## 3. 内置 Role Skills 与 Prompt 组装

### 3.1 设计选择

罗网不使用 Pi 面向通用 Agent 的 ambient Skill 发现和“模型按需调用通用 read 加载 SKILL.md”机制。固定角色的方法每次都适用，应由应用在创建 Session 前确定性、完整加载。

罗网维护以下第一方、版本化 Markdown 资源：

```text
resources/agent-roles/
├── common.md
├── main-planning.md
├── runner-execution.md
├── reviewer-audit.md
├── main-finalization.md
└── scenario-initialization.md
```

这些文件称为 **Role Skills**，但它们不是目标仓库 `.pi/skills`，也不参与 Pi 的全局/项目自动发现。构建产物和 Docker 镜像必须包含它们；任一必需文件缺失、为空或不可读时，对应 Session 创建失败并给出不含本地敏感路径的明确错误。

### 3.2 Session 装载规则

| Session | 固定装载 | 条件装载 |
|---|---|---|
| Main A | `common.md` + `main-planning.md` | 初始化 Run 再加 `scenario-initialization.md` |
| 初始化候选 Main | `common.md` + `main-planning.md` + `scenario-initialization.md` | 无 |
| Runner | `common.md` + `runner-execution.md` | 初始化 Run 再加 `scenario-initialization.md` 中 Runner 相关段落或独立受控节 |
| Reviewer | `common.md` + `reviewer-audit.md` | 初始化 Run 再加必要的初始化审核规则 |
| Main B | `common.md` + `main-finalization.md` | 初始化 Run 再加 `scenario-initialization.md` |

实现可以在构建时把 Markdown 编译为模块，或在启动时从固定安装目录读取；无论采用哪种方式，生产 Session 获得的内容必须只来自当前罗网版本的 allowlist，不能接收 Agent 指定路径。

继续保持：

```text
noSkills = true
noPromptTemplates = true
noContextFiles = true
noTools = builtin
```

不得为了 Role Skill 开放任意 `read`。以后确有大型可选参考资料时，只能增加按逻辑名称映射到当前角色固定 allowlist 的 `read_role_reference(name)`；本变更不要求先实现该工具。

### 3.3 Prompt 分层

每个 Session 只发送一次固定方法：

```text
System Prompt
= 角色身份
+ common Role Skill
+ 当前角色 Role Skill
+ 可选初始化规则
+ 当前角色输出契约

首条 User Message
= 本次任务
+ 经过角色裁剪的动态 Run 上下文
```

禁止把同一完整角色说明同时放入 system prompt 和 user message。动态值不写入 Role Skill：run-id、请求、base/target/included commits、阻塞原因、历史摘要和证据引用都属于本次用户消息或受控工具结果。

### 3.4 角色动态上下文

- **Main A**：请求、trigger、base/target/included commits、场景模式、初始化标记、已索引场景摘要、历史报告/Run/Issue 查询能力；
- **Runner**：run-id、固定 target、计划、工作场景、非生产环境工具和 Harness 已确认阻塞原因；不直接注入历史 Issues 或 Git Token；
- **Reviewer**：run-id、固定 target、本次工件、证据引用和 Harness 阻塞原因；可以对已经读取的当前 Run 清理证据作结构化确认，但不获得目标环境命令、历史 Issue 列表、测试账号或任意仓库写入能力；
- **Main B**：固定 Run 范围、本次四个前置工件、Reviewer 结论、与 confirmed bugs 相关的已有 Issue 查询结果；不获得目标仓库通用读取和命令能力。

### 3.5 Role Skill 内容规则

从 `opc-aicom/.pi/skills` 只吸收适合 v0.7 的方法：

- 已确认规格和长期场景回答“应该是什么”；代码只回答“怎么调用”和“当前实际怎样”，不能用当前实现反推正确期望；
- Main 明确记录选择理由、证据优先级和覆盖缺口；
- Runner 不修改产品或场景，按顺序执行，记录实际观察、决定性/辅助证据、偏差、Secret 边界和清理；
- Reviewer 先看固定 Run/场景期望和原始证据，最后才看 Runner 草稿；Runner 报告是待审核假设，不是事实；
- 不影响验证目标的偏差可以记录后继续，影响前置、操作语义或断言的偏差必须 blocked；
- Main B 只根据已落盘事实和审核结论聚合，不发明执行事实，不回写旧结果；
- 每个 Role Skill 使用“目标、硬边界、顺序、输出契约、失败规则、反模式”的稳定结构。

明确不吸收 suite/catalog、长期能力图、多 checkpoint、审批 hash、workflow gate、大量状态 JSON、五状态、三轴结果、发布 gate、pi-subagents、自测和公共 OSS 规则。

### 3.6 可验证性

每个 Role Skill 固定逻辑 ID 和内容格式版本；运行/验收以 `逻辑 ID + 应用版本 + 内容 SHA-256` 标识实际装载版本。验收报告记录这些标识，但不创建新的 Run 状态文件。测试必须证明：

- 每个 Session 只装载自己的 Role Skill；
- ambient 用户/宿主机/目标仓库 Skill 即使存在也不会进入 system prompt；
- system prompt 不包含其他角色的专属规则；
- user message 不重复完整 Role Skill；
- 工具 allowlist 不因 Role Skill 改变。

## 4. 固定场景测试分支上的人工请求

### 4.1 请求种类

现有 SQLite FIFO 扩展为三种业务请求，不增加通用工作流状态机：

| 请求 | 输入 | 调度时行为 |
|---|---|---|
| `automatic-head` | Git/Cron 请求文本 | 使用调度时已计算的场景测试分支最新可测试 HEAD；仍允许自动请求合批 |
| `manual-current-head` | 人工/API 请求文本、可选 initialization | fetch 后固定当前远端场景测试分支 HEAD；人工请求不合并、不丢失 |
| `manual-merge-source` | 人工请求文本、`sourceRef`、明确确认 | 轮到时 fetch，`merge --no-ff` 到场景测试分支，non-force push，固定发布后的新 HEAD，再创建 Run |

队列可以增加明确的 request kind 和 `sourceRef` 字段；不得把 branch/tag/任意 SHA 继续伪装成可直接 checkout 的 `targetCommit`。

### 4.2 API 和网站行为

- 网站“合并 branch/tag/SHA”提交 `manual-merge-source`，返回 queue ID，不再同步返回已经完成的 merge；
- 普通 `POST /api/runs` 只提交 `manual-current-head`，不接受调用者指定 target commit；旧字段若保留兼容期，任何非空值必须被拒绝并提示改用 merge-source 或 Run 重测入口，不能静默绕过；
- 已有 Run 的“重测”复用原请求说明/场景意图，但在真正调度时固定**当前**场景测试分支 HEAD；本变更不提供分支已经前进后任意回放历史 SHA 的通用入口；
- 初始化请求同样只能针对当前场景测试分支 HEAD，或先通过 merge-source/首次建分支把来源纳入固定分支；
- API 响应和网站显示 queued、merge/running、waiting archive、completed/failed/interrupted 等现有事实，不增加跨 Run checkpoint。

### 4.3 合并失败与幂等

- `sourceRef` 无法解析、merge 冲突、远端竞争或 push 失败时，请求以明确失败结束，不创建 Agent Run、不修改产品代码、不推进 target；
- 来源已是场景测试分支祖先时不重复 merge，但仍可对当前远端 HEAD 创建本次人工 Run；
- merge 成功后记录 merge commit/场景分支 HEAD，并把该不可变 SHA 交给 Orchestrator；后续到达的新 commit 留给下一请求；
- 人工 merge 请求不参与自动请求合批；进程在 merge 后、Run 前退出时，恢复逻辑必须通过远端祖先检查重试，不能重复 merge 或丢失请求；
- 远端写入继续禁止 force-push。

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
2. Runner 使用受控 UI/API/命令工具删除并把“删除后不存在”的脱敏截图或查询结果保存到当前 Run evidence，Reviewer 实际读取该证据后，通过专用确认工具判定足以证明清理。

Markdown、自填字符串、任意 URL、没有被 Harness Evidence Store 管理的路径，或 Runner 单独调用“已清理”工具，都不能成为 `verified-cleaned`。

### 5.2 Runner 和 Reviewer 工具

Runner 获得：

- `get_test_data_prefix`；
- `register_test_data`；
- `submit_test_data_cleanup_claim`：只能为当前 Run 已登记 ID 提交清理声明，并引用一个或多个已存在、由当前 Run Evidence Store 管理的脱敏证据 ID；它只进入 `cleanup-claimed`；
- `list_pending_test_data`：只返回当前 Run 尚未 `verified-cleaned` 的脱敏条目。

Reviewer 获得 `verify_test_data_cleanup`：只能处理当前 Run 的 cleanup claim；对应 evidence 必须存在，并且 Reviewer 已通过受控 evidence reader 实际读取。Reviewer 可以确认或拒绝，不能执行删除、访问测试账号或提供任意证据路径。

需要支持脱敏文本查询结果时，Evidence Store 增加受限的文本 evidence 保存/读取能力；文件名、类型、大小和路径继续受当前 Run 目录 allowlist 约束。`cleanup_test_data` 不再在没有真实 adapter 时假称统一删除。

### 5.3 场景结束和 Run 结束

- Runner 在每个创建数据的场景结束前执行删除、保存删除后核验证据并提交 cleanup claim；
- Runner 结束后，Harness 可以先让受控 adapter 对 pending 条目兜底删除和独立核验；其余 claim 交给 Reviewer 读取证据并确认；
- Reviewer 完成后、Main B 汇总前，Harness 对全部登记项做最终核对；任何仍为 registered、cleanup-claimed、被 Reviewer 拒绝或 adapter 核验失败的项目都加入 blocking reason；
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

## 7. Main 的历史 Run 查询

在现有 Run Store/Recovery Store owner 上增加 Main 专用只读查询，不建立第二份历史源。

查询默认返回有限、脱敏摘要，每条可包含：

- run-id、status、result、trigger、request 摘要；
- base/target/included commits、开始/结束时间；
- scenario results、confirmed bug 标识、Issue URLs；
- scenario PR URL；
- report/scenario/archive 状态和脱敏错误；
- initialization、special blocked、interrupted 标记。

支持按当前 commit 范围、场景 ID、Issue/bug key 和最近数量筛选；默认上限 20，硬上限 100。默认不返回完整工件、模型对话、Secret、测试账号或未脱敏工具参数。

- Main A 可按需调用，用于影响判断和场景选择；
- Main B 只获得与本次 confirmed bugs 的 Issue 处理相关摘要；
- Runner 和 Reviewer 不获得该工具；
- SQLite 查询失败与“成功但无历史”必须区分，失败时 Main 记录覆盖缺口，不能当作空历史。

## 8. 验收分层和命令语义

### 8.1 三层证明

| 层级 | 目的 | 是否允许外部 Secret | 是否可单独声明发布完成 |
|---|---|---:|---:|
| 单元/组件回归 | 验证确定性规则、错误和边界 | 否 | 否 |
| 本地生产路径集成 | 真实调用 `createAgentSession()`、资源装载和工具循环；外部 Git/HTTP/S3 可使用临时服务 | 否 | 否 |
| live 联合验收 | 真实 GitHub、Provider、Pi、Playwright MCP、OSS、非生产应用和账号 | 是，由操作者本地提供 | 是，且必须全部通过 |

本地生产路径集成不能再用 FixtureSessionFactory 代替 Pi Session factory。可以使用本地可控模型协议服务使输出确定，但必须真实经过 Pi SDK 的 Session、模型消息、custom tool 调用、Role Skill system prompt 和 dispose。

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

项目负责人在 live 前确认或明确替换。目标必须可信、非罗网仓库、允许测试写入并有可清理的 `scenario-testing`。Token 使用 fine-grained repository access，仅限该仓库：

| 权限 | 最小值 | 用途 |
|---|---|---|
| Metadata | Read | 读取仓库基本信息 |
| Contents | Read and write | clone/fetch、创建/推进场景测试分支、发布场景和报告 |
| Pull requests | Read and write | 场景审核 PR |
| Issues | Read and write | 创建/关联 confirmed bugs |

不要求 Administration、Actions、Packages、Deployments 或组织级权限。人类还需确认场景测试分支保护允许该测试身份 non-force push 或创建 PR，并允许验收结束后关闭明显测试 PR/Issue；长期验收证据是否保留由项目负责人决定。

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
| Role Skill 缺失/错误 | Session 不启动，Run 明确失败或 blocked；不退回 ambient Skill |
| 普通 Run 指定任意 target | `400` 拒绝并提示固定分支入口 |
| merge conflict/远端竞争 | 队列请求失败，不创建 Run、不推进、不自动改代码 |
| 数据只有 Runner 清理声明、证据未受控/未读取、Reviewer 拒绝或 adapter 未确认 | Run blocked，列脱敏残留和核验状态 |
| Runner 没有场景 | 显示 `0/0`；是否 passed 仍执行既有零场景审核规则 |
| 历史 Run 查询失败 | 标记 unavailable，不伪装空历史 |
| local 通过、live 未配置 | local=passed、live=blocked、release=blocked，release 命令非零 |
| Provider/MCP/OSS/GitHub 任一 live 检查失败 | live failed/blocked，不发布 |
| 清理失败 | 保留证据和残留清单，不把 Run 或 release 写成 passed |

## 11. 兼容与迁移

- SQLite schema 变更使用版本化、可重复执行 migration；现有队列、Run 和归档数据必须前向升级；
- API 删除或拒绝 `targetCommit` 时更新网站和测试；如保留过渡字段，只能明确报错，不能继续执行旧的不安全语义；
- 已有 completed/、报告、Issues、场景 PR、last completed target 和 `v0.1.0` tag 不修改；
- Role Skill 资源属于罗网发布物，不写目标仓库；
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

1. **AC-CLOSURE-INSTR-01**：四类 Session 和初始化流程只装载罗网版本化的正确 Role Skill；目标仓库、宿主机和用户 ambient Skills 即使存在也不会进入 Session；
2. **AC-CLOSURE-INSTR-02**：固定方法只进入 system prompt 一次，user message 只包含当前任务和角色裁剪的动态上下文；角色工具权限与上游安全边界不变；
3. **AC-CLOSURE-INSTR-03**：Role Skill 包含证据优先级、代码不得反推期望、独立审核、清理、偏差和反模式，但没有引入 suite/catalog/checkpoint/新结果状态/发布 gate；
4. **AC-CLOSURE-MERGE-01**：人工 branch/tag/SHA 请求进入 FIFO，按顺序 `merge --no-ff`、non-force push，并只测试新 `scenario-testing` HEAD；已包含来源不会重复 merge；
5. **AC-CLOSURE-TARGET-01**：普通人工/API Run 不能直接指定任意 target；自动、人工和初始化 Run 的 target 都是远端场景测试分支上的不可变 commit；
6. **AC-CLOSURE-MERGE-02**：merge 冲突、远端竞争、重启重试不修改产品代码、不重复 merge、不创建错误 Run、不推进；
7. **AC-CLOSURE-DATA-01**：Runner 可以登记并实际删除测试数据，但只有受控 adapter 独立核验，或 Reviewer 读取 Harness 管理的删除后证据并确认，才能成为 `verified-cleaned`；无 adapter 时全部经 Reviewer 确认的生产 Run可以完成；
8. **AC-CLOSURE-DATA-02**：纯 Runner 声明、未受控/未读取证据、Reviewer 拒绝、pending 或兜底核验失败都使 Run blocked，报告显示脱敏残留和核验状态且 Secret 不泄漏；
9. **AC-CLOSURE-ACTIVE-01**：真实 Runner Run 在网站依次显示总数、当前场景、已完成数和脱敏活动；零场景、Agent 异常和初始化侦察显示正确；
10. **AC-CLOSURE-HISTORY-01**：Main 能按需查询有限的正常、特殊 blocked、interrupted、场景 PR 和归档失败摘要，并区分空历史与查询失败；Runner/Reviewer 无该权限；
11. **AC-CLOSURE-PI-01**：本地生产路径集成真实经过 `createAgentSession()`、Role Skill system prompt、模型消息、custom tool 循环和 dispose，不由 FixtureSessionFactory 代替；
12. **AC-CLOSURE-ACCEPT-01**：local、live、release 三种验收状态和命令分离；live blocked 时 release 非零，README 不再称其为全量完成；
13. **AC-CLOSURE-ACCEPT-02**：每个受影响 AC 有独立、可追溯证据，不能依靠一个粗粒度 proof 批量标记通过；
14. **AC-CLOSURE-LIVE-01**：真实 GitHub + Provider + Pi + Playwright MCP + 私有 OSS + 非生产应用完成至少一个含 UI 截图和数据创建/清理的 passed Run；
15. **AC-CLOSURE-LIVE-02**：live 另外验证 failed、多 Issues、blocked 不推进、merge-source、当前 HEAD 人工重测、归档幂等、Indexer 回读和实时进度；
16. **AC-CLOSURE-SECRET-01**：所有 live Secret 只从受控输入进入候选实例/Secret Store，不出现在命令输出、环境回显、API 响应、日志、工件、Git、PR/Issue 或验收报告；
17. **AC-CLOSURE-DOC-01**：README 准确说明 Docker 优先、本地原生编译依赖、local/live 验收边界和实际发布状态；
18. **AC-CLOSURE-RELEASE-01**：全部验收通过后发布新的 SemVer，tag 与 main 发布 commit 一致，`v0.1.0` 保持原指向。
