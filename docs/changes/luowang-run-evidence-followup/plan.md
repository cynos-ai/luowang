# 后续实施计划

基线：v0.4.0 / main 53af48c；develop fd99e80，二者文件内容一致。分支：fix/reviewable-run-evidence，从最新 develop 创建。

## 顺序和完成条件

1. **证据来源和上传安全**：检查 Pi/MCP 原生事件接口，复用 command 通道捕获结果；封住自定义文本直传。专项验证凭据脱敏、来源白名单、Run 隔离、篡改和错误路径。对应 #68、AC-FOLLOWUP-01/02。
2. **场景进度**：记录操作发生时的归属和时间，补充执行前开始、执行后完成及辅助操作规则，验证事件顺序。对应 #64、AC-FOLLOWUP-03。
3. **报告披露**：修改共同、Runner 和 Reviewer 指令，明确不复述口令、不泛称无泄漏；回归角色隔离和凭据保护。对应 #65、AC-FOLLOWUP-04。
4. **工程验证与文档**：在 Dockerfile quality 环境运行专项、格式/lint/typecheck/build 及完整 local acceptance；更新 README 的现状和限制，复核 diff。对应 AC-FOLLOWUP-05。完成后按仓库规则提交到修复分支并创建面向 develop 的 PR，不直接提交长期分支。
5. **真实复验**：冻结通过工程检查的候选和 cynos-ai/cynos-website 的 target_commit，准备正常/注入缺陷/证据受阻各一次的具体方案。模型预算、非生产环境和副作用范围明确后执行；先同容器零模型预检，再检查真实四 Session、Reviewer 读取、时序、最小披露、清理和归档。保留失败，不追加样本追求通过。人工评分单独标记，不代替人工。

## 风险与停止条件

- MCP 代理事件未必包含请求的全部原始信息；必须核对固定依赖实际格式，不能把模型输入当作服务端结果。
- 凭据标识只用于同一 Run 内比对，不能使 Reviewer 取得可复用 Cookie。未知格式应保守隐藏并说明缺口。
- 进度规则不推断业务语义、不改变已成立功能结论；必要操作被错误拦截时修正归属设计，不放宽安全边界。
- 工程通过不等于 #68/#64/#65 的真实模型效果已验收；PR 使用关联说明，不提前自动关闭问题。
- 无预算或环境条件时完成全部工程工作并给出具体复验待确认项；不复用旧授权额度。

## 完成记录

- 计划已建立；Docker Desktop 的 desktop-linux 上下文可用。此前普通沙箱读取配置失败导致默认 endpoint 不可用，提升权限后的只读检查已确认 daemon 正常。
- 阶段 1：已接入真实 Pi tool_call/tool_result 事件，使用现有 command 类型保存 MCP/进度记录。Cookie 值只在内存比较，Run 内随机标识由证据 store 统一分配，初始化的两个 Runner 也不会重复使用歧义标识。未获准文本、trace/任意二进制、SVG 及伪装为截图的普通文本拒绝上传；获准证据上传固定字节。截图文件头检查不等于检查图片中的视觉隐私，原有账号不得入图规则仍适用。
- 原生回归发现固定 MCP 的 `headers()` 会省略真实 Cookie；已加入固定版本、源码形状校验及幂等的 `allHeaders()` 构建修补。真实 SDK 扩展与 MCP + 容器内合成 HTTP 服务已验证 Cookie 读取、恢复、完整详情、request-headers 分项及实际服务端接收值的关联，零模型请求。最初失败保留为本次发现过程，不算通过。
- 阶段 2：操作时冻结当前场景/辅助归属和时间，进度事件独立保存；控制台活动同步显示真实工具调用。零场景声明不强制生成上传依赖。此实现使后补事件可追查，不靠命令名判断业务归属，真实模型是否按指令正确报进度仍需阶段 5 复验。
- 阶段 3：共同、Runner、Reviewer 指令已明确不复述公开单测口令、按实际扫描范围报告，并审核进度与重放证据。工程测试不代替模型效果或人工评分。
- 中途回归修正：Harness writer 原白名单未包含 operation 文件；故障注入改为针对实际字节上传入口；零场景不应因进度证据引入 OSS 阻塞；场景模板测试兼容 Windows CRLF。保留 `.cynos/acceptance/run-evidence-followup/unit-1.log`、`local-1.log` 和 `local/` 的失败结果，最终验收使用独立不可变镜像。
- 构建使用固定 Node digest 和 lockfile；npmmirror 两次出现 ECONNRESET 后，使用现有 `NPM_REGISTRY=https://registry.npmjs.org` 构建参数成功安装相同依赖，未修改版本或执行 audit fix。
- 阶段 4 工程验证完成：最终不可变 quality 镜像运行 `npm run test:acceptance:local` 退出 0，41 项命令全部 passed，36 个测试文件 / 248 项测试通过，格式、lint、typecheck、build、E2E、Phase 9 与生产 Pi/恢复专项通过。新增测试另外执行严格 TypeScript 检查通过。报告为 `local=passed / live=blocked / release=blocked`，不是 live/release 通过。
- quality image ID：`sha256:87f9329946aedfec5397da22d84af6c00ff3ffc012982fcf8e3a00b89e745c7e`；runtime image ID：`sha256:c1ddf926e315b6f155d22116a5405f235bc4bec7310c9b9d2ff43f68a24584a3`。runtime 构建通过；与仓库 sandbox 脚本一致的只读、非 root、tmpfs、断网配置下，原生 MCP 预检 passed、modelRequests=0；只读 HOME 负例退出 1，失败阶段 state-directory。
- 最终证据：`.cynos/acceptance/run-evidence-followup/final-local/report.json`、`final-local/report.md`、`build-quality.log`、`build-runtime.log`、`runtime-preflight.json`、`runtime-preflight-denied.json`。中途 local-1 仅因旧镜像 README 格式失败而未通过，已由不可变最终镜像的完整重验覆盖；原记录未删除。
- 阶段 5：未运行。只读检查时当前主机没有运行中的 LuoWang 容器或同名数据卷；`.env` 没有本轮 live 环境/Provider/OSS/测试账号输入。不得将该事实扩大为远程环境不存在。

## 阶段 5 的具体复验方案（待环境和预算确认）

- 候选：本修复 PR 的已验证 commit 和 runtime 镜像；执行前冻结实际 SHA/digest。
- 目标：继续使用 cynos-ai/cynos-website；本次只读获取的 scenario-testing 为 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`。实际执行前核对它仍适合本轮测试，并固定完整 target_commit，不把移动 HEAD 当事实。
- 非生产正常样本一次：验证既有登录场景的适用期望，包括读取原 Cookie、退出、恢复、实际请求头与 401，以及删除后的原 Session 拒绝；Reviewer 必须从受控记录独立确认。按执行时序检查进度；新工件不复述口令且不作无范围的无泄漏声明。
- 注入缺陷样本一次：在独立可撤销沙箱保留服务端 Session，确认原 Cookie 请求仍成功而被检出。只改变沙箱行为，不提交官网产品代码；只读关联可信既有 Issue，不用注入问题污染正式产品分支。
- 证据受阻样本一次：在独立沙箱使必要重放证据不可用，确认该期望保持 blocked，不以无 Cookie 的 401 替代。该样本不是补跑正常样本，也不改历史报告。
- 建议全链路模型请求上限 400，正常/缺陷/受阻各一次；额度、认证错误或必需环境缺失即停，不续用旧轮预算，不追分。三组正式模型沿用项目约定，阶段 thinking 沿用产品策略。
- 写入范围：仅本轮 Run 的合成数据、既有 OSS 内本轮前缀、目标 scenario-testing 内当前 Run 报告及已获准场景 patch；历史 Run 和历史报告不可变。清理由受控 Run 标记 DELETE→独立 GET 核验，残余如实告警。无部署到日常实例、无 release/tag。
- 必需输入：非生产目标及可撤销缺陷/受阻条件、候选实例访问方式、Secret Store 中的模型/GitHub/OSS/测试账号/清理凭据和新预算批准。凭据通过受控配置提供，不写入对话、计划或 Git。
- 先在同容器做零模型预检，再运行三样本。保存请求数、Run/target、实际证据读取、事件顺序、脱敏扫描范围、清理和归档结果。未完成时 #68/#64/#65 保持开放，人工评分另记 not_run。
