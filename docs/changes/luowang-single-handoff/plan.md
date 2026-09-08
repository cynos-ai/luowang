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
- 最终证据：`.cynos/acceptance/single-handoff/engineering-final/report.json`，local=passed、live=blocked、release=blocked；`test-typecheck-final.log` 通过。未进行真实模型语义复测、外部官网联合验收或发布，不能以本地通过宣布整体模型质量通过。
- 限制：无清理 adapter 时仅记录未完成；不新增跨 Run 污染自动分类、任意清理命令或硬杀进程后的清理恢复。仅本地提交，不 push/merge/release。
