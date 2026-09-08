# 单向角色交接与独立收尾 Plan

依据：[intent.md](./intent.md)、[spec.md](./spec.md)。在既有未发布反馈分支延续本地实现；不 push、merge 或发布。

## 实施

1. 删除草稿工具/类型和普通、初始化、归档、索引依赖；收紧最终 Main 读取边界和 Issue 查询前置；更新角色资源与当前文档入口。
2. 分离 Reviewer 前证据上传和最终 Harness 清理；正常、特殊、异常路径统一清理，确定性记录收尾，不影响测试结果；移除模型清理确认入口。
3. 更新本地协议和测试，增加权限、顺序、异常清理与不改结论的回归；检查真实生产 Pi 输入而非仅关键词。
4. Docker quality 容器运行测试、format/lint/typecheck/build/E2E 与本地验收；保留失败记录。真实模型复测另行记录，工程通过不等于质量通过。

## 风险

草稿涉及归档 allowlist、初始化侦察和协议 fixtures，必须整体移除，不能只改提示词。最终清理不得在归档后执行或被角色异常跳过；异常记录失败不能掩盖原始错误。旧文档的清理阻塞条款由本 Spec 明确覆盖，不追溯修改旧验收结论。

## 进度

- 已完成实现：删除草稿 writer/工件/归档与控制台入口、初始化草稿依赖；最终 Main 只读 plan/review（初始化保留 patch），Issue 查询前置同步收紧。Reviewer 独立交付完整审核，不再确认收尾清理。
- 删除旧 cleanup claim、查询 adapter 注册表、Reviewer 确认工具及对应证据读取链，无兼容分支。保留 Run 归属登记、可信清理 adapter 和真实结果捕获，正常/特殊/可捕获异常路径最后收尾；报告的 Harness 收尾区由系统写入。清理告警不加入测试 blockingReasons，不改测试结果和 Bug。
- 证据工具改用“配置的证据存储”准确描述，不从存储成功推断远程发布。旧评估输出未变；真实模型评估若使用替代依赖仍须明确说明替代范围。
- Docker quality 内完整本地验收通过：178/178 单元/集成测试、format/lint/typecheck/build/headless E2E、Phase 9、生产 Pi 普通四 Session、初始化六 Session、特殊三 Session。新增/受影响测试另经严格 TypeScript 编译通过。
- 专项证明：新清理 manager 5 项；最终 Main dispose 后清理且保留 passed/failed，以及 Runner 失败后清理且保留原失败，共 3 项。最终 Main 读取 execution/草稿均被真实受控回调拒绝。首次归档后目标仓库仅两份报告，特殊路径仍两工件。
- 失败记录保留：首轮旧 fixture 工具/工件依赖 54 项失败；第二轮 6 项（包含 CRLF 收尾换行修复）；第三轮测试通过但两个 prefer-const lint 错误；首轮完整验收 Phase 9 仍期望三份报告而失败，并发现旧清理专项筛选器跳过全部测试。已更新对应断言和筛选器，最终专项分别实际执行 5/3 项，不能把 skipped 当证明。
- 最终证据：`.cynos/acceptance/single-handoff/engineering-final/report.json`，local=passed、live=blocked、release=blocked；`test-typecheck-final.log` 通过。该工程验收时未进行真实模型语义复测、外部官网联合验收或发布，不能以本地通过宣布整体模型质量通过。
- 限制：无清理 adapter 时仅记录未完成；不新增跨 Run 污染自动分类、任意清理命令或硬杀进程后的清理恢复。仅本地提交，不 push/merge/release。

## 有界真实模型复测

- 冻结比较 f1b0451 → f0b0456，三条件各两版本一次，不改变历史评估。两边每个 Session 均明确获知本地证据替代、无浏览器及共享服务授权边界；生产 orchestrator/Pi Session、真实受控容器命令，无远程发布。
- 预检查6链/24阶段/零模型请求通过。live 完成6/6完整链、24独立且已 dispose 的 Session、291次 Qwen3.7-plus 请求（Thinking off），无模型请求错误/鉴权/配额/终止失败，不追加重试刷分。
- 正常：baseline/candidate 均实际两个 API passed，但 Run 被既有 UI 关键词检测误判为 blocked（53/46请求）。缺陷：均准确识别注销后旧 Cookie 200≠401，删除账号场景仍 passed，Run failed（56/48）。服务未提供：均未实际执行、Run blocked（47/41）。
- candidate 3/3 最终 Main 仅实际读取 plan/review、无草稿工件；清理查询在最终 Main dispose 后，系统追加真实收尾。两边 Reviewer 均3/3先读相关原始命令再读叙述。13次原始读取逐字节匹配；342份冻结哈希、固定 target、干净 worktree、无剩余 Run 容器复核通过。11次实际容器命令中3次过滤参数错误保留并由同 Session 修正；2次服务拒绝没有伪造进程结果。
- 已复核全部27份 Markdown 与相关输入/事件。新结构按约定执行，但不能宣布总体质量改善：正常计划中的“无浏览器服务/不执行端到端 UI”等范围说明，被两版相同的 browserScenarioRequested 代码误当作 UI 执行要求；Reviewer 已指出误判，最终 Main 受 Harness blockingReasons 硬约束而整体 blocked。原函数用原输入复现，诊断副本排除触发行即不触发，原 Run 未改写。
- candidate 服务不可用报告第二处 command-1 链接拼接错误（第一处及真实证据正确）；缺陷报告正文仍把模型结束时待 Harness 处理的清理列在“未完成事项”下，虽然随后系统已确认完成，存在阅读歧义。没有发现最终报告声称真实 OSS 发布或直接要求未授权共享账号；两边的共同输入改进亦影响此观察。
- 完整证据：`.cynos/acceptance/single-handoff-model/{manifest.json,preflight.json,live-output/summary.json,review/findings.md,review/checks.json,review/handoff-checks.json,review/browser-attribution.json}`；live.exit=0 仅表示执行完整。总体质量 not_established、独立人工评分 not_run、官方 live/release 仍 blocked。
- 下一步建议先修浏览器需求误判，其次确保报告原样复用稳定证据地址；本轮只复测与归因，不中途修改产品代码、不追溯改写评测结论。
