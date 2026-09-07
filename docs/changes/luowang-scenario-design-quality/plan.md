# 场景维护与初始化质量改进 Plan

- 日期：2026-09-05
- 状态：两轮 Qwen 矩阵已运行；工程反馈修复有效，但关键变化覆盖仍有缺口；按用户授权仅做专项修订与复评
- 依据：[intent.md](./intent.md)、[spec.md](./spec.md)

实施分支证明（2026-09-05）：分支为 `feat/scenario-design-quality`，基于
`develop@09dbed0`；实现提交为 `9e41cf5`，已通过 PR #56 合入 `develop`，merge commit 为
`11ea774`。在实现开始前，当前分支的
`git ls-tree -r --name-only HEAD docs/changes/luowang-scenario-design-quality` 已列出且追踪以下三份文档：
`intent.md`、`spec.md`、`plan.md`（文档提交为 `38ba5bf`、`2bac167`）。

## 审核修复（2026-09-06）

原 Phase 0–4 的通过记录只证明当时测试集合，不能覆盖审核发现的四个缺口：rename 旧端敏感内容绕过、初始化 approved 候选漏执行仍通过、特殊报告丢失计划摘要、固定版本文件没有 32 KiB 分页。

修复分支：`fix/scenario-quality-gaps`（起点 `develop@efef55e`）。修复与回归范围：

- Main diff 执行边界检查变更两端路径/类型；普通修改保留旧路径和 mode，Git diff 使用 literal pathspec。
- 初始化执行前校验 patch 新增/内容修改的 approved 场景全部入选；draft 和未变更已有场景不全选，字节不变 rename 不强制重跑。
- 特殊两工件报告保留同一计划中的候选/缺口摘要，复用脱敏规则并过滤原始 diff、代码块、地址和本地路径；不扩大工件 allowlist。
- base/target 文件均使用 32 KiB UTF-8 分页，游标绑定固定提交、版本和路径。

实际验证（退出码均为 0）：format、typecheck、lint、25 个测试文件的 153/153 单元/集成测试、build、headless E2E 及 `test:acceptance:local` 通过。local 输出为 `local=passed, live=blocked, release=blocked`。新增回归覆盖敏感 rename 双向访问、新增/修改 approved 漏选拒绝、draft 排除、特殊摘要保留/脱敏/截断及 UTF-8 文件分页与跨版本/路径/commit 游标拒绝，已纳入对应 local AC 专项。

本轮使用既有 Docker `quality` 镜像 `luowang:0.3.1-quality-candidate`（`11c930d63cb2`），只读挂载修复后的源码、测试、角色资源、文档、package.json 和 CI workflow。已核对镜像与当前 lockfile SHA-256 均为 `46406eef352d638790d8537d4c3cd72fe58acf108be6800326266903b2c71281`；不是宿主机 Chromium 验收，也不将其冒称新版本镜像构建证明。原样新建 quality 镜像曾因 npm 镜像下载 ECONNRESET 受阻，未记为通过。

命令日志保存在本机 `.cynos/acceptance/sdq-review/fix-quality.log`、`fix-acceptance.log`；未运行真实模型或外部官网写入。本次证明仅关闭上述四项工程缺口，不宣称 Phase 5 已完成或真实模型质量已提升。

## 真实模型反馈修复（2026-09-06）

用户授权使用 Pi 中显式选择的 `aliyun-coding-plan/qwen3.7-plus`，Thinking off，仅作离线设计比较，不加载用户扩展/Skills，不切换按量接口或发布目标仓库。首轮冻结 `09dbed0` / `d5c4d00` 两版本和 `cynos-ai/cynos-website@46f971a65b9a28a4961ee7f9bfbf27eb21ca8be7` 派生夹具，完成 72 次 Session 尝试（893 次请求）；此前 pilot 单独保留。初始化使用固定合成侦察，Reviewer 使用明确标记的合成证据，不代表现场官网测试。

原始汇总为 58 completed / 14 failed，但不等于质量通过率：两例请求超时后恢复产出仍被驱动标为 failed；新版 17 个 completed 普通规划中五例有 draft/deprecated 清单或无效 patch。12 个初始化尝试均未形成可信完整交接；新版 Reviewer 有一次必需覆盖错误放行和一次提前读取草稿。完整日志、冻结规则及 109 次本地 patch 重放、24 份新版计划检查见 `.cynos/acceptance/sdq-evaluation/{full-output,audit}/`，不改写旧结果，独立人工最终评分仍未运行。

修复分支 `fix/scenario-quality-feedback` 从最新 `origin/develop@d5c4d00` 建立，范围为：

- 完整五字段示例、ID/状态语义、完整 patch 与末尾换行约定，以及限长/不泄露 stderr 的校验提示。
- Main 在同一 Session 内最多两次接收联合校验反馈；复用既有 patch、工作树和执行清单 validator，结束清理临时应用，不增加角色或 Session。
- Reviewer 工具约束计划/原始图片/草稿顺序，图片失败保留 blocked；明确执行清单不能豁免本批必需覆盖。
- 评测驱动区分请求恢复、角色终态、工件检查、质量判断；拒绝的读取请求不算实际读到内容，旧结果及失败全部保留。

本轮工程验证：Docker quality 镜像中 format/lint/typecheck 及 26 文件 162/162 tests 通过；local acceptance（包含 build、headless E2E、生产 Pi 专项）通过，live/release 仍 blocked。最终证据为 `.cynos/acceptance/sdq-evaluation/audit/fix-release-check.log` 和 `.cynos/acceptance/sdq-feedback-quality/2026-09-06T15-25-43-681Z-local/report.json`，该 acceptance 覆盖 162-test 全量回归、联合修正反馈、Reviewer 顺序约束及评测状态分类。测试使用 lockfile 匹配的既有 quality 镜像并挂载当前发布源码/测试/角色资源/文档/CI，不冒称已构建新镜像。宿主机缺少 SQLite native binding，因此最终以容器结果为准；初次挂载遗漏 CI workflow、误把被忽略评测脚本纳入 lint 的失败日志也保留。

Qwen 复评在工程回归后冻结新 commit，沿用 `full-manifest.json` 的 12 类夹具、评分规则、原始基线 `09dbed0`、模型和 Thinking，每例每版三次。结果另存 `retest-output/`，不修改首轮 `full-output/`；本轮请求上限 1200、单例 24，遇额度/权限错误停止，不切按量接口。复评驱动及状态分类单测分开记录请求恢复、角色终态、工件有效性和被拒绝读取；独立人工质量评分仍待完成，不把修复后的模板示例或评分答案注入夹具，也不预先宣布质量验收通过。

## 关键变化直接覆盖专项（2026-09-07）

前次修复 `a1bdd68` 的矩阵已结束：72 次尝试、877 次请求，新版 36/36 Session 完成、24/24 规划结构有效，旧版有四次初始化预算/超时失败。新版 Reviewer 12/12 实际读取顺序合规、必需覆盖遗漏 3/3 阻塞。但语义复核发现：持久化案例 3/3 未安排有效期直接验证，废弃案例 2/3 未验证新的拒绝行为。证据为 `.cynos/acceptance/sdq-evaluation/audit/retest-findings.md`，不能用结构有效替代质量通过。

用户本轮明确要求“做完先做专项测试，别做全量”。在现有修复分支继续修改 Main/Reviewer 内置规则及相应 Spec/测试，不新增模型配置、工件、机器 schema 或语义 gate：

- 对关键变化建立规格依据、新旧行为、具体断言、决定性证据与缺口的对应，使用旧行为反事实检查，防止一般回归冒充变化验证。
- 参数/时间/状态与能力废弃按契约判断；必要控制能力不可用时保留阻塞，不用宽泛非目标豁免明确规格。
- 保持重构/已有 Bug 回归的语义复用和稳定 ID，不强制新增，不向角色指令注入具体夹具答案。

验证仅运行角色资源装载、反馈/读取边界及普通四 Session 生产 Pi 专项；格式/lint 只检查修改文件。不运行全量 unit、build/E2E/local acceptance 或另一次全量模型矩阵。真实 Qwen 专项仅取既有冻结的 `persistence`、`deprecation`、`refactor`、`bugfix` 四类，分别代表两类修复及两个防过度维护对照，每版三次，共 24 个新 Session。增量基线使用 `a1bdd68`（不再将更早的 `09dbed0` 当成本轮对照）；新旧应用、夹具、评分规则与代码 hash 在调用前冻结，旧输出不复用。请求上限 480、单例 24、单例 300 秒，模型/Thinking/输出限制和选定 Coding Plan 凭据策略不变，HTTP 额度/权限错误停止，无按量接口回退。新工件另存 `.cynos/acceptance/sdq-evaluation/targeted-output/`。

本地专项已通过：修改文件 format/lint、角色资源装载 4 项、反馈/读取边界 8 项、普通四 Session 生产 Pi 1 项（该文件其余 10 项按名称筛选跳过），合计 13 项通过。日志为 `.cynos/acceptance/sdq-evaluation/targeted-audit/local.log`，使用 lockfile 匹配的既有 Docker quality 镜像并只读挂载当前源码/资源/测试。新断言只证明规则进入对应生产 Session，不冒充模型语义质量证明。Qwen 专项待冻结提交后运行；独立人工总评分和完整 Phase 5 验收仍未完成。Reviewer 本轮只有受影响资源交付与权限/顺序的本地专项，不冒称已经重跑其全部真实模型质量对比。为遵守不做全量的要求，本轮提交先保留本地，不推送以触发现有 PR 的全量 CI。

## 专项反馈第二次修订（2026-09-07）

`68aeb6d` 对 `a1bdd68` 的四类专项已完成：24/24 Session、300 次请求、24 份计划结构有效。全部 24 份计划和 8 份 patch 已作助手技术复核，记录在 `.cynos/acceptance/sdq-evaluation/targeted-audit/findings.md`；不是独立人工最终评分。新版有效期仍漏客户端有效期/旧会话语义，废弃案例一次未保留 deprecated 历史，Bug 修复三次将旧会话直接验证降为实现细节，因此专项不能判通过。

用户同意继续修订，仍只做专项：消除 ID 复用与废弃规则的优先级歧义；明确复用不能弱化主体/凭证/状态/操作；按断言分别核对时间控制、元数据读取、即时响应证据和前置能力。只改 Main/Reviewer 内置规则、关联规格及生产 Session 资源交付断言，不新增机器 gate，不把具体夹具答案注入规则。

沿用相同四类、两版各三次和冻结 rubric，新的增量基线为 `68aeb6d`，候选在本地专项后冻结。第二次专项使用独立 `targeted2-output/`，上限仍为 24 Session / 480 请求，单例 24 请求/300 秒；不复用旧结果、不更换 Provider、不切按量接口，不运行全量或额外真实 Reviewer 矩阵，也不推送触发全量 CI。本地验证已通过前次相同的 13 项专项及修改文件格式/lint，证据为 `.cynos/acceptance/sdq-evaluation/targeted2-audit/local.log`（同一文件中其他 10 项按名称筛选跳过）。生产 Session 断言只证明规则正确交付，真实语义效果待第二次专项；完成不等于质量通过。

## 六条写作原则下的角色指令整理（2026-09-07）

第二次专项 `a1e53ce` 对 `68aeb6d` 已完成 24/24 Session、317 次请求；助手复核全部 24 份计划与 11 份 patch，仍有旧会话验证豁免、有效期覆盖遗漏和计划不一致，不能判质量通过。证据为 `.cynos/acceptance/sdq-evaluation/targeted2-audit/findings.md`，独立人工评分仍未运行。

用户确认通用六条写作原则后，要求据此整理各角色。沿用当前未完成变更，重组全部六份资源：共同规则集中、职责目标先行、在自然决策点解释因果与可行路径；保留权限、四/六 Session 隔离、读取顺序、结果聚合及全部机器工件协议。不引入 Skills、运行时依赖外部规则文件、新字段或新 gate。生产 Pi 测试改为验证完整角色资源只注入一次且不串角色，而非用禁止句数量或关键词声称质量。

本地专项已通过：角色装载 4 项、反馈/读取边界 8 项、生产 Pi 普通与初始化交接 11 项、角色文档结构 1 项，合计 24 项；结构测试文件其余 12 项按名称筛选跳过。修改文件 format/lint 通过，日志为 `.cynos/acceptance/role-principles-rewrite/local.log`。沿用 lockfile 匹配的既有 Docker quality 镜像并只读挂载当前源码/资源/测试/文档。不运行全量、构建、E2E、local/live acceptance、真实模型或推送；此次只证明资源与交接兼容，真实模型效果仍待后续专项验证。

## 整理后的专项与全量验证授权（2026-09-07）

用户授权先做受影响专项，完成后直接继续全量。冻结整理前 `a1e53ce` 与本次整理后提交；四类规划专项沿用相同夹具及三次重复，随后补 Runner/最终汇总的离线角色案例，并完成八类规划、四类 Reviewer 的完整比较和 Docker 全量工程检查。专项中的相同固定输入输出可计入同一轮完整矩阵，避免重复调用；新增角色案例单列，不冒充原有矩阵或真实官网闭环。

继续使用已选定的 Qwen Coding Plan、Thinking off 与隔离生产 Session；仅替换离线依赖，不开放网络、命令或发布副作用。完整模型矩阵及补充案例合计最多 1400 次请求，单 Session 最多 24 次/300 秒，配额或鉴权错误停止。所有版本、输入、调用、失败及语义复核分别记录；专项完成后全量可以揭示更广风险，不代表专项自动通过。工程检查和模型效果分开报告，独立人工评分、live、发布与推送不包含在本轮授权中。证据保存在 `.cynos/acceptance/sdq-evaluation/principles-*` 与 `.cynos/acceptance/role-principles-full/`。

## 场景集、实际执行与报告导向的指令修订（2026-09-07）

用户确认：通过实际执行确认场景所描述的功能符合预期，而不是追求形式化证明或穷尽所有可能。本轮在既有六份角色资源中优化通用方法，不写入具体夹具答案：Main 围绕业务流程查漏、去重和澄清步骤；初始化不再以少量为目标；Runner 核实执行条件、检查实际预期，允许等价操作而不改写测试含义；Reviewer 检查重要漏测、执行与报告真实性，不扩大需求；最终 Main 汇总已有结果，不重复分析。共同目标与未知能力处理集中在 common，减少证明链和重复专门规则，保持权限、读取顺序、清单、清理和结果协议。

只改角色资源、相应 Spec 和一处随文案变更的结构测试锚点，不新增字段、工件、角色、工具或环境权限。能力信息不足仍是待确认条件，不声称本轮已解决运行时上下文问题。既有 `73380ad` 冻结评测及输入不修改，其结果不能作为本版效果证明。

本地专项已通过：角色装载 4 项、反馈/读取边界 8 项、生产 Pi 普通及初始化交接 11 项、文档结构 1 项，共 24 项；另 12 项按名称筛选跳过。使用既有 Docker quality 镜像只读挂载本版源码、资源及测试，关闭容器网络；修改文件格式检查、测试文件 lint 和 diff 检查通过。日志为 `.cynos/acceptance/scenario-workflow-rewrite/local.log`。本版未运行新增真实模型评测、全量工程验收或外部测试，未推送、发布；专项仅说明资源交付及交接兼容，不代表场景质量改善。

## 新版校准专项准备（2026-09-07）

用户同意继续校准并推进下一轮专项，按已说明的 40 Session / 800 请求总上限准备，先运行四类规划 × 两版本 × 两次，共 16 Session，预留 24 Session 给通过/失败/阻塞三类四角色串联。基线使用 `73380ad`，本版本地冻结后比较，不推送或发布；保留相同 Coding Plan、Thinking off、单 Session 24 请求/300 秒及失败停止策略。完整三次重复矩阵与独立人工评分不由此替代。

上一版已收齐 80 次尝试、957 请求，79 completed / 1 failed；基线一例初始化候选超时后 patch 无效，新版 40/40 完成。全量 local 工程通过，但已复核内容存在语义问题，其余语义复核仍待完成，不能宣称整体质量通过。最终版本/夹具/80 个隔离工作树核验记录见 `.cynos/acceptance/sdq-evaluation/principles-audit/final-execution-checks.json`。

校准发现旧规划夹具未包含官网已有测试与依赖信息；新旧两版统一补齐固定来源的相关文件，保留原变更语义与含糊场景作为诊断题。未确认能力允许待确认/阻塞，不把 patch 数量当作覆盖结论。隔离 API 执行预检使用同源且 lock 匹配的既有 website quality 镜像：正确版本原有测试 4/4 通过，已知缺陷版本 3/4 通过并确实出现原会话重放 200≠401；生产命令执行器也已验证正确版本 4/4。此为助手环境预检，不是模型执行成果，也不证明 UI 已测试。串联仍须完整接入生产角色、命令和清理边界后才能启动，不以预设成功或 API 测试替代 UI 操作。校准与预检说明位于 `.cynos/acceptance/scenario-workflow-rewrite/`，旧轮输入和输出不修改。

### 专项中发现的动态任务文案遗漏

`73380ad → 19bb136` 规划专项运行中，复核实际 Session 输入发现：初始化候选 Main 的资源已写“不以少量为目标”，但 `initializationCandidateUserMessage` 仍要求“形成少量高价值候选场景”，新版输出也引用旧说法。这是上次修改漏掉的阶段注入点，不把该差异简单归为模型未遵守。当前 16 Session 继续使用原冻结快照，输入和结果不改；后续版本结果不得与本轮混称同一候选。

工作区只将该任务句改为“整理项目所需的候选场景并更新验证计划”，不复制共同规则或扩大阶段职责。生产 Pi 六 Session 测试补查候选阶段实际 user prompt：修复前能复现失败，修复后连同角色装载、反馈/读取边界共 23 项通过，修改文件 lint/format 通过。证据为 `.cynos/acceptance/scenario-workflow-rewrite/dynamic-task-{before,after}.log`。只证明交付一致性，尚未用真实模型验证此修正；不追加模型调用或推送。

用户进一步明确：尽可能全面不等于绝对穷尽；“核心测试用例”只是场景集中以既有 `core` 标签标记的部分，不是只生成少量核心场景。工作区同步动态任务、规划标签说明、初始化结束条件及 Spec，移除初始化现行指令中的“高价值”取舍措辞，不增加字段、类型或循环流程。本轮正在运行的 `19bb136` 快照保持不变；这些后续修订另行验证，不混用模型成绩。

### 规划专项收尾与最新完整提示词检查

用户本次只授权完成剩余输出复核和最新版本检查/冻结，不启动串联。本轮 `73380ad → 19bb136` 四类两次重复已完成 16/16 Session、246 请求、16 份有效规划；助手已读完 16 份 plan 与 6 份 patch，并核验 16 个隔离固定工作树、159 个夹具文件、154 个应用快照和 3 个侦察工件 hash。重构保持无无谓维护；退出修复部分计划明确原凭证方法；有效期仍有降级或取消必要验证，初始化仍有登录/错误凭据/页面流程遗漏、清理和步骤问题，未证明质量改善。完整复核与分层归因见 `.cynos/acceptance/scenario-workflow-rewrite/review/planning-findings.md`；独立人工评分仍未运行。

最新修正版检查覆盖实际 system prompt、动态阶段任务和输出协议，不只检查资源文件：通过本地生产 Pi 普通四 Session、直接初始化六 Session，捕获并核对 10 个实际 Session 输入，完整资源恰好加载一次、无串角色，旧“少量高价值”任务句消失，非穷尽目标与 core 标签含义一致。证据在 `.cynos/acceptance/scenario-workflow-rewrite/prompt-inspection/`。24 项本地专项及修改文件 lint/format/diff 检查通过，未做全量工程验收或新增真实模型调用。冻结只记录当前修正，不把本轮 `19bb136` 的结果移作新版本效果；环境能力和非 Main 语言上下文等已知限制另行保留，不顺手扩大实现范围。串联尚未启动，本轮预算消耗仍为 246 次真实请求。

### 串联前置补齐：原始命令结果交接

串联准备发现纯 API 命令结果只进入 Runner 工具返回，Reviewer 原有接口仅支持图片及清理文本。负责人已批准最小受控只读交接，范围为现有 evidence 存储、命令回调、Reviewer 工具与本地验证，不扩大任意路径/执行权限，也不新增正式工件或证明矩阵。

- Harness 自动捕获固定 Run/target 的命令结果或执行错误；脱敏后保存并返回 evidence ID，限制大小并标记截断。记录 ID 与捕获 hash 绑定，拒绝伪造、跨 Run、删除后隐身或内容篡改。
- Reviewer 经 plan/存在的 patch 后按需读取原始命令结果，不要求逐命令证明；图片与独立清理边界不变。保存、读取及上传故障不能由草稿通过掩盖。无 OSS 时保留本地原始记录，但不冒称发布成功。
- 新增命令证据边界测试，并在生产 Pi 本地协议中实际运行 `node --version`，由隔离 Reviewer 读取捕获的退出码、输出和固定版本信息；补充保存/上传失败的整链 blocked 检查。原有无证据上传依赖的正向夹具改用本地传输，不借此放宽产品规则。
- 日志保留在 `.cynos/acceptance/command-evidence/`，包括首次未扩展 Harness 文件名白名单、旧夹具缺少上传依赖及测试类型检查失败的原始记录。最终 `local-final/report.json` 为 local passed：174/174 单元与集成测试、format/lint/typecheck/build、E2E、Phase 9 和生产 Pi 专项全部通过；新增测试及生产 Pi 测试还完成独立 TypeScript 检查。live/release 仍 blocked，不以本地通过冒充真实模型或现场验收。

原始规划轮和已冻结 8c20c23 不改写。本次工程能力补齐需单独冻结；后续两版串联必须给予相同的命令执行/证据读取基础能力并记录版本差异，不能把新增工具能力归因为提示词改善。未新增真实模型调用，剩余预算仍为 24 Sessions / 554 请求，真实四角色串联仍未启动。

### 串联执行授权与 API 前置校准

负责人要求完成后续串联并持续监控至结束，Qwen Coding Plan 不再受剩余 24 Sessions / 554 请求总预算限制；仍不更换付费备用 Provider，不发布或操作共享环境，认证/额度错误停止。按原计划先完成三类结果、两版本的六条真实四角色链；安全超时与失败记录继续保留，不为追求全绿反复改写输入。

预检发现 `browserScenarioRequested` 把 API 登录、明确的非 UI 范围、`build`/`cynos-website` 字符子串误判为浏览器必需，导致无关阻塞。最小修复去掉登录即 UI 的推断、给英文术语增加词边界，并排除直接的否定范围表述；真实页面操作及必需但不可用的浏览器仍触发检查，不放开新工具或环境权限。原实现与新增断言的失败证据保留在 `.cynos/acceptance/linked-workflow/browser-before.*`；修复后全量 174 tests、lint/typecheck 通过，见 `browser-after.*`。两版在真实调用前同步该工程基础，不将工程检测改善归因为角色指令效果。

### 真实四角色串联收尾

六条串联已监控至全部结束：6/6 Run completed，24/24 独立生产 Pi Session completed/disposed，289 次 Qwen 请求，fatal null。三个请求级错误均在原 Session 恢复，无认证/额度错误。候选应用固定 `3b8d56e`；对照为原 `73380ad` 同步命令证据与 API/browser 修复后的离线评测提交 `9247996`，两版共享工程能力，原版本和旧成绩不改写。

正常代码两版均为 passed；移除服务端 logout 撤销的缺陷两版均为 failed（原 Cookie 请求实际 200≠401，删除账号场景仍 passed）；执行条件缺失两版均为 blocked，没有从静态代码推断通过。实际启动 9 个断网、只读、临时数据容器，另 3 次命令调用在不可用条件下拒绝。12 份原始命令记录全部被 Reviewer 读取，读取字节与存储对象一致；独立清理和最终 Run label 查询均无残留。无远端 Git/Issue/OSS 发布、无共享账号操作。

助手已复核全部 30 份 Markdown 工件、24 个实际 Session 输入、337 个输入/应用/驱动文件 hash 和六个固定干净工作树。结果分类正确不代表质量改善：candidate 缺陷例 Reviewer 先读 execution/draft 再读原始命令，原始证据优先为 2/3（baseline 3/3）；candidate blocked 最终报告未完整保留 Reviewer 对通用错误摘要的保留意见，并提出超出本轮约定的共享服务建议。candidate 两次不合格清理工具调用被边界拒绝，实际清理由 Harness 独立完成。baseline 两次测试名过滤器错误均恢复，但一例执行记录漏记首次失败。工程诊断信息被通用安全摘要压缩的问题与模型判断分别归因，不伪造未启动进程的退出码或 stdout。

最新候选完整工程验收 `engineering-clean/report.json` 为 local passed（174 tests、format/lint/typecheck/build、E2E、Phase 9 与生产 Pi 专项），official live/release 仍 blocked。原始调用、预检和挂载失败、完整复核及最终计数保存于 `.cynos/acceptance/linked-workflow/`，关键文件为 `manifest.json`、`live-output/summary.json`、`review/findings.md` 和 `review/post-checks.json`。第一次工程挂载把手动评测脚本纳入 lint，改为正式源码和独立输出目录后通过，未通过改产品规避失败。

本轮仅复验明确 API 场景，每版每条件一次；不能替代全面初始化/模糊场景、八类三次重复、独立人工或真实外部发布验收。六条链的执行与复核已经结束，不为追求全绿无限追加；质量改善仍未证明，Phase 5 保持未通过。没有推送、发布或改写历史工件。

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

本机尝试构建 `runtime` target 时，Docker 未命中 browsers 中间层；显式 cache source 又返回 registry cache importer `403 Forbidden`，为避免重复下载而停止，故不把本机尝试记为通过。PR #56 的 quality workflow 已于 `2026-09-05T16:15:07Z` 成功完成 production image 构建和 production Chromium runtime 验证；该 CI 事实补足 runtime 工程证明。

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
6. 未达到标准时保留退步事实，修订后优先重跑受影响案例和必要对照；完整对比矩阵需要另行授权，专项结果不能代替完整验收。不以增加场景数量代替质量改善。

### 完成证明

脱敏评测输入清单、版本标识、全部输出、逐例复核和对比结果保存于 `.cynos/acceptance/`，分别标注规划与 Reviewer 的证据，在本计划补充非敏感证据位置和实际状态。AC-SDQ-09 的真实质量证明必须来自固定工件的真实 Reviewer 输出和读取记录；未运行这组评测时，即使规划对比或本地流程通过，该 AC 仍保持未完成。凭据、预算或外部条件缺失时记录未运行/受阻及原因，Phase 5 保持未完成，不用本地协议模拟出质量通过。

实际状态：已完成两轮真实 Qwen 72 Session 离线矩阵，工程反馈修复后的第二轮仍发现持久化/废弃覆盖遗漏（见本文专项记录）；不是现场 live Run 验收。本轮仅运行受影响规划及对照专项，不运行全量。独立人工计数未完成，Phase 5 保持未通过，不声称稳定质量改善。原先因输入不足退出的 live 验收记录是历史事实，不再作为本轮离线模型评测未运行的理由。

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
| AC-SDQ-04、AC-SDQ-05            | Phase 2、4、5 | 首轮真实模型有缺口；修复复评中 |
| AC-SDQ-06、AC-SDQ-09            | Phase 3、4、5 | 首轮真实模型有缺口；修复复评中 |
| AC-SDQ-07、AC-SDQ-10            | Phase 3、4    | 工程通过   |
| AC-SDQ-08                       | Phase 2、3、4 | 工程通过   |
| AC-SDQ-11                       | Phase 2、3、4 | 工程通过   |
| AC-SDQ-12                       | Phase 4、5    | 首轮矩阵已运行；最终人工计数未完成 |

PR #56 和四项工程遗漏修复 PR #58 已合入 `develop`；本轮真实反馈修复尚在独立分支。Phase 5 已运行两轮矩阵但未通过质量验收，本轮仅做关键变化覆盖专项；独立人工评分待完成，不因工程检查或局部专项通过就宣称完整场景设计质量已验收。
