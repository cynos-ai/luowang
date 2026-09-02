# 罗网 v0.7 生产闭环补齐 Intent

- 状态：Approved v0.4
- 关联规格：[spec.md](./spec.md)
- 实现计划：[plan.md](./plan.md)
- 上游基线：[罗网 Harness MVP](../luowang-harness-mvp/intent.md)
- 权威设计：`罗网（LuoWang）场景测试 Harness 设计 · MVP Implementation Baseline v0.7`

## 1. 为什么需要这个变更

罗网 `v0.1.0` 已经实现主要框架，包括 Git/SQLite/OSS、固定 commit Run、Main · 规划 → Runner → Reviewer → Main · 最终汇总、场景维护、归档与 Issue、FIFO 队列、Playwright MCP、控制台和 Docker 部署。现有自动化测试也能使用本地仓库、样例应用和 test doubles 验证大量确定性规则。

但当前代码和发布说明把“本地 fixture 回归通过”表述成了“34 个 AC 全量验收完成”，而真实外部 smoke 仍为 blocked；同时，生产路径存在几项会阻止 v0.7 闭环成立的缺口：

1. 角色方法全部硬编码在 Orchestrator 长提示词中，同一内容还同时作为 system prompt 和用户消息发送；Pi Skills 已被安全禁用，但罗网也没有版本化、按角色隔离的内置角色指令资源；
2. 用户指定 branch/tag/SHA 时，merge 和测试是两个独立动作，普通 Run API 还允许直接传任意 target，可能绕开固定 `scenario-testing` 分支；首次创建该分支的同步接口也与初始化 Run 分离，没有进入 prepared/resolved、唯一 Run 和重启恢复闭环；
3. 生产默认测试数据管理器只能登记数据，没有“Runner 已通过 UI/API 删除并确认”的路径；只要登记数据且没有注入测试适配器，Run 就会被强制 blocked；
4. 当前场景和执行进度只在 Run 创建时初始化为 `null`、`0/0`，真实 Runner 不会上报变化；
5. Main · 规划只得到 Git 正式报告摘要和 GitHub Issues，无法查询 SQLite 中特殊 blocked、interrupted、场景 PR 和归档失败等详细历史 Run；
6. Phase 9 默认验收使用 `FixtureSessionFactory` 和直接 Playwright，未走真实 `createAgentSession()` 模型工具循环，也没有完成真实 Provider + Pi + Playwright MCP + OSS + 非生产应用的联合证明；
7. README 对验收状态和本地原生依赖的说明不准确。

这些问题不要求推翻现有架构，但如果不补齐，就不能可信地宣称实现满足 v0.7，也不能把下一版本作为完成真实生产闭环的版本发布。

## 2. 期望结果

完成本变更后，罗网应具备以下可观察结果：

1. Main · 规划、Runner、Reviewer、Main · 最终汇总和初始化方法成为罗网自身版本化的 Built-in Role Instructions（内置角色指令），由应用按 Session 确定性加载并完整注入；它们是发布物中的固定 Markdown 资源，不是 Pi Skills；目标仓库、宿主机和用户目录中的 Skills 仍不会被发现或执行；
2. 固定方法、安全边界、动态 Run 上下文和本次请求分层传递，不再重复注入同一长提示词；不同角色只看到自己需要的动态事实；
3. 人工 merge 请求进入现有 SQLite FIFO，在轮到它时生成可跨重启恢复的 prepared commit，完成 `non-force push → 固定 resolved target → Run`；远端场景测试分支不存在时，同一 `manual-merge-source + initialization=true` 请求从用户指定 commit 安全创建分支并且只创建一个初始化 Run；prepared commit 在本地持久 Git 仓库中保持可达，普通人工测试和首次建分支都不能绕开队列；
4. Runner 可以登记测试数据并通过 UI/API 删除，但 Runner 的清理声明或自填文本不能直接变成完成事实；只有受控 adapter 独立核验，或 Reviewer 读取由 Harness 直接捕获的工具/adapter 输出或 Playwright 截图后确认，数据才视为已清理，任何未确认残留仍可靠地使结果 blocked；
5. 网站在真实执行中显示总场景数、已完成数、当前场景和脱敏活动，而不是只依赖 UI fixture；
6. Main · 规划可以按需查询有限、只读、相关的历史 Run 摘要；Main · 最终汇总先从本次 `draft-report.md` 和 `review.md` 形成 Bug 候选，再通过受限只读工具查询可能相同的历史 Issue/Run 并决定 create/link；Runner 和 Reviewer 均不获得历史查询工具；
7. 本地自动化验收与真实外部联合验收明确分层：本地通过不能冒充 live 通过，发布验收在任何必需外部证明 blocked 时必须失败；
8. 使用独立、可信、非生产测试项目完成真实 Provider、Pi Agent、Playwright MCP、OSS、GitHub、数据清理、归档、Issue 和进度闭环；
9. README 准确说明已实现、已本地验证、尚未 live 验证和本地构建前置条件；
10. 保留已发布 `v0.1.0` tag，不移动、不删除、不重写；只有本变更全部验收通过后才创建后续 SemVer tag。

## 3. 受影响的人和系统

### 人

- **项目负责人/测试操作者**：需要确认真实验收项目和非生产环境，提供最小权限凭据并授权测试产生与清理数据；
- **实现 Agent**：按本目录 Spec 和 Plan 分阶段补齐现有 owner，不重新设计 Harness；
- **审核 Agent**：区分本地 fixture、生产路径集成和真实外部证据，不接受“未运行但视为成功”；
- **后续使用者**：获得准确的部署、依赖和验收状态说明。

### 系统

- 三组 Agent 配置、四个隔离 Session、Prompt/Tool 组装；
- SQLite 测试请求队列和 Repository Service；
- Run Orchestrator、测试数据管理、Gateway 当前状态和 Run Store；
- Phase 9 acceptance harness、CI 和 README；
- 独立目标 GitHub 仓库、非生产样例应用、模型 Provider、Playwright MCP 和 S3-compatible OSS。

## 4. 约束

- v0.7 PDF 是本变更的产品与架构权威；本变更只细化其生产闭环，不增加相反设计；
- 保留单实例、单租户、单目标仓库、单场景测试分支、单测试环境、单 active Run 和 FIFO；
- 不引入多阶段 checkpoint、通用工作流引擎、发布 gate、多 worker、复杂 worktree 或新的长期状态文件；首次建场景分支复用 `manual-merge-source` 和既有 `initialization` 字段，不增加第四种请求；
- 继续使用 `passed | failed | blocked`，不照搬其他项目的五状态、三轴结论或复杂聚合模型；
- 罗网始终只有 `agents.main`、`agents.runner`、`agents.reviewer` 三组 Agent 配置；正常 Run 创建 Main · 规划、Runner、Reviewer、Main · 最终汇总四个互相隔离的 Session，不增加 Planner/Finalizer 配置；
- 内置角色指令只规定工作方法，不提供权限；所有读取、写入、Secret 和副作用权限继续由代码中的 custom tools、Secret Store、adapter、writer、路径 allowlist 和 patch 校验强制执行；
- 保持 `noSkills=true`，不创建 `SKILL.md`、不使用 `skillsOverride`、不启用 Pi Skill 自动发现；ambient Prompt、Context 和宿主机/目标仓库资源发现也保持关闭；不得为了读取内置角色指令给 Agent 开放任意文件 `read`，也不得允许网站配置任意角色指令路径；
- Main · 规划和 Main · 最终汇总均不获得测试账号；Reviewer 不获得测试账号、命令和 Git 写入；Runner 不获得 Git Token、模型 Key、OSS Secret、管理员密码或主密钥；
- 所有正式测试 target 必须是远端场景测试分支上的不可变 commit；merge 冲突不得由 Agent 修改产品代码解决；
- 真实验收只连接操作者确认可信的仓库和非生产环境，使用合成数据和专用账号；
- 凭据只通过进程环境、Docker Secret 或网站 Secret Store 提供，不写入 Git、需求文档、PR、Issue、测试报告或普通日志；
- 本变更不把 `cynos-ai/luowang` 作为目标仓库，不建立实例互测；
- 保持 `main + develop + feat/*/fix/*` 和 PR 流程；每个实施阶段独立闭环。

## 5. 明确不做

本变更不负责：

- 重新实现已经成立的 Git、归档、场景模式、认证、OSS 或控制台主体；
- 允许网站任意配置或执行宿主机 Skill、Prompt、脚本或清理命令；
- 从目标仓库加载 `.pi/skills`、`.agents/skills`、`AGENTS.md` 或用户全局 Skill；
- 建立 `suite`、`catalog`、`journey`、能力图、审批 hash 或复杂 workflow gate；
- 支持对任意历史 SHA 的通用测试入口；
- 自动修复产品代码、自动解决 merge 冲突或调度开发 Agent；
- 使用生产账号、生产数据库、真实用户数据或未经授权的外部副作用；
- 把 test double、直接 Playwright 或本地 S3 stub 当作真实联合验收；
- 重写 `v0.1.0` 历史。

## 6. 人类必须提供或确认的内容

除最后的真实联合验收外，其余实现阶段不得因缺少外部 Secret 而停工。进入真实验收前，项目负责人必须提供或确认：

1. **测试项目**：默认继续使用 `https://github.com/cynos-ai/cynos-website`；确认它是可信、允许写入测试资产和创建测试 PR/Issue 的独立目标，而不是罗网仓库；live 首次建分支验收开始时，该目标的已配置 `scenario-testing` 必须不存在且可由指定初始 commit 创建，若默认项目不能安全提供该前置条件则必须换用新的独立测试仓库；
2. **GitHub 权限**：仅授予该测试仓库的临时或专用 Token，允许 Metadata 读取、Contents 读写、Pull Requests 读写和 Issues 读写；不授予组织管理、Actions 管理或其他仓库权限；
3. **非生产应用**：可访问的测试/预发布 Base URL、环境说明、允许验证的 API/UI 流程、可控的 passed/failed/blocked 条件，以及确认不会触碰生产数据；
4. **测试账号和清理能力**：专用账号及角色、测试数据命名约束、通过 UI/API 删除本次数据的方式，以及可独立证明数据已不存在的脱敏查询/截图/API 证据；如果环境不能删除或不能验证临时数据已清理，则不能完成 live 验收；
5. **模型 Provider**：Provider 标识、API Key、Main/Runner/Reviewer 模型 ID、thinking level；Reviewer 模型必须支持本次截图审核所需的图像输入；
6. **OSS**：S3-compatible endpoint、region、私有 bucket、专用 object prefix、Access Key ID/Secret；权限只覆盖该 prefix 的 put/get/head/delete；
7. **候选罗网实例**：`LUOWANG_ADMIN_PASSWORD`、`LUOWANG_MASTER_KEY`、本地或非生产访问地址，以及需要时的 `LUOWANG_ALLOWED_ORIGIN`；
8. **网络和费用授权**：确认候选容器能访问 GitHub、Provider、OSS 和样例应用，并接受本次真实模型、浏览器和 OSS 调用产生的有限费用；
9. **发布权限与版本**：具备向 `cynos-ai/luowang` 创建 PR/tag 的权限，并在验收通过后确认下一个版本使用 `v0.1.1` 还是 `v0.2.0`。

具体字段、交付方式、最小权限和缺失时行为由 [spec.md](./spec.md) 固定，并在 [plan.md](./plan.md) 中按阶段列出。

## 7. 成功判断

本变更成功不以“新增了多少文件或测试”为标准，而以以下事实同时成立为准：

- 已知生产路径缺口均有用户可观察的修复和自动回归；
- 本地与 live 均从目标仓库尚无 `scenario-testing` 开始，证明 `manual-merge-source + initialization=true` 经 internal ref、prepared/resolved 和唯一 Run 创建分支并进入陌生项目初始化；实际 Pi SDK Session 而非 FixtureSessionFactory 分别证明正常四 Session Run、初始化直接新增场景的六 Session 流程，以及需要场景 PR 时立即结束的三 Session 特殊 blocked 流程，覆盖模型消息、受控工具循环、Session 隔离与 dispose；
- 真实联合 Run 在独立非生产项目上完成并可由 Run、commit、报告、截图、OSS object、PR/Issues 和清理结果复核；
- 本地与 live 结果被准确区分，缺少任何 live 前置条件时明确 blocked 且不能发布；
- 没有通过补复杂状态机、放宽安全边界或增加未来架构来“解决”问题。

## 8. 待确认事项

没有阻塞前六个实施阶段的产品问题。最终 live 阶段前只需要项目负责人完成第 6 节的资源确认，并在发布前决定下一个 SemVer。任何 Secret 的实际值都不能写入本目录。
