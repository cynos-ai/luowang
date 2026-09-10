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

## 第二阶段：固定期望输入保真

代码检查确认：Runner通过progressScenarios读取已应用合法patch的场景并验证唯一执行清单；Reviewer前validateScenarioPatchForReview会调用GitRepository.validateScenarioPatch，其finally清理工作树。因此不能在审核时直接读取当前工作树并冒称是Runner执行的版本。

本阶段按以下方案实施：复用progressScenarios已有的读取与校验，在正式Runner开始前，冻结仅选中场景的完整正文及target/patch身份，作为Reviewer专属动态上下文的只读视图。它是Git与已验证patch的派生输入，不新建交接文件、报告字段、注册表或通用仓库/数据库工具；最终Main仍只读plan/review。不要用关键词抽取期望段落，以免再次删失语义。正文按不授予权限的测试数据处理，沿用受控脱敏；必要输入缺失、过大或无法安全提供时明确阻塞，不静默退化为Main摘要。

Spec已补齐，新增selected-scenarios内存视图构造，正式Runner通过progressScenarios的freezeForReview路径冻结；候选规划阶段只校验，不冻结也不因快照构造留下旧阻塞。原文脱敏保留redacted标识及原始/交付双hash，必要判断仍由模型负责；身份无法安全交付、超限等不提供部分快照。Reviewer前缺失快照会明确阻塞。无新增工具、报告字段或长期工件。

工程验证通过230测试/32文件、format/lint/typecheck/build和受影响测试的严格编译。新增测试覆盖只给Reviewer选中原文、与Runner实际读到的合法patch正文一致、空清单、不可变对象、脱敏与双hash、身份/文本/大小拒绝；Secret读取失败及超限保持正常四Session但结果blocked。既有初始化/特殊审批和真实本地Pi路径回归通过。保留失败：首次tmpfs工作目录权限、重复Vitest超时参数、旧文案读取顺序断言；修正为固定原文→计划→原证据→execution的检查后通过。严格测试编译首次继承exclude tests，补正临时配置后通过。

唯一一次新输入回放前，冻结源代码和原工件/16份证据，从原target的Git对象导出场景正文并记录blob/hash；生产选择/冻结函数重建只含AUTH-REGISTRATION-001的快照。零模型双阶段预检通过。原生Reviewer Vision low实际5次HTTP200，API total tokens合计88643；第5次输出8192 Token、reasoning计数6190，stopReason为length。Reviewer已dispose，但没有review.md，最终Main没有启动；未提高预算、重跑或保存隐藏思考。

独立程序检查确认原文已进入Reviewer初始上下文，字节/hash与固定Git对象一致，前置Harness阻塞为空；旧工件、16份证据及此前失败均未修改，无事后DB证据。工程输入保真已验证，模型语义效果仍未验证，不能从截断推断模型已正确判断。保持PR #63为Draft，未部署；人类评分not_run。详细记录在`.cynos/acceptance/selected-scenario-source/`。

### 再次授权后的16384预算对照

用户再次授权继续后，保持实现、原文、计划/执行、证据、指令、模型和thinking不变，仅改为16384输出Token/响应、每Session最多8请求、总11请求；初始消息/config/工具schema逐项一致。原8192轮实际输出9644，加本轮理论最大180224，共189868，小于原24×8192的196608输出额度；这不是输入Token或费用上限。旧失败不覆盖。

零模型预检通过。本次10次HTTP200（Reviewer 7、最终Main 3），两个SDK Session均stop/dispose，结构验证通过；API total tokens为210899，output合计21062。Reviewer最长响应输出11013，其中reasoning8584；只记录计数，没有保存隐藏思考。

**截至本次，语义目标仍未达到。** Reviewer明确承认固定正文中的DB不存明文期望未验证、执行以较弱命题替代，却仍将其作为不阻塞的证据可得性限制，标记passed；最终Main沿用passed。因此不能再把这个样本的误判仅归因于摘要缺失或输出截断，也不能把成功交付当修复成功。原输出保存于budget-live-output，输入/源身份和Secret扫描检查通过；没有部署、发布报告或改写历史。

后续应先审查判定规则中“必要”“主要功能”“辅助记录”的界限：明列且适用的期望应是通过条件，适用性与验证能力不能混同；未发现产品失败不等于所有期望已得到支持。不能用关键词门禁代替这项语义判断，也不继续扩仓库/数据库权限。若调整准则，需独立、有限地验证一般性，而不是不断抽样直到本题通过。PR #63保持Draft；以上为AI自审，不是独立人类验收。
