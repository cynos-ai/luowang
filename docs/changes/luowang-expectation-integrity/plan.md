# 实施计划

1. 对照冻结 plan/execution/review 与现有角色指令，定位期望被降级的交接点；仅修改四份现有角色资源，不改运行时语义判断。
2. 执行格式、lint、typecheck、构建和既有角色/编排工程测试；保持正常 Run 四 Session、最终 Main 只读 plan/review。
3. 冻结候选源码、驱动、原工件和证据哈希，先做零模型请求的工具接线检查，再进行一次双 Session 原生回放。
4. 回放每 Session 最多32次请求、总计最多64次，每响应最多4096输出 Token、HTTP超时90秒，每 Session 最多15分钟。不作整轮重试、不降级模型、不存隐藏思考；HTTP/SDK重试受总预算约束并明确记录。费用不由 API total tokens 猜算。
5. 按 Spec 人工可读标准评估回放，记录是否受到原计划摘要缺失的限制。AI自审不冒充人类评分；未实际验证的阶段保持待验证。通过匹配范围检查后提交PR，不直接改日常运行实例。

## 本轮完成证明与未完成项

四份现有角色指令已修改，无运行时源码、工具或协议变更。固定质量镜像与候选package-lock一致；format/lint/typecheck、220测试/31文件和build通过。首次因只读Vite缓存失败，第二次无并发限制时宿主机高负载、交换空间耗尽，测试超时；第三次219通过/1失败，临时目录不可执行使Git竞争测试钩子未运行。保留全部记录，最终只为测试缓存提供tmpfs、将临时测试目录设为可执行并限制单worker、2CPU/2GiB，全部通过，没有修改测试断言或日常服务。

冻结候选、驱动、原计划/执行及16份证据后，生产角色/工具接线预检完成两次脚本化Session，模型请求0。唯一一次原生回放实际仅启动Reviewer Vision low：5次HTTP200、API total tokens合计97857；第5次输出达到4096 Token，其中reasoning计数2081，stopReason为length。这里只保留计数、不保存隐藏思考，SDK cost字段不作为账单。Reviewer已dispose，但未写出review.md；最终Main没有启动，未补造报告、未重跑或变更预算。

因此模型语义效果仍是未验证，不把截断归为业务failed/blocked，不认定候选有效或无效；最终Main规则以及新规划/Runner指令的真实效果也未验证。原工件和证据哈希不变，相关工件/Session记录凭据扫描零命中，日常两个服务仍健康且未更新。本轮保持候选，不部署；后续应先单独确认输出预算下的完整审核交付，再评价语义效果，而不是通过改期望或反复抽样追分。

原始证据放在 `.cynos/acceptance/expectation-integrity/`，不进入 Git。人类评分not_run；以上为AI自审及独立程序检查，不冒充人类验收。

## 后续授权的输出预算对照

用户再次授权继续后，另行冻结一次8192输出Token/响应、12请求/Session、24请求总上限的对照。原4096失败保留，不改候选、模型、thinking、上游工件或16份证据；开始前逐项核对systemPrompt/userMessage/config/工具schema与原记录一致。目录为budget-live-output，不覆盖live-output；未补入场景原文或事后数据，未执行业务Run或部署。

零模型预检通过。原生对照11次HTTP200（Reviewer 8次、最终Main 3次），两个实际SDK Session均正常stop/dispose；API total tokens为202116。Reviewer某次输出4581 Token，本次预算容纳了完整review/report，结构验证通过。此结论只证明本次完整交付，不是普遍预算保障。

语义目标仍未达到：Reviewer仍把DB存储要求当不可控但不阻塞的限制，称必要期望全部满足；最终Main继承passed。故PR保持Draft，不能以工程通过或完整交付冒充修复有效。凭据扫描零命中，冻结输入和旧失败均保留；不再抽样重跑这份候选。独立人类评分仍not_run。

## 下一实施范围：固定期望输入保真（尚未实现）

代码检查确认：Runner通过progressScenarios读取已应用合法patch的场景并验证唯一执行清单；Reviewer前validateScenarioPatchForReview会调用GitRepository.validateScenarioPatch，其finally清理工作树。因此不能在审核时直接读取当前工作树并冒称是Runner执行的版本。

推荐复用progressScenarios已有的读取与校验，在正式Runner开始前，冻结仅选中场景的完整正文及target/patch身份，作为Reviewer专属动态上下文的只读视图。它是Git与已验证patch的派生输入，不新建交接文件、报告字段、注册表或通用仓库/数据库工具；最终Main仍只读plan/review。不要用关键词抽取期望段落，以免再次删失语义。正文按不授予权限的测试数据处理，沿用受控脱敏；必要输入缺失、过大或无法安全提供时明确阻塞，不静默退化为Main摘要。

实施前补齐Spec；回归需覆盖清单子集、空清单、初始化与合法patch、Reviewer前工作树清理/变化不影响快照、输入大小和Secret边界、正常四Session及特殊审批流程。随后单独冻结新输入做预算受控验证；这一新条件不能被说成当前指令候选已通过。
