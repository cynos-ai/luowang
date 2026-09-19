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
- quality 构建配置 digest：`sha256:87f9329946aedfec5397da22d84af6c00ff3ffc012982fcf8e3a00b89e745c7e`；runtime 构建配置 digest：`sha256:c1ddf926e315b6f155d22116a5405f235bc4bec7310c9b9d2ff43f68a24584a3`，对应可运行镜像清单 ID 为 `sha256:37b5ba199d32531e6fe4536d0799c43c7816df348b06682502ce8d102c9984c7`。runtime 构建通过；与仓库 sandbox 脚本一致的只读、非 root、tmpfs、断网配置下，原生 MCP 预检 passed、modelRequests=0；只读 HOME 负例退出 1，失败阶段 state-directory。
- 最终证据：`.cynos/acceptance/run-evidence-followup/final-local/report.json`、`final-local/report.md`、`build-quality.log`、`build-runtime.log`、`runtime-preflight.json`、`runtime-preflight-denied.json`。中途 local-1 仅因旧镜像 README 格式失败而未通过，已由不可变最终镜像的完整重验覆盖；原记录未删除。
- 阶段 5：已执行部分，因 GitHub 推送 403 停止。更正此前检查：本机 `.env` 已有模型、GitHub、OSS 配置，未使用 `LUOWANG_LIVE_*` 名称不等于凭据缺失。本轮使用独立非生产沙箱。
- 2026-09-19 用户回复“继续”，已批准本轮总计 400 次模型请求，正常/缺陷/证据受阻各一次，不追加补跑。固定文本和视觉模型各一次最小可用性调用均返回成功，已计入 2/400；模型目录未列出这些 ID，但实际调用可用。OSS 本轮前缀的探针写入、读取、删除成功。
- PR #71 的 quality CI 已通过（run 35421034123，13m49s）；真实复验仍未计为通过。
- 首次沙箱启动误用构建配置 digest，Docker 未启动 Harness；零业务 Run、无新增模型请求，三个沙箱独立数据库均为 0 用户 / 0 Session 后撤销。已修正为同次构建的镜像清单 ID，保留 `live-launch-1.log` 与对应清单、计数。随后三个目标的同容器原生预检均 passed；正常样本已启动。

## 阶段 5 的具体复验方案（本轮已停止）

- 候选：本修复 PR 的已验证 commit 和 runtime 镜像；执行前冻结实际 SHA/digest。
- 目标：继续使用 cynos-ai/cynos-website；本次只读获取的 scenario-testing 为 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`。实际执行前核对它仍适合本轮测试，并固定完整 target_commit，不把移动 HEAD 当事实。
- 非生产正常样本一次：验证既有登录场景的适用期望，包括读取原 Cookie、退出、恢复、实际请求头与 401，以及删除后的原 Session 拒绝；Reviewer 必须从受控记录独立确认。按执行时序检查进度；新工件不复述口令且不作无范围的无泄漏声明。
- 注入缺陷样本一次：在独立可撤销沙箱保留服务端 Session，确认原 Cookie 请求仍成功而被检出。只改变沙箱行为，不提交官网产品代码；只读关联可信既有 Issue，不用注入问题污染正式产品分支。
- 证据受阻样本一次：在独立沙箱使必要重放证据不可用，确认该期望保持 blocked，不以无 Cookie 的 401 替代。该样本不是补跑正常样本，也不改历史报告。
- 已批准全链路模型请求上限 400，包含 2 次模型就绪调用及全部重试；正常/缺陷/受阻各一次。额度、认证错误或必需环境缺失即停，不续用旧轮预算，不追分。三组正式模型沿用项目约定，阶段 thinking 沿用产品策略。
- 写入范围：仅本轮 Run 的合成数据、既有 OSS 内本轮前缀、目标 scenario-testing 内当前 Run 报告及已获准场景 patch；历史 Run 和历史报告不可变。清理由受控 Run 标记 DELETE→独立 GET 核验，残余如实告警。无部署到日常实例、无 release/tag。
- 必需输入：非生产目标及可撤销缺陷/受阻条件、候选实例访问方式、Secret Store 中的模型/GitHub/OSS/测试账号/清理凭据和新预算批准。凭据通过受控配置提供，不写入对话、计划或 Git。
- 先在同容器做零模型预检，再运行三样本。保存请求数、Run/target、实际证据读取、事件顺序、脱敏扫描范围、清理和归档结果。未完成时 #68/#64/#65 保持开放，人工评分另记 not_run。

## 2026-09-19 真实复验结果

固定候选 `7eaee52c0ec6d52c7589fbee4de079808d90323e`，目标 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`。本轮共 155/400 次模型请求：就绪检查 2 次，正常样本 81 次，缺陷样本 72 次。没有重跑。余下额度未继续使用。

| 样本 | Run | 实际结果 | 归档 |
| --- | --- | --- | --- |
| 正常 | `01M2VZGC4D8AGZWPT164BBW0TV` | **passed**，四个隔离 Session 完成 | 推送 403，未发布 |
| 注入缺陷 | `01M2VZRMWRAT69BFB9CM80P0BC` | **interrupted**，Reviewer 阶段停止，无最终结论 | 未归档 |
| 证据受阻 | 未创建 | **not_run**，仅零模型预检通过 | 无 |

- 正常样本：55 条受控记录，其中 50 条浏览器操作；独立证据读取 70 次，已读取对象的本地哈希全部匹配。Reviewer 根据 Run 内相同凭据标识，确认退出和删除后的请求确实携带原 Session 且返回 401；四项原文期望均通过。场景开始/完成与实际操作顺序一致，前置导航与失败的辅助命令仍标记 auxiliary。辅助 e2e 命令因目标工作区没有 tsc 未运行成功，不计作测试套件通过。
- 当前正常 Run 的 Markdown 未命中已知配置凭据、预置账号/口令或目标 auth.test.ts 中提取的公开口令字面量。扫描范围和方法见 `normal-disclosure-scan.json`、`live-audit.json`，不能扩大为所有历史文件或图像均无披露。
- 截图人工查看确认登录邮箱框仍显示本轮合成账号标识，密码框为掩码。账号已删除，但“账号不得入图”没有完全满足，需补充截图前清空账号字段等操作规则并另行验证；不重写本轮证据或宣称披露问题已全部解决。
- 归档先报“远端并发更新”，只读 `git push --dry-run` 诊断确认实际为当前 GitHub Token 推送权限 403。发现后立即暂停 Harness；当时缺陷样本已进入 Reviewer。执行受控 DELETE→独立 GET，两条 Run 均 remaining=0；三个沙箱独立 SQLite 查询均 users=0、sessions=0，然后终止 Harness 并撤销本轮容器和网络。未切换凭据绕过本轮停止条件。
- GitHub 仓库信息接口返回 push=true 不能证明当前 Token 具备实际 Contents 写入能力。复验候选把所有 report push 命令错误映射为并发冲突，掩盖了权限错误；后续付费 Run 前应先检查实际推送权限。
- 停止模型后已完成两项修补：报告推送区分认证/权限拒绝、实际非快进冲突及其他连接/远端失败，错误不回显账号或原始 stderr；Runner 指令增加截图前清空账号和口令字段、核对截图及状态不可改变时保留缺口。quality 容器格式、lint、typecheck、36 文件 / 251 单测及 build 全部通过，退出 0（`post-live-quality.log`）。新增三项回归确认分类正确、远端报告未写入、工作区恢复干净。两项修补发生在真实样本之后，未进行新的模型验证。
- 证据保存在 `.cynos/acceptance/run-evidence-followup/`：`live-manifest.json`、`driver-hashes.json`、`live-data/proof/`、`live-audit.json`、`git-diagnostic.json`、`stopped-budget.json`、`stop-cleanup.json`、`live-independent-database-counts.json`、`live-launch.log`。中断 Run 的本地工件保留，未伪造完整报告。
- 当前结论：local=passed；正常样本证明重放证据可供 Reviewer 独立审核，但三样本与归档未完成，整体 live/release=blocked，humanScoring=not_run。#68/#64/#65 保持开放；无合并、发布、日常部署或历史报告改写。

## 后续顺序

1. 正常 Run 的幂等归档已完成，见下方补记。项目 `.env` Token 仍缺目标写入权限；本次只在独立归档进程使用已有 GitHub CLI 登录凭据，未更改持久凭据配置。
2. 已完成归档错误分类和截图账号字段指令修补及工程回归；实际 Token 权限问题仍须修复，截图指令的模型效果尚未复验。
3. 单独确认新的复验范围与预算后，再处理缺陷/证据受阻的未完成验收；本轮不追加样本，不以剩余额度自动重跑。通过后再决定 #68/#64/#65 的关闭、PR 合并及发布。

## 归档补记与下一轮准备

- 用户再次要求继续后，核对 `7b1c27d35d08bcdd295ea07bfb751ce42b32225b` 的 quality CI 已通过。Git 权限检查最初因诊断容器 `/tmp` 不可执行导致 askpass 失败，按既定 sandbox 配置补回 exec 后确认：项目 `.env` 凭据仍返回 403，已有 GitHub CLI 登录凭据通过只读推送预检。诊断失败及结果分别保存在 `git-access-recheck-1/2.json` 与 `git-access-recheck.json`。
- 使用 GitHub CLI 凭据的进程内覆盖完成正常 Run `01M2VZGC4D8AGZWPT164BBW0TV` 归档，未写回 `.env` 或 Secret Store。提交 `5c0b294d88726ee35f4ed2abb1be45f90f5c54f8` 只新增本 Run 的 `review.md`、`report.md`；与本地原件逐字节一致，重复归档返回同一提交，Indexer 已回读。没有新增模型调用、Issue 或场景 patch。证据：`normal-archive-retry.json`。
- 正常 Run 的历史首次归档失败记录不变；缺陷中断、受阻未运行、截图标识问题与整体 live/release=blocked 仍保留。项目配置 Token 的长期权限修复仍待处理，不能将本次 CLI 凭据可用写成配置已修好。
- 下一轮建议：基于已通过 CI 的 `7b1c27d`，仍固定目标 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`，只新增缺陷与证据受阻各一次样本，不重跑已通过的正常样本；合计最多 300 次模型请求，计入全部重试。沿用隔离沙箱、三组模型、四 Session、Run 清理和报告范围，同时核对截图字段处理。先实际 Git 推送权限和同容器原生预检，任何归档失败也停止后续样本。此新范围及预算尚未获批，不自动续用上一轮剩余额度。

## 第二轮授权与模型就绪检查

- 用户明确要求“继续，测试的模型使用 deepseek-v4.1-flash”，批准上述缺陷/受阻各一次、总计 300 次的新轮方案，并覆盖本轮原模型约定。仍保留 Main/Runner/Reviewer 三组配置及正常四 Session，不将模型目录缺项自动视为不支持。
- 已准备的 runtime 镜像 `sha256:8d7c21b86a97a2fb56581062cd5fe4cfb00436aed0dca654900765c79dba01b8` 包含 `7b1c27d` 的后补修复，构建及断网、只读、非 root 原生 MCP 预检 passed，预检 modelRequests=0。
- 对用户指定模型的首次文本就绪请求返回 400；随后一次去除可选参数的最小请求也返回 400，接口明确说明仅接受 `deepseek-flash`、`deepseek-v4-pro`，不接受 `deepseek-v4.1-flash`。只读 `/models` 清单与该错误一致，本地 Pi 目录也无该 ID。本轮计数 2/300，未调用视觉模型、未创建业务 Run 或测试账号。
- 已请求用户确认使用服务端 `deepseek-flash`，或更新支持指定 v4.1 ID 的受控接口配置；未擅自替换模型或宣称别名等价。检查事实保存在 `.cynos/acceptance/run-evidence-followup-v41/model-readiness.json` 和 `model-diagnostic.json`。待模型名称/接口确认后，沿用本轮已批准预算，不重复请求预算授权。
