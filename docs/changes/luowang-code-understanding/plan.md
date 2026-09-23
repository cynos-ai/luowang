# 代码深读与测试判断 Plan

- 目标版本：v0.6.0；依据 [spec](spec.md)。
- 状态：阶段 1–3 已实现；完整 local、普通四 Session、真实六 Session 初始化及维护/defect/blocked 代表验证完成。修正候选的八类三组配对已完成，关键遗漏仍劣于基线并出现关键错误期望，AC-CU-07 未满足；阶段 5 未发布，PR #75 保持 draft，汇总待负责人审阅。旧轮 300 次、本轮新增 617 次调用，失败均保留。2026-09-23 从 develop `c51e5c1` 创建 `feat/code-understanding`。
- 顺序：本版本单独实现、验收和发布，之后才启动 v0.6.1 多项目实现。

## 阶段 1：内置方法与资源加载

- [x] 新增 code-understanding 方法资源，按 engineer onboard 的阅读方法改写为测试用途；核对规格与实现冲突、未知及测试能力描述。
- [x] 扩展 `src/server/runs/role-instructions.ts`、资源复制脚本及对应角色指令；现有类型可直接保存新增资源 ID，复用版本/哈希和构建路径，不启用 Pi Skill 发现。
- [x] 检查普通及初始化两个 Main 的资源集合、其余角色隔离、缺失/错误资源和干净镜像打包。

完成证明：AC-CU-01；资源加载测试、角色工具断言及 quality/runtime 资源核对。风险是把新方法误装入最终 Main，或新增资源没有进入生产镜像。

2026-09-23 阶段证明：

- 新方法只加入 `main-planning` 资源集合，覆盖普通规划、初始化静态及候选 Main；Runner、Reviewer 和最终 Main 不加载该方法。Reviewer 仅补充来源与范围审核要求，未增加工具。`RoleInstructionVersion` 现有字段和加载器推导类型可直接使用，无需另建类型或配置。
- 干净 Git 源码叠加本次变更构建 `luowang:code-understanding-stage1-quality`，容器内 `format:check`、`lint`、`typecheck`、`build` 通过；`closure1-role-instructions`、`phase3`、`closure6-production-pi`、`closure6-acceptance-layering` 四个测试文件共 71 项通过。包括缺失/空白/错误标记/symlink/不可读资源拒绝，方法缺失时零 Session 启动，原文完整加载及版本哈希变化，四/六/三 Session 交接。
- 同一源码构建 `luowang:code-understanding-stage1-runtime`；quality 编译产物与 runtime 均通过默认加载路径核对，普通/初始化的四类角色共八种组合正确。方法 SHA-256 为 `6cbcf8dba753fdb01b6b44fd4d937c6e0f678e0ca4f4f7693c28772b5c83ac40`，与源码一致。
- 本机日志保存在被忽略的 `.cynos/code-understanding-stage1/`。测试容器关闭外部网络，生产 Pi 使用本地协议样例，外部模型请求为零。未运行完整 local/live/release 验收、模型效果对照或人工评分；以上结果只证明阶段 1 的工程行为，不证明理解质量已经改善。

## 阶段 2：固定版本读取回执

- [x] 沿 `orchestrator.ts:targetToolOptions`、`agent-session.ts` 和 `change-evidence.ts` 的既有入口记录真实回执，统一正文与分页读的对象身份和返回范围。
- [x] 搜索/目录/变化清单明确其内容类别与不完整原因；统计返回给模型的内容，不把内部扫描当成已读正文。
- [x] 复用 Run/Session 本地记录，添加受控 query_source_reads；权限按当前 Run/阶段绑定，查询分页与数据脱敏统一处理。
- [x] 验证空文件、缺页、重复页、乱序页、UTF-8 边界、rename、无 base、游标混用、受限文件、回执写入失败。

完成证明：AC-CU-02、03 及查询权限部分的 AC-CU-06。风险是截断/脱敏前后坐标不同；回执必须明确对应实际返回文本，必要的内容身份另存哈希，不将两种坐标混用。

2026-09-23 阶段证明：六个读取工具统一记录固定版本、类别、脱敏后内容哈希及实际返回区间；正文每页最多 32 KiB，目录/变化清单同时限制 100 项与 32 KiB。游标为当前工具 Session 内签发的随机令牌，绑定固定对象和安全文本身份；重复、乱序和有缺页的覆盖分别验证。搜索显式返回匹配上限、大文件跳过和不可读/不可用文件跳过等限制，内部扫描不产生正文回执。

本地 `source-reads.json` 使用受控 Run 目录和原子替换，不进入 artifact/evidence 列表、OSS 或目标 Git，特殊两工件收尾仍删除该临时元数据。每次创建读取工具组产生独立 Harness Session ID，保留普通规划/初始化静态/候选/侦察/验证阶段；仓库身份保存稳定指纹，不保存本机仓库绝对路径，工具调用标识仅保存哈希。Main 与 Reviewer 可以查询本 Run 元数据；Runner 与最终 Main 无查询工具。持久化失败不返回未登记源码，恢复后不补造此前成功记录。

干净 `luowang:code-understanding-stage2-quality` 容器内格式、lint、类型检查、完整 41 个测试文件 / 331 项单测和构建通过。包含 8 项新增回执测试、固定 Git 变化测试、真实生产 Pi 协议与角色隔离回归；本机日志在 `.cynos/code-understanding-stage2/`。外部模型请求为零，尚未执行模型效果评测。

## 阶段 3：计划引用和角色交接

- [x] 为 write_plan 增加 sourceReferences，先校验再原子交付 plan 与引用集合；沿用既有有界重试。
- [x] 初始化静态理解、侦察、候选综合保留阶段归属；把必要风险和缺口放进现有 plan 及安全审核摘要。
- [x] Reviewer 读取被引用回执并独立核对来源、期望和范围；最终 Main 仍只读 plan/review。
- [x] 真正通过生产 Pi Session 验证工具可见性、假引用拒绝、旧有效计划保留、特殊两工件及最终修订未经执行仍 blocked。

完成证明：AC-CU-04、05、06。风险是新增引用字段成为模型猜 schema 的负担；工具描述提供完整最小输入，并接受诚实空引用与缺口，不能要求为通过校验编造依据。

2026-09-23 阶段证明：`write_plan` 必填结构化引用，校验成功后将正文、内容哈希、浏览器需要声明及引用集合写入同一原子 plan；拒绝假引用、跨 Run、Runner 来源、失败读取及缺页全文声明。初始化候选可引用前序 Main 回执，归属保持不变。Reviewer 可分页查询当前有效 plan 的引用，最终 Main 权限不变。

干净质量容器内格式、lint、类型、完整 336 项单测及构建通过；补充生产 Pi 同 Session 错误替换后修正、Reviewer 实际查询、初始化来源归属后，两个相关测试文件 30 项通过（全库现有 337 项）。旧有效计划保留、写入失败、空正文、复制旧元数据、特殊两工件及最终修订 blocked 均有覆盖。本机日志 `.cynos/code-understanding-stage3/`；外部调用累计 0/300。以上仍是工程验证，不代表模型效果达标。

## 阶段 4：冻结模型对照并验证效果

- [ ] 复用 `tests/acceptance/` 中现有模型与工件驱动模式，准备八类固定样本；输入、关键风险、允许维护决定和禁止期望在执行前冻结并记录哈希。
- [x] 先做无模型预检，再用两个代表样本检验工具协议；试运行不替代正式八类对照。
- [ ] 基线 v0.5.0 与候选使用隔离副本；每类三次配对，共 48 个案例运行。一次案例可能含多个 Session，实际成本按 Session 和请求统计。
- [x] 每批开始前记录沿用的资源授权、模型配置、请求上限与停止规则；预计超出已有明确预算时先取得扩额，不以无限重试补分。
- [x] 分别输出工程验证、模型配对评分、人工评分状态与成本；传输失败保留失败尝试并按事先规则报告未完成，不能换样本或偷改期望。

完成证明：AC-CU-07。判分依据见 spec 第 6 节；候选关键错误、关键遗漏退化或未证实改善均必须调查。修订后建立新候选轮，旧轮永久保留。

## 阶段 5：联合验收与 v0.6.0 发布

- [x] 在干净 Git 源码的 quality 容器运行格式、lint、类型检查、完整单测、构建、E2E 和 local 验收；不把本机 .cynos 辅助脚本混入源码。
- [ ] 在获授权非生产目标执行初始化和维护代表 Run，验证真实 DeepSeek、浏览器、OSS、GitHub、独立审核、自动归档及清理；保留 normal/defect/blocked 差异。
- [ ] 首次创建场景分支等一次性验收条件使用新的隔离验收条件或明确的已有样本，不删除已有 scenario-testing 或伪装为首次运行。新增目标需要先明确授权。
- [x] 更新 README、PROJECT.md、布局约定与 AGENTS.md 的相应能力说明，实际完成后才写已实现；旧 Run 结论不变。
- [ ] 按负责人后续自主推进授权，验收通过后按短期分支 → develop PR → main 发布 PR 执行，版本文件与 annotated tag 使用 v0.6.0；核验 main/tag、CI 与发布后验收。验收不达标则保留问题，不以授权代替完成条件。

完成证明：AC-CU-08、09；保存固定候选提交、CI 链接、各层报告、资源版本、模型用量与未完成项。人工未评分时如实保留，不因 AI 审核记录清除 humanScoring。

## 提交与执行边界

各阶段做到对应测试通过后形成可 push 的提交节点；实施分支从最新 develop 创建 `feat/code-understanding`。规格编写节点只提交 intent/spec/plan 及工作入口说明；后续按负责人“继续”授权分阶段实施，未到发布阶段不升级 package 版本、不发布。模型效果评测按阶段 4 执行。

v0.6.1 不作为本版本完成条件。深读记录先使用现有仓库身份和固定提交，后续多项目版本在其外层增加项目归属，不提前引入多项目架构。

负责人追加授权：自主推进 v0.6.0，外部模型调用总上限 300 次，失败尝试与重试也计数；本轮不做 v0.6.1。运行用量记账在本机 `.cynos/code-understanding-v060-budget.json`，每批保留输入、候选、用量和停止原因；截至阶段 2 完成使用 0/300 次。

2026-09-23 评测协议与资源记录：先冻结八类合成 Git 仓库与逐项 rubric，两个版本使用各自生产资源加载器、Pi Session 和源码工具。第一份冻结记录仅执行零调用预检；第二份冻结记录的两例试运行使用 7 次请求，正式轮执行中发现 4 响应上限使部分计划未交付或已写计划但 Session 未结束，遂停止。该正式轮已计 37 次（含停止时进行中的尝试），全部保留，未改为通过，未替换样本。累计 44/300 次。

第三份冻结记录保留相同八类输入和 rubric，明确改为“等材料语义评测”：评测专用批量读取工具调用两版各自生产读取工具，一次向模型交付固定 target、变化 diff 与相关 base 正文。它不进入产品，不验证自主找文件的效率；只比较获得同一材料后的理解、维护决定与依据。仍为八类各三组配对、每例最多 4 次响应，人工评分 not_run。两例新试运行均用 3 次请求正常完成，累计 50/300；正式 48 案例另行执行，最终成绩待审核。本机保存目录 `.cynos/code-understanding-stage4/round1`、`round2`、`round3`，每轮有独立输入、协议、源码哈希、调用预算、原始工具输出和计划。

同一候选产品源码的完整 local 验收通过：`local=passed`；日志与报告在 `.cynos/code-understanding-stage4/local-proof/local/`。local 不连接真实依赖，报告中的 live/release 仍为 blocked；不把旧版本真实 Run 直接作为本候选已完成的证明。
2026-09-23 本轮审核发现及修正（不回写冻结成绩）：

- 合成 `bug-fix` 样本的 base 通过字符串替换误改到了 `insert(...)`，导致实际代码返回未调用的函数，不能代表原定“写入失败后的库存残留”。该类的全部原始结果保留并标为样本无效，不计效果分。已改成明确的非事务实现，并新增运行级样本测试：同样的 insert 失败下，base 库存从 10 留在 7，target 事务回滚到 10；测试通过。
- 冻结候选 `capability-1-candidate` 的计划把取消后的库存写为“回到取消前基数”，与归还库存的契约及自身摘要冲突，属于新的关键错误期望。`no-docs-0-candidate` 还把仅凭实现推断的候选标为 approved，同时承认缺少规格依据。两者不能靠引用校验排除，当前冻结候选未达到发布条件。
- 后续候选的通用指令增加两点：显式 return/异常分支不自动成为独立契约；操作前后数值、变化方向与基准时点必须一致。Reviewer 同步检查状态变化描述的冲突。未新增正则语义判断、产品发布门禁或角色权限。这些修正发生在冻结轮之后，不能把原轮成绩套用到新候选；实际效果仍需另行验证。
- 修正后格式、lint、类型检查、构建与角色资源/生产 Pi/源码引用/样本四个测试文件通过；本机证据在 `.cynos/code-understanding-stage5/`。完整 local 的既有通过证明对应修正前候选，二者分开记录。

## 2026-09-23 自主执行收尾

本轮停在已实现、已验证并提交的开发候选，不发布 v0.6.0。产品实现提交为 `9f77bd508f524e80b7abcb350307318d966a8ffc`，开发 PR 为 [#75](https://github.com/cynos-ai/luowang/pull/75)，保持 draft。v0.5.0 仍为正式版本；未合并 develop/main、未改版本号、未创建发布 tag，v0.6.1 未启动。

### 模型对照结果与限制

round3 冻结标识为 `dcc865554284c909d47b93971645899db605c4276192680856135862821c3116`。48 个案例已尝试，47 个 Session 正常结束；`deprecation-2-candidate` 触及四响应上限，即使已写 plan 也计未完成。Bug 修复样本的六个结果全部因样本错误排除。余下有 20 组完整有效配对，按预先 rubric 做 AI 逐项审核，`humanScoring=not_run`。

| 指标（20 组配对）                      | v0.5.0 基线 | 冻结旧候选 |
| -------------------------------------- | ----------- | ---------- |
| 关键风险缺口，含未说清（各 60 项标准） | 5           | 2          |
| 含无依据或弱化期望的案例               | 3           | 2          |
| 无谓维护变更案例                       | 0           | 0          |
| 来源或范围描述错误案例                 | 1           | 2          |

来源错误包含基线短 SHA 写错、候选把完整返回误述为截断；后者属于低估阅读范围，不是假称全文已读。候选新增了“取消后回到取消前库存”的关键错误，不能以其他指标下降抵消。此次成绩不满足 AC-CU-07，也不能证明修正后候选已经改善。

正式轮成本包含无效及未完成案例：基线 74 次请求、输入 532,221 / 输出 71,971 tokens、390,927 ms；旧候选 73 次请求、输入 947,931 / 输出 90,646 tokens、449,181 ms。等材料协议不测自主找文件效率；候选回执也增加了上下文，不能只报告缺口数量而隐藏成本。原始工件与逐项审核保存在 `.cynos/code-understanding-stage4/round3/`，审核引用 plan 哈希，旧输出未改写。

修正后另做两次候选定向检查，各三次请求：无文档样本将实现推断全部保留为 draft，执行清单为空；新能力样本把库存写为回到“提交前基数”，重复取消与首次取消后库存相同。无文档样本的 draft 仍使用“原基数”而没有直接命名时点，侦察项要求后续确认；不能宣称所有歧义都已排除。每类仅一次、没有基线配对，不替代完整重跑。冻结标识 `e1053741b2f6331da2a2b700f7772115020d52c5eeaf5f085eb88bcd17b2b47d`，原文和审核保存在 `.cynos/code-understanding-stage5/directed/`。

### 修正候选的工程与真实联合证明

- 修正后的完整 local 再次通过，覆盖格式、lint、类型、338 项单测、构建、E2E 与生产 Pi 专项；报告 `.cynos/code-understanding-stage5/local-proof/local/report.json`。quality/runtime 使用干净源码构建，八种角色/初始化资源组合核对通过。产品提交的 [quality CI](https://github.com/cynos-ai/luowang/actions/runs/35786145264/job/106943320215) 通过。
- 沿用已授权的非生产 `cynos-ai/luowang-closure7-fixture`，新建隔离本地数据目录，不重置历史分支。固定 target `fa6242b3105f1c01d7b82f363d145aca7e25ba16`；Run `01M35G3MZZ6Z0FWKEQNX00AR79` 使用 Main/Runner `deepseek-v4-flash`、Reviewer `deepseek-v4-flash-vision-exp`，四 Session 正常结束，AUTH-LOGIN-001 为 passed，归档 completed，97 次请求。
- 实际覆盖登录、刷新后的身份保持、退出后旧会话拒绝、删除账号后会话和凭据拒绝，以及真实浏览器、视觉审核、OSS、GitHub 自动归档和清理。独立数据库核验 users=0、sessions=0；清理核验无残留。不是六 Session 初始化，也不替代本候选 normal/defect/blocked 全组合验收。
- 独立核对 plan 内容哈希及全部 15 个引用：13 个脱敏后全文引用、2 个目录分页范围；均属于本 Run 的规划 Main 和固定 target。Reviewer 实际调用 `query_source_reads` 并在 review 中核对 planHash；只有规划 Main 加载 code-understanding，其他三角色资源隔离成立。
- 远程归档提交 `7062f9a65651eeef7abe9f6a79ed4dc4c5f583d9` 仅新增本 Run 的 report/review；两文件 Git blob SHA 与本地完全一致，分别为 `01c0f7d1090f0485fb8d71956eb53fc93b246f7e`、`831575c319a8d8065f70b8177e305f07dd4a8462`。没有归档源码回执或中间计划。
- Reviewer 实际读了七张截图。本轮收尾另查看原图 01/02/03/04/07，登录填写值保留，密码由页面自身以圆点显示；登录与刷新同一身份、退出提示、删除后凭据拒绝与报告一致。未删除填写值、未重绘截图。Markdown 已知凭据精确扫描无命中；这不等同全面泄漏证明或人工审核。
- 本机证明位于 `.cynos/code-understanding-live/`，包括固定候选/镜像、资源哈希、原始 Run、用量、独立归档与引用核对；验收容器和网络已收尾。

### 预算及下一步

外部调用共 **300/300**：旧协议试运行 7 + 中止正式轮 37 + 新协议试运行 6 + 正式轮 147 + 真实联合 97 + 修正后定向 6。失败和中止尝试都计数，没有超额重试；账本 `.cynos/code-understanding-v060-budget.json`。

后续按以下顺序完成，当前预算已耗尽，不再启动模型请求：

1. 对修正后的候选与修正后的 Bug 样本重新冻结八类各三次完整配对；保留旧轮，明确缺口、错误期望、来源及成本是否达标，避免以两个定向样本代替验收。
2. 完成本候选真实六 Session 初始化及尚缺的维护/defect/blocked 代表验证；现有工程模拟通过不能替代真实模型行为。
3. 汇总结果交负责人审阅；人工评分继续明确标识未运行，不能把本轮 AI 审核写为人工盲评。
4. 满足 spec 后再完成 develop PR、main 发布 PR、版本号/tag 与发布后核对；不提前启动 v0.6.1。

## 2026-09-23 继续授权后的完整验收（round4）

负责人已授权继续完成完整配对、六 Session 初始化、维护/defect/blocked 代表验证及验收汇报。原 300 次账本保持不变；新增调用单独记账，不把旧失败清零。产品候选仍为 `9f77bd508f524e80b7abcb350307318d966a8ffc`。

### 完整配对及全部失败

- 使用修正后的 Bug 样本重新冻结八类各三组配对。正式轮 48 次尝试中 47 次交付计划；`spec-conflict-0-baseline` 把计划写在最终回复中，没有调用 `write_plan`，因此未完成。保留原始响应和费用，不把文本当成有效 plan。
- 单独冻结并追加该类完整的一组 baseline/candidate 配对（repeat=3）；两边各 3 次调用完成。最终共 50 次尝试，24 组完整有效配对，每类三组。原正式轮依然记为不完整，补充轮不覆盖旧结果。
- 协议 schema=3：每案例硬上限 6 次，pilot 上限 12，正式轮上限 288。冻结驱动的提示文字仍写“4 次响应”，两边相同，实际每案例均未超过 4 次；事后已将提示改为读取协议值，但该修正未参与本轮模型评测。冻结驱动保留在本机 evaluator 目录，不追溯修改历史。
- 评测向两边提供相同的整批冻结材料，衡量基于材料的规划判断，不证明自主导航深度。逐计划 AI 核对冻结 rubric，保存原句、判分理由和 plan 哈希；`humanScoring=not_run`。

| 指标                       | v0.5.0 基线 | v0.6.0 候选 |
| -------------------------- | ----------: | ----------: |
| 有效配对案例               |          24 |          24 |
| 固定关键风险条目           |          72 |          72 |
| 关键风险遗漏/不明确        |           4 |           6 |
| 存在无依据或弱化期望的案例 |           3 |           2 |
| 无谓场景变更               |           0 |           0 |
| 来源归属错误案例           |           3 |           2 |
| 全部正式及补充尝试的请求数 |          76 |          75 |
| 输入 Token                 |     543,255 |     979,672 |
| 输出 Token                 |      76,196 |      99,196 |
| 累计耗时（ms）             |     415,685 |     493,880 |

质量指标按 24 组有效配对计算；费用覆盖原正式轮失败及补充轮两边，不剔除失败成本。未换算货币费用，不能将 Token 数当成账单金额。

发布判断仍为 **不通过**：关键遗漏由 4 增至 6，且候选包含关键错误期望。

- `capability-0-candidate` 将“重复取消返回同一订单”写为 approved 期望；规格只约束库存不重复归还，没有规定返回形状。同组基线把返回形状作为观察项。
- `bug-fix-2-candidate` 写“无法注入时用库存不足路径代替”；前置库存拒绝无法证明库存预留成功后订单插入失败的回滚。`bug-fix-1-candidate` 也缺少实际故障点验证。
- 三个 permission-persistence 候选都缺少冷缓存的拒绝对照；refactor-1 候选没有明确本租户读取回归。
- 改善也保留：三个 no-docs 候选均保持 draft，而三个基线均错误标为 approved；此前取消库存基数错误本轮未复现。但这些改善不足以抵消发布阻断项。

原始材料与逐项判分：本机 `.cynos/code-understanding-round4/frozen/`、`supplement/`、`audit-notes.json`、`audit.mjs` 和 `frozen/audit-with-supplement.json`。AC-CU-07 尚未满足，不能宣称质量提升。

### 真实六 Session 初始化

- Run `01M35T3EEN58NDQY8B66E72AQZ`，142 次调用，结果 passed；序列为静态 Main → 侦察 Runner → 候选 Main → 正式 Runner → Reviewer → 最终 Main。
- 使用此前授权的非生产样例仓库 `cynos-ai/luowang-closure7-fixture`，固定源提交 `ef468e7c94d023d36da1e88254af90cdcc934b21`，独立验收分支 `scenario-cu060-acceptance-20260923`；原 scenario-testing 未改动。目标镜像源码与该源提交仅有认证规格文档差异，已核对。
- 初次自动建分支、队列与归档均完成；归档提交 `77036184fa1930ac50821bf0b1bc00cd2984cbc1`。远程仅新增当前 report/review，Git blob 哈希分别为 `2a5d83d2a6c9d8866547fa99fee78136a34a0613`、`e72d707aedd7b13e0516fb2f7fddd407c2008008`，与本地一致。
- 独立核对 planHash、28 个回执与 28 个引用；25 个来自静态 Main，3 个来自候选 Main，固定 target 和两个 Session 归属成立。Reviewer 实际查询来源并核对计划；代码深读资源只进入两次规划 Main。
- 实际浏览器、视觉审核、OSS、GitHub、清理执行完成。原图填写内容保留，密码由页面自身显示圆点；没有为截图删除表单值。独立查询数据库 users=0、sessions=0，容器和网络已收尾。
- 证明：本机 `.cynos/code-understanding-round4/initialization/`，独立核对写入 `independent-checks.json`。

### 真实维护与三 Session 场景审核

- 首轮 Run `01M35TNXK9RQ2248STP7G9GQBQ` 用满预设 70 次调用，Runner 仍在侦察 Origin/网络证据，未交付有效执行结果；Run failed、result=null、无归档/PR，远程目标不变。所有请求与工件保留在本机 `special/`；不记为产品缺陷或预期 blocked 通过。
- 新建独立重跑目录 `special-retry/`，固定同一 target `77036184fa1930ac50821bf0b1bc00cd2984cbc1`，上限提高为 180；没有覆盖旧 Run。Run `01M35V3YWV6PNDW30AY9CJFPMY` 用 75 次完成。
- 三 Session 顺序 Main → 侦察 Runner → 候选 Main；review-all 按预期以 blocked 结束，queue/archive completed。没有额外正式 Runner、Reviewer 或最终 Main；completed 对外交付严格为 report.md 与 scenario-changes.patch。
- [样例仓库 PR #5](https://github.com/cynos-ai/luowang-closure7-fixture/pull/5) 以独立验收分支为 base，只新增 `AUTH-ORIGIN-001.md` draft。PR 场景 blob 与本地 patch 字节一致，目标分支不被提前推进；未创建产品 Issue。
- 侦察没有拿到跨站 Origin 拒绝的必要运行证据，候选明确保留缺口和 draft。这证明人工审核交接边界，不意味着该新增场景已经通过，或全部维护判断正确。场景 PR 保持待审，不自动合并。
- 两次尝试均完成清理，独立数据库 users=0、sessions=0；验收容器和网络已收尾。

### 真实双缺陷代表验证

- Run `01M35VFNC1B56CH42BPCSMTPNS`，94 次调用，固定 target `77036184fa1930ac50821bf0b1bc00cd2984cbc1`。在一次性非生产目标注入 logout 不撤销 Session、deleteAccount 返回成功但不删除数据两个缺陷；它们是验收夹具，不是罗网或正式官网的新缺陷。
- 四 Session 完成，AUTH-LOGIN-001 failed，Reviewer 独立核对旧会话引用、真实请求头与响应，以及删除后的原凭据重新登录；最终报告保存两个不同 bug key，并成功关联已有样例 Issue [#1](https://github.com/cynos-ai/luowang-closure7-fixture/issues/1)、[#2](https://github.com/cynos-ai/luowang-closure7-fixture/issues/2)，未重复新建。
- 初始验收驱动误报失败：它从 `RunDetailSnapshot` 读取并不存在的 confirmedBugs/issues 字段，得到空数组。只读 RunStore、正式 report frontmatter 和远程 Issue 后确认真实副作用正确；保留原 `dual-verification.json` 和 exit=1，另写 `store-independent.json`、`dual-corrected-verification.json`。没有修改 Run、覆写失败或为脚本错误重复请求模型。
- 独立复核角色隔离、计划哈希及 10 条当前 Run 引用。归档提交 `271b7265eda2bd230472bbe4b5bf4146586705a6` 仅新增本 Run report/review，blob 哈希为 `bf0eaa0049c3122f740ec2bac532bb0612801fec`、`79ca61f71cc403678dd80d5729e30206c9a17745`，与本地一致。
- 数据库独立核验 users=0、sessions=0，容器与网络已清理。证据与证明在本机 `round4/dual/`。本轮证明缺陷识别及已存在 Issue 的关联路径，不冒充本轮新建 Issue 验证。

### 真实证据依赖不可用 blocked 验证

- Run `01M35VR5JYPYJTXEV5V4PYDX4Q`，79 次调用，固定 target `271b7265eda2bd230472bbe4b5bf4146586705a6`，目标应用正常。受控适配器只拒绝读取 operation 原始证据，不把工具路由错误伪装成证据损坏。
- 四 Session 完成，Reviewer 遇到 8 次证据读取阻断后保持 blocked；正式存储 scenarioResults=blocked、confirmedBugs=[]、issues=[]、progressed=false。实际浏览器执行和 OSS 上传照常完成，未凭 execution 或截图补造必要的请求关联。
- 首次报告归档遇到 Git fetch exit=128，archiveStatus=partial；merge --abort 的 exit=128 是无 merge 可中止时的正常收尾，不是本轮失败根因。保留原 trace、queue、verification 及重试前存储证明。
- 使用同一 runtime 的既有 `Archiver.retry` 重试同一 Run，无模型调用、不重跑测试、不重写报告。重试后 archiveStatus=completed、reportStatus=published，result 仍 blocked、progressed 仍 false、Issue 仍零。原队列快照的 partial 没有覆写，最终状态以重试结果与 RunStore 为准。
- 原验收驱动也存在从运行快照误读 scenarioResults 的问题；最终验证改从正式 RunStore 读取，另存 corrected-verification，原失败保留。归档提交 `a6fd6d64dc89c304293f1fb76d0d3b60311e7025` 只新增本 Run report/review，blob 分别为 `df13141f154331e694644ab124b8cd729023e2be`、`3e37377c5ef5d490c619c913b7d63e9a7d7f6dcb`，独立核对与本地一致。
- 计划哈希及 17 条当前 Run 来源引用、角色资源隔离成立。数据库 users=0、sessions=0，容器及网络已清理。证明在本机 `round4/blocked/`；重试记录为 `blocked-archive-retry.json`。

### 本轮成本、检查与发布决定

新增共 **617 次模型调用**：pilot 6 + 正式配对 145 + 补充配对 6 + 六 Session 初始化 142 + 维护失败 70 + 维护重跑 75 + 双缺陷 94 + blocked 79。全部失败计入；原账本 300/300 未变，两轮累计 917 次。新账本为 `.cynos/code-understanding-v060-round2-budget.json`。负责人授权继续完成这些验证，未指定新的数字额度；600→800 是执行中自设上限调整，不表述为负责人明确授权 800 次。初始化的独立预留账本只合并一次。

本轮没有修改产品资源或实现，只调整评测脚本的预算读取和协议提示，以及补充验收记录。最后一次提示修正后，16 项零模型 preflight 通过；评测脚本 ESLint 通过。前述候选完整 local 338 项与干净 quality/runtime、普通四 Session 真实 Run 的证明仍有效，但不替代本轮的语义结果。格式与提交后 CI 状态以最新提交检查为准。

**发布决定：暂不合并、不打 v0.6.0 标签。** 工程与真实代表流程已验证，AC-CU-07 的不退化和关键错误约束仍未满足；人工评分未运行，本汇总待负责人审阅。PR #75 保持 draft，v0.6.1 实施仍未开始。

下一轮建议在审阅本报告后按以下顺序推进：

1. 修正 Main 的通用判断方法：每条硬性期望对应明确契约，区分返回格式观察与业务必须条件；不能把实现或惯例升级为规格。
2. 将错误发生时点与共享状态作为验证计划的一部分：前置拒绝不能替代副作用发生后的失败回滚；必要故障点不可构造就保留缺口。权限/缓存覆盖同时说明冷、暖状态和允许、拒绝对照。以通用方法表达，不写死本轮样本答案。
3. 控制提示成本并先做小规模排错，修正后重新冻结候选、协议和八类三组完整配对；继续保留所有失败，不以定向小样本代替完整验收。
4. 产品指令若改变，重建并核对资源哈希，运行受影响工程与真实流程回归；满足 spec 后再次汇总审阅，再走 develop/main PR、版本号和标签检查，之后启动 v0.6.1。
