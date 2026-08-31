# 罗网 v0.7 生产闭环补齐实施计划

- 状态：Implementation Plan v0.4
- 关联 Intent：[intent.md](./intent.md)
- 关联 Spec：[spec.md](./spec.md)
- 上游计划：[罗网 Harness MVP Plan](../luowang-harness-mvp/plan.md)
- 实施方式：Closure Phase 0–7 顺序执行；每阶段独立分支、PR、验证、退出条件和 AC 证据

## 1. 计划目标

本计划在现有 `v0.1.0` 代码上补齐 v0.7 的生产闭环，不重新执行旧 Phase 0–9，也不以重写代替增量修复。

完成后必须同时证明：

1. 角色方法被确定性、按角色、安全地加载；
2. 所有正式 target 都来自固定场景测试分支；该分支首次创建也经过 FIFO、prepared/resolved 和唯一初始化 Run；
3. 测试数据、当前进度和历史 Run 在生产路径中真实可用；
4. 本地验收真实经过 Pi SDK Session，而不是只调用 FixtureSessionFactory；
5. 真实 GitHub、Provider、Pi、MCP、OSS 和非生产应用联合验收通过；
6. 文档和发布状态不夸大证明范围。

## 2. 实现 Agent 执行契约

每个阶段的实现 Agent 必须：

1. 阅读 `AGENTS.md`、`docs/PROJECT.md`、本目录 `intent.md`、`spec.md`、`plan.md`，并读取将修改模块的生产代码和测试；
2. 从最新 `develop` 创建本阶段指定分支，不依赖未合并分支或本地未提交文件；
3. 先扩展现有 owner：Session/Orchestrator、Queue/Automation、TestDataManager、Operations、RunStore、Acceptance；
4. 只实现本阶段范围，不顺手升级依赖、拆服务、增加状态机或重构无关 UI；
5. 生产代码不得包含仅为测试存在的假 Provider、假 Agent、假 OSS 或跳过开关；
6. 自动测试可以使用临时 Git、HTTP、模型协议和 S3-compatible test double，但必须明确它证明的层级；
7. 运行公共校验和专项校验，PR 记录命令、结果、AC、用户可观察变化、未运行的 live 项和风险；
8. 退出条件未满足时不进入下一阶段；外部资源只允许阻塞 Closure Phase 7，不能成为前六阶段不实现本地逻辑的理由。

任何 Agent 都不得把真实 Token、Key、密码或账号写进测试 fixture、源码、文档、PR、Issue、日志或验收产物。

## 3. 公共工程和验证约束

每个代码阶段至少运行：

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

若宿主机缺少 `better-sqlite3` 原生编译依赖，使用仓库 `quality` Docker target 运行同一命令，不得因此跳过。每阶段还必须：

- `git diff --check` 通过；
- 生产 Docker build 通过；
- 新 migration 可从空库执行并从 `v0.1.0` schema 前向升级；
- Secret 扫描为阴性；
- 既有 34 AC 的本地回归不倒退；
- 没有修改 `v0.1.0` tag 或历史报告；
- 没有在 `cynos-ai/luowang` 创建 `scenario-testing`、测试 PR、测试 Issue 或测试资产。

## 4. 外部资源门禁

### 4.1 前六阶段

Closure Phase 0–6 不需要真实 GitHub Token、Provider Key、测试账号或 OSS Key。Agent 不应提前向用户索要 Secret。需要证明外部边界时使用本地 test double，并在结果中标记为 local。

### 4.2 Closure Phase 7

进入 Phase 7 前，项目负责人一次性完成以下清单。Secret 实际值只放在本地进程环境、被忽略的操作者文件、Docker Secret 或候选实例 Secret Store：

| 类别 | 人类提供/确认 | 最小权限或要求 | 缺失结果 |
|---|---|---|---|
| 测试仓库 | 默认 `https://github.com/cynos-ai/cynos-website`，或明确替换 URL；用户确认的初始 branch/tag/SHA | 可信、不是罗网仓库、允许测试写入；live 开始时 `scenario-testing` 不存在且可从初始 commit 创建 | Phase 7 blocked |
| GitHub Token | `LUOWANG_LIVE_GITHUB_TOKEN` | 仅该仓库 Metadata read、Contents read/write、PR read/write、Issues read/write | Phase 7 blocked |
| 非生产应用 | `LUOWANG_LIVE_BASE_URL`、环境说明 | 非生产、合成数据、一个 passed 流程、两个独立可逆 failed 条件、一个 blocked 条件、可删除并独立核验测试数据 | Phase 7 blocked |
| 测试账号 | username/password 及角色 | 专用、非个人/生产账号，只给 Runner | Phase 7 blocked |
| Provider | Provider、API Key、三个模型 ID/thinking | 模型可认证；Reviewer 支持截图所需图像输入 | Phase 7 blocked |
| OSS | endpoint/region/private bucket/prefix/Access Key | 只允许专用 prefix put/get/head/delete，按需 list | Phase 7 blocked |
| 候选实例 | Admin Password、Master Key、可选 Allowed Origin | 独立持久卷、本地/非生产入口、非 root、无 Docker socket | Phase 7 blocked |
| 网络/费用 | 出口和本次调用额度 | 能访问四类外部系统，允许有限测试费用 | Phase 7 blocked |
| 发布 | `cynos-ai/luowang` PR/tag 权限和 SemVer 选择 | 不移动 `v0.1.0` | 只能完成验收，不能发布 |

非 Secret 配置可以写入验收记录；Secret 只能记录 `configured: true/false`。项目负责人还需确认验收结束后测试账号、Token 和 OSS Key 是撤销、轮换还是继续作为专用凭据保留。

### 4.3 给项目负责人的实际交付模板

进入 Closure Phase 7 时，实现 Agent 先把下面模板交给项目负责人。非 Secret 可以回复给 Agent；Secret 实际值不要粘贴到需求、聊天转录、PR 或 Issue，而是在运行验收的机器上设置：

```text
# 非 Secret：需要明确回复
TEST_REPOSITORY_URL=https://github.com/cynos-ai/cynos-website
SCENARIO_BRANCH=scenario-testing
SCENARIO_BRANCH_ABSENT_AT_START=yes|no
INITIAL_SOURCE_REF=
REPOSITORY_IS_TRUSTED=yes|no
TEST_BASE_URL=
ENVIRONMENT_DESCRIPTION=
NON_PRODUCTION_CONFIRMED=yes|no
PASSED_FLOW_DESCRIPTION=
FAILED_CONDITION_1_AND_RESET=
FAILED_CONDITION_2_AND_RESET=
BLOCKED_CONDITION_AND_RESET=
TEST_DATA_PREFIX_RULE=luowang-<run-id>-
TEST_DATA_DELETE_PROCEDURE=
TEST_DATA_ABSENCE_VERIFICATION=
ALLOWED_EXTERNAL_TARGETS=
TEST_ACCOUNT_ROLE=
PROVIDER_ID=
MAIN_MODEL_ID=
MAIN_THINKING=
RUNNER_MODEL_ID=
RUNNER_THINKING=
REVIEWER_MODEL_ID=
REVIEWER_THINKING=
REVIEWER_SUPPORTS_IMAGE=yes|no
MODEL_COST_BUDGET=
OSS_ENDPOINT=
OSS_REGION=
OSS_BUCKET=
OSS_PREFIX=
OSS_PRIVATE_CONFIRMED=yes|no
CREDENTIAL_CLEANUP_DECISION=revoke|rotate|retain-dedicated
NEXT_VERSION_DECISION=after-acceptance

# Secret：只在验收机器设置，不回复值
LUOWANG_ADMIN_PASSWORD
LUOWANG_MASTER_KEY
LUOWANG_LIVE_GITHUB_TOKEN
LUOWANG_LIVE_TEST_USERNAME
LUOWANG_LIVE_TEST_PASSWORD
LUOWANG_LIVE_PROVIDER_API_KEY
LUOWANG_LIVE_OSS_ACCESS_KEY_ID
LUOWANG_LIVE_OSS_ACCESS_KEY_SECRET
```

若需要多个角色账号，项目负责人通过候选实例 Secret Store 逐个配置，不把账号清单及密码写入上述非 Secret 文本。两个 `FAILED_CONDITION_*_AND_RESET` 必须对应不同产品行为和不同 bug key；所有 failed/blocked 条件都必须是可逆、非生产、不会长期破坏样例环境的操作。`TEST_DATA_ABSENCE_VERIFICATION` 必须说明删除后如何得到脱敏截图或查询结果；只写“让它失败”或“已清理”不算可执行输入。

## 5. 阶段总览

| 阶段 | 建议分支 | 独立闭环结果 | 主要 AC |
|---|---|---|---|
| Closure 0 | `fix/closure-truthful-status` | README 准确说明当前证明范围和本地依赖 | DOC-01、ACCEPT-01 部分 |
| Closure 1 | `feat/closure-role-instructions` | 三组 Agent 配置创建四类隔离 Session，内置角色指令被确定性注入且不开放 Pi Skills/ambient 发现 | INSTR-01/02/03 |
| Closure 2 | `fix/closure-merge-test-queue` | branch/tag/SHA 经同一 FIFO 合并并测试固定分支 HEAD | MERGE-01/02、TARGET-01 |
| Closure 3 | `fix/closure-test-data` | Runner 能确认实际清理，残留可靠 blocked | DATA-01/02 |
| Closure 4 | `fix/closure-live-progress` | 真实 Run 上报当前场景、总数和完成数 | ACTIVE-01 |
| Closure 5 | `feat/closure-run-history` | Main · 规划查询 Run 历史；Main · 最终汇总按本次 Bug 候选受限查询 Issue/Run | HISTORY-01 |
| Closure 6 | `feat/closure-production-acceptance` | local 验收真实经过 Pi SDK，local/live/release 分层 | PI-01、ACCEPT-01/02 |
| Closure 7 | `feat/closure-live-acceptance-release` | 使用人类提供资源完成 live 联合验收并发布 | LIVE-01/02、SECRET-01、RELEASE-01 |

阶段按顺序合入 `develop`。Closure 7 内发现产品缺陷时使用独立 `fix/*` 修复并回归，不在验收分支顺手改生产逻辑。

## 6. Closure Phase 0：真实状态与安装说明

### 目标

先停止公开文档对当前证明范围的夸大，让后续修复期间的仓库状态真实可理解。

### 修改范围

1. 更新根 `README.md`：
   - 保留“主要模块已实现”和 `v0.1.0` 已发布事实；
   - 把“34 个 AC 全量验收完成”改为“34 个 AC 本地 fixture/自动化回归通过，live 联合验收尚未完成”；
   - 明确当前 live 只覆盖有限 GitHub smoke，Provider/Pi/MCP/OSS/非生产应用联合验收未完成；
   - Docker 作为优先复现路径；
   - 本地 `npm ci` 在无预编译包时需要 `python3`、`make`、`g++`；
   - 说明 `npm run test:acceptance` 当前只代表 local，待 Phase 6 提供正式分层命令；
2. 不修改业务代码、不创建新发布 tag；
3. 检查 README 中 Phase、版本、验收、Docker Secret 和当前实际命令没有互相矛盾。

### 专项验证

- 搜索 `全量验收|34 个 AC|live|Fixture|npm ci|g\+\+`，逐条核对上下文；
- 在无 live 环境的读者视角确认不会误解成可发布证明；
- Markdown 链接和 `git diff --check` 通过。

### 退出条件

`AC-CLOSURE-DOC-01` 的状态/安装范围和 `AC-CLOSURE-ACCEPT-01` 的文案部分通过；公开文档不再把 blocked live 写成完成。

## 7. Closure Phase 1：确定性 Built-in Role Instructions

### 目标

罗网不使用 Pi Skills。保留当前显式 Prompt 的安全和确定性，把固定工作方法从 Orchestrator 长字符串中抽离为版本化 Built-in Role Instructions（内置角色指令），同时明确“三个 Agent 配置、四个隔离 Session”，消除 system/user 重复注入和跨角色 Context 过宽。

### 修改范围

1. 新建 `resources/agent-roles/` 中 Spec §3 固定的六个普通 Markdown 资源；不创建 `SKILL.md`，不采用 Pi Skill 格式；
2. 增加现有 Session owner 内的资源装载/构建边界：
   - 固定 allowlist；
   - 每个文件固定逻辑 ID 和格式版本；实际装载版本以 `逻辑 ID + 应用版本 + SHA-256` 标识；
   - 缺失/空文件失败；
   - 生产 build/Docker 必须携带资源；
   - 可输出逻辑 ID/hash 用于测试，但不记录内容或本地敏感路径；
3. `agent-session.ts` 保持 `skills=[]`、`noSkills=true`、ambient Prompt/Context/内置工具关闭；不使用 `skillsOverride`，不启用通用 `read`，不允许网站配置角色指令路径；
4. 保持且只保持 `agents.main`、`agents.runner`、`agents.reviewer` 三组配置：
   - Main Planning Session 和 Main Finalization Session 都使用同一 Main 模型/thinking 配置；
   - 两者每次分别新建 Session，不共享完整对话；
   - 不增加 planner/finalizer 模型字段、Provider 检查或配置 migration；
5. 重构 `orchestrator.ts` 的 Prompt 组装：
   - system prompt = 角色身份 + common + 当前阶段内置角色指令 + 可选初始化规则 + 输出契约；
   - user message = 当前任务 + 角色裁剪后的动态 Run 上下文；
   - 不再把同一完整指令发送两次；
6. 把 Spec §3.6 的证据优先级、独立审核、偏差、清理和反模式写入对应内置角色指令；不引入 suite/catalog/checkpoint/五状态/三轴/gate；
7. 维持并分别断言四类 Session 的 custom tool、Secret、writer、路径和 patch 权限；指令内容不能授予权限；
8. 面向用户统一显示 `Main · 规划`、`Runner`、`Reviewer`、`Main · 最终汇总`，覆盖文档、网站当前执行页、活动记录和报告；内部 `main-a`/`main-b` 可以保留，不做数据迁移；
9. 为四类 Session、初始化附加规则和同角色多 Session 增加 prompt/resource 结构断言。

### 专项验证

- 在临时 target 仓库创建恶意 `.pi/skills`、`.agents/skills`、`AGENTS.md`、Prompt/Context 文件，Session 中不存在其标记；
- 在临时 host agentDir 和用户目录创建全局 Skill/Prompt/Context，仍不进入 Session；
- 断言未调用 `skillsOverride`，没有 `SKILL.md`，没有通用 `read`，网站没有任意角色指令路径字段；
- 分别创建 Main Planning、Runner、Reviewer、Main Finalization Session，只包含对应内置角色指令，不包含其他角色专属标记；
- 断言两个 Main Session 使用同一 `agents.main` 模型/thinking 配置，但 Session ID、对话和工具集合隔离；配置 schema 仍只有 Main、Runner、Reviewer；
- 初始化静态勘察/候选综合的多个 Main Planning Session 互不共享对话；运行时侦察/候选验证的多个 Runner Session 同样隔离；
- 断言 user message 不含完整角色指令，Runner/Reviewer Context 不含历史 Issues/测试密码；
- 删除一个内置资源后，Session 创建明确失败且不回退 Pi Skills 或 ambient 资源；
- 生产 build 和 Docker 内资源存在；网站、活动和报告只出现四个统一显示名称。

### 退出条件

`AC-CLOSURE-INSTR-01`、`AC-CLOSURE-INSTR-02`、`AC-CLOSURE-INSTR-03` 通过；三组配置、四类 Session 和角色行为测试保持，未扩大任一角色权限。

## 8. Closure Phase 2：首次建分支、人工 merge 与测试进入同一 FIFO

### 目标

任何 branch/tag/SHA 只有先进入 `scenario-testing` 才能成为正式 target；人工 merge 和首次创建场景分支都不再是队列外副作用。目标仓库尚无场景分支时，同一个 `manual-merge-source + initialization=true` 请求完成首次创建并且只创建一个陌生项目初始化 Run。

### 修改范围

1. 通过新 migration 为现有测试请求队列增加 `request_kind`、`source_ref`、`prepared_merge_commit`、`resolved_target_commit`；后两个字段是请求幂等事实，不建立通用 checkpoint。复用并持久化队列已有 `initialization`，不增加第四种请求。严格实现 Spec §4.4 的旧行规则：
   - terminal 行只读保留，不重新执行；有关联 Run 时从 Run Store 回填 resolved；
   - 有 `run_id` 的 running/waiting_archive 只恢复既有 Run/归档；`waiting_archive` 缺少 `run_id` 时统一 failed，不重新排队；
   - queued/running-without-run automatic 行迁为 `automatic-head`，调度时取新 HEAD；
   - queued/running-without-run manual/api 且旧 target 为空时迁为 `manual-current-head`；
   - queued/running-without-run manual/api 且旧 target 非空时明确 failed，不把旧 target 猜成 sourceRef 或 merge 授权；
   - 旧 `target_ref` 只作历史兼容读取，新调度不使用；
2. 在 Queue/Automation owner 中实现 Spec §4 三类请求；自动请求仍只合并 queued automatic，人工请求永不合并。场景分支不存在时 automatic 不产生批次，已排队 automatic/current-head 和未标记 initialization 的 merge-source 均明确失败且无 Run；
3. 在 Repository/Queue owner 中以持久目标仓库 object store 管理确定性本地 ref `refs/luowang/merge-requests/<queue-id>`；该 ref 不进入 push refspec、不推送到目标仓库，也不作为业务分支展示；
4. 远端场景分支已存在时，调度 `manual-merge-source` 严格执行普通路径：
   - fetch 并解析 source ref；
   - 基于当时远端 `scenario-testing` HEAD 生成本地 `merge --no-ff` commit；
   - 先创建 internal ref 指向该 commit，确保 object 可达；
   - 再持久化同值的 `prepared_merge_commit`；
   - non-force push 同一 prepared commit；
   - push 成功后持久化同值的 `resolved_target_commit`；
   - 只使用 `resolved_target_commit` 创建或关联唯一 Run；
5. 远端场景分支在调度 fetch 后不存在且请求为 `manual-merge-source + initialization=true` 时，严格执行首次创建特例：
   - 解析一次 `sourceRef` 并固定 source commit；
   - 创建 internal ref 指向 source commit；
   - 持久化 `prepared_merge_commit = source commit`；
   - 以 expected-absent/compare-and-create 条件 non-force 创建远端 `scenario-testing`，不能覆盖或推进竞争创建的 ref；
   - 持久化 `resolved_target_commit = prepared_merge_commit`；
   - 只使用该 resolved 创建或关联一个 `initialization=true` Run，不另行触发初始化；
6. 恢复逻辑按 Git ref 和 SQLite 事实共同判断：
   - 只有 prepared：internal ref 必须指向同一 SHA；push 成功、拒绝、连接中断或进程退出均先 fetch，远端已包含 prepared 就补写同值 resolved；普通路径否则只 push 同一 commit，首次路径在远端仍不存在时只重试 compare-and-create 同一 commit；ref 缺失/不匹配且远端未包含时失败，不重做 merge/建分支；
   - 首次路径遇到已存在且不包含 prepared 的远端分支时才按竞争失败；若已包含 prepared，则只把 prepared 认定为已发布，不改用较新 HEAD；两种情况都不转普通 merge、不重建 commit；
   - 已有 resolved：校验它位于远端场景分支历史，忽略后来新增 HEAD，创建或关联唯一 Run；
   - internal ref 已有但 prepared 为空：视为 ref/DB 间崩溃，明确失败并清理，不猜测 prepared；
   - 已有关联 Run：不再创建第二个；
7. 已有分支路径中来源已是祖先时不生成 merge commit；internal ref 指向当时远端 HEAD，再持久化 prepared/resolved 后创建 Run；
8. 请求在 queued/running/waiting_archive 期间保留 internal ref，不受普通 workspace cleanup、fetch/prune 或 Git GC 影响；completed/failed/interrupted 后幂等清理，启动时清理无队列行的孤儿 ref；
9. 改造 `/api/repository/merge` 和网站入口为异步入队，支持 `initialization=true` 并返回 queue/request ID；首次建分支 UI 复用该入口；
10. 删除 `/api/repository/scenario-branch` 的同步 Git 写入；兼容期若保留端点，只返回迁移错误并指向 merge-source initialization 入口；
11. 普通 `/api/runs` 和网站 Run 表单移除任意 target 输入；非空旧字段明确 `400`；重测入口复用原请求说明但在调度时读取当前场景测试分支 HEAD；
12. Orchestrator 只接收调度层持久化且已证明发布到场景测试分支的 `resolved_target_commit` 和原请求 `initialization`；保留 checkout 后 SHA 一致性检查；
13. 更新 API/UI 文案，明确“已排队”而不是“已经合并/已经创建”。

### 专项验证

使用从未创建 `scenario-testing` 的临时 bare remote 和真实 Queue/Repository/Recovery 生产代码：

- 空库和 `v0.1.0` schema 都能迁移四个字段；已有 `initialization` 不丢失，migration 重复启动不重复改写；
- 分别构造 automatic/manual/api × queued/running-without-run/running-with-run/waiting_archive-with-run/waiting_archive-without-run/completed/failed/interrupted 旧行：断言 request kind、requeue/recovery/fail/只读行为与 Spec §4.4 表完全一致；`waiting_archive` 缺少 Run ID 必须 failed；
- 旧 manual/api 非空 target 不会写入 `source_ref`、不会 merge、不会创建 Run，错误提示要求通过 merge-source 重新提交；
- 分支不存在时 automatic 不产生批次，queued automatic/current-head 和 `initialization=false` 的 merge-source 均不创建分支或 Run；旧 `/api/repository/scenario-branch` 不再产生同步 Git 副作用；
- 排队 `manual-merge-source + initialization=true`，按用户指定 branch/tag/SHA 解析一次 source commit；internal ref、`prepared_merge_commit` 和 source commit 三者相等，internal ref 先于 prepared 创建；
- 首次 compare-and-create 成功后，远端 HEAD、prepared、resolved 和唯一 initialization Run target 全部相等；队列只关联一个 Run，Run 保留 `initialization=true`；
- 首次路径在 prepared 后、push 前退出：删除临时工作树/clone、重启并执行 `git gc`；远端仍无分支时只从 internal ref 发布同一 SHA；远端已包含 prepared 时只补写 resolved；
- 首次路径在 push 后、resolved 前退出：恢复同一 resolved，不重复建分支；resolved 后、Run 创建前让远端分支前进，恢复仍只创建一个以旧 resolved 为 target 的 initialization Run；
- 在首次 compare-and-create 前由竞争者创建不包含 prepared 的同名分支：请求 failed，不推进竞争 HEAD、不转普通 merge、不重建 prepared、不创建 Run；竞争者创建的分支若已包含 prepared，则按幂等发布成功补写 `resolved=prepared`，Run 仍只测试 prepared 而非竞争 HEAD；
- 场景分支建立后再排队普通 merge-source：产生 `--no-ff` merge commit，先创建 `refs/luowang/merge-requests/<queue-id>`，再写 `prepared_merge_commit`；ref、prepared 和 commit SHA 完全一致；
- 检查远端 refs，internal ref 从未被 push；普通 push 成功后 `resolved_target_commit == prepared_merge_commit`，Run target 严格等于 resolved；
- 普通路径在 prepared 持久化后、push 前退出：删除临时工作树/clone、重启并执行 `git gc`，恢复只 push 同一 SHA，不重新生成 merge；
- 两条路径在 internal ref 创建后、prepared 写入前退出：请求明确 failed、ref 被清理且不创建 Run；prepared 存在但 ref 缺失/不匹配且远端不含该 commit 时同样 failed；
- 普通路径在 push 后、resolved 前退出可从远端包含关系补写同一 resolved，不重复 merge；resolved 后、Run 前场景分支再前进仍使用旧 resolved；
- Run 关联后重启不创建第二个 Run；请求 terminal 后 internal ref 被幂等清理，重复清理安全；无队列行的孤儿 ref 在启动对账后删除；
- 来源已是祖先时不重复 merge，internal ref/prepared/resolved 指向当时 HEAD 并创建新的人工 Run；
- merge 冲突、来源不存在、prepared 后远端竞争时无 Run、无推进、工作树和 internal ref 清理；
- `/api/runs` 任意 SHA/ref 返回 `400`；普通人工和重测 target 为调度时远端场景分支 HEAD；
- 自动合批行为和 last completed target 计算不回归。

### 退出条件

`AC-CLOSURE-MERGE-01`、`AC-CLOSURE-TARGET-01`、`AC-CLOSURE-MERGE-02` 和上游 `AC-GIT-01` 通过；没有队列外人工 merge/首次建分支写入路径，push outcome 后崩溃不需要新增 checkpoint 即可确定恢复。

## 9. Closure Phase 3：真实测试数据清理确认

### 目标

生产默认路径允许 Runner 通过 UI/API 清理数据，但不信任 Runner 自述；只有 adapter 独立核验或 Reviewer 读取受控证据后确认，数据才成为已清理事实。未确认残留仍可靠 blocked。

### 修改范围

1. 扩展现有 TestDataManager，维护当前 Run 的 registered、cleanup claim、verified-cleaned 和 pending 查询；
2. 增加 Runner 的 `submit_test_data_cleanup_claim`、`list_pending_test_data` custom tools：claim 必须引用当前 Run Evidence Store 中真实存在的证据 ID，只能进入待核验状态；
3. 为删除后核验增加 Harness-side evidence capture，而不是接受 Agent 任意文本：
   - 清理 adapter 查询、受控 API 查询和与已登记 data ID 绑定的只读命令返回时，由工具 wrapper 直接捕获真实响应/输出；
   - Runner 只能选择登记 ID 和 allowlist 内查询操作/参数，不能提交 evidence 正文、状态码、退出码、摘要或 hash；
   - 禁止把 `echo`/`printf`、自由文本命令或复述结论当作清理证据；
   - 每条记录来源工具/adapter ID、Run ID、data ID、查询时间、状态码/退出码、脱敏后内容摘要和 SHA-256；沿用当前 Run 路径、大小、类型、Secret 脱敏和 allowlist；
   - Playwright MCP 直接产生的删除后截图继续作为受控图像 evidence；
4. 增加 Reviewer 的 `verify_test_data_cleanup`：只有 Reviewer 已实际读取 claim 对应 evidence 后才能确认或拒绝，不能执行目标环境命令或访问账号；
5. 更新 Runner/Reviewer 内置角色指令：
   - 创建前取得 run-id prefix；
   - 创建后立即登记；
   - 场景结束通过 UI/API 删除；
   - 触发删除后受控查询，让 Harness 捕获真实输出，或保存 Playwright MCP 直接生成的删除后截图，再引用其 evidence ID 提交 claim；
   - Reviewer 先读证据，再结构化确认或拒绝；
6. 调整 Run 收尾顺序：Runner 后 adapter 可先核验 pending，Reviewer 后做最终检查，再把未确认项作为 blocking reason 交给 Main · 最终汇总；
7. 无数据或全部 verified-cleaned → 正常；纯声明、未受控/未读取证据、Reviewer 拒绝、pending 或 adapter 失败 → blocking reason + execution/report 残留清单；
8. 不增加网站任意 cleanup command、数据库写权限或“相信 Markdown 自述”的捷径；
9. 测试账号、数据 ID、清理证据和 adapter receipt 全部脱敏。

### 专项验证

- 默认生产 manager：登记 → UI/API fixture 删除 → 受控 API/查询命令实际返回“不存在” → Harness 捕获并生成 evidence → claim → Reviewer 读取并确认 → Run 不因缺 adapter blocked；
- adapter、API、只读命令三种文本来源分别生成完整 provenance；Playwright MCP 删除后截图保持可读取；
- Agent 尝试提交自填 evidence 正文/状态码/摘要、`echo`/`printf` 输出、任意路径/URL，或 Runner 只 claim、Reviewer 未读取/拒绝 → 不能生成合格 evidence 或 verified，Run blocked；
- claim 未登记 ID、其他 Run ID、重复确认被拒绝或明确幂等；
- 受控 adapter 删除并独立查询不存在，可直接产生 verified receipt；adapter 部分失败仍 blocked；
- 多场景数据分别核验，pending 数量正确；
- 零数据 Run 不要求 adapter 或 Reviewer cleanup 工具；
- execution/review/report 有脱敏清理事实，没有密码、Cookie、Token 或原始敏感响应；
- FixtureSessionFactory 不再通过注入“总是成功 cleanup”掩盖生产默认路径。

### 退出条件

`AC-CLOSURE-DATA-01`、`AC-CLOSURE-DATA-02` 通过，既有 `AC-DATA-01` 回归仍通过。

## 10. Closure Phase 4：真实当前场景和执行进度

### 目标

控制台当前测试页展示生产 Runner 的真实进度，而不是测试注入的模拟值。

### 修改范围

1. 在现有 RunState/Gateway owner 中增加受控进度更新，不写 SQLite、不增加 run 状态文件；
2. Runner 获得 Spec §6 语义的声明、开始、完成工具；
3. 验证声明场景存在于本次计划/工作场景，拒绝未声明、重复开始/完成和越界计数；
4. 更新 `currentScenario`、`scenarioProgress`、`activities`、`updatedAt`；活动只写场景 ID/名称和通用阶段，不写工具参数、URL query、账号或 Secret；
5. 零场景显示 `0/0`，初始化侦察显示阶段活动，Agent 异常保留最后场景和明确失败；
6. Operations API 和网站继续读取同一 RunState，不建立第二套前端假状态。

### 专项验证

- 一个含两个场景的真实 Orchestrator 流：0/2 → 场景 A → 1/2 → 场景 B → 2/2；
- 每一步查询 `/api/operations/current` 和页面 DOM，值与工具调用一致；
- 未声明场景、重复 finish、completed > total 被拒绝；
- 零场景、初始化侦察、Runner 异常、completed 后页面行为正确；
- 活动和网络响应 Secret 扫描阴性；
- 删除 UI fixture 中与生产行为重复的伪进度依赖，保留纯展示测试所需固定数据。

### 退出条件

`AC-CLOSURE-ACTIVE-01` 和上游 `AC-ACTIVE-VIEW-01` 通过。

## 11. Closure Phase 5：Main 的受限历史查询

### 目标

Main · 规划能查询 SQLite/Recovery 中相关历史；Main · 最终汇总不等待尚未生成的 `confirmed_bugs`，而是在读取本次草稿和审核后，用受限只读工具查询可能相同的历史 Issue/Run，再决定 create/link。两类查询保持有限、脱敏和角色隔离。

### 修改范围

1. 扩展现有 RunStore/Recovery/Issue 查询 owner，复用已有表和 GitHub Issue 读取边界，不复制历史、不增加中间状态文件；
2. 为 Main Planning 提供 `query_run_history`：支持 recent、commit、scenario、bug/Issue 过滤，默认 20、硬上限 100；
3. 为 Main Finalization 提供独立 `query_issue_candidates({ title?, keywords?, bug_key?, limit? })`：
   - title/keywords/bug key 至少一个；实现 Spec §7 的长度、类型、NFKC/大小写/空白归一化；
   - 按 exact bug key、exact/包含 title、关键词命中数匹配，按 Spec 固定顺序排序和去重；
   - 返回固定 `ok | empty | unavailable` 结构，只包含候选 Issue、匹配原因及相关 Run 摘要；
   - 默认 20、硬上限 100；一个 Finalization Session 最多 10 次调用，同一 unavailable 查询最多重试一次，禁止重复 ok/empty 查询；
   - 只读，不能创建、修改、关闭或评论 Issue；
   - 不返回完整工件、测试账号、Secret 或未脱敏工具参数；
4. 更新 Main · 最终汇总内置角色指令和工具顺序：先读 `draft-report.md`、`review.md` 形成 Bug 候选，再调用 `query_issue_candidates`，最后在 `report.md` 决定 confirmed Bug 的 create/link；不预先注入依赖 `confirmed_bugs` 的摘要；
5. Main · 规划只有 `query_run_history`，Main · 最终汇总只有 `query_issue_candidates`；Runner、Reviewer 两者都没有；
6. Run 查询返回正常 completed、特殊 blocked、interrupted、场景 PR、归档失败摘要；Issue 候选查询返回 number/title/url/state、匹配原因/bug key 和关联 Run 的有限字段；
7. 两类查询失败都显式 unavailable，成功空结果显式 empty；第二次 unavailable 或调用预算耗尽后记录覆盖缺口并继续，不循环；不增加 Reviewer 结构化 Bug 结果或新的事实源。

### 专项验证

- 构造正常 passed、failed、多 Issue、特殊 blocked + PR、interrupted、archive failed；
- Main · 规划按场景/commit/Issue 查到正确摘要和稳定顺序；
- Main · 最终汇总在读取 draft/review 前调用候选工具被流程测试判为错误；读取后可分别按 title/keywords/bug key 查询相似 Issue 和相关 Run，最终正确选择 create 或 link；
- `query_issue_candidates` 无需预先存在 `confirmed_bugs`，不修改任何 Issue；缺少全部检索条件、错误 keywords 类型/数量/长度、控制字符和越界 limit 均被拒绝；
- 构造大小写、Unicode/空白、exact bug key、exact/包含 title、多关键词命中和相同时间数据，断言去重和稳定排序与 Spec 一致；
- `ok` 非空、`empty` 成功空、`unavailable` 依赖失败严格区分；同一 unavailable 只重试一次，ok/empty 不重复，总调用超过 10 被拒绝并形成覆盖缺口；
- 两类摘要都不含完整工件、测试账号、Secret 和未经脱敏错误；
- Main · 规划调不到 Issue 候选工具，Main · 最终汇总调不到通用 Run 历史工具，Runner/Reviewer 两者都调不到；
- Main · 规划产出的计划真实引用相关历史；Main · 最终汇总只把最终 confirmed Bugs 写入 `report.md`，不产生新中间状态文件、不回写旧 Run。

### 退出条件

`AC-CLOSURE-HISTORY-01` 和上游 `AC-HISTORY-01` 通过。

## 12. Closure Phase 6：生产路径本地验收与状态分层

### 目标

本地 acceptance 真实穿过 Pi SDK Session、Built-in Role Instructions、Pi 模型消息和 custom tool 循环；同时覆盖普通 Run、完整陌生项目初始化和确定性故障恢复，并把 local、live、release 状态彻底分开。

### 修改范围

1. 建立本地可控模型协议服务或等价 adapter，使测试不调用公网但真实经过生产 `createPiAgentSessionFactory` 和 `createAgentSession()`；
2. 为普通 Run 建立真实生产路径验收：Main Planning Session → Runner Session → Reviewer Session → Main Finalization Session；四个 Session 各自新建和 dispose，两个 Main Session 共用 `agents.main` 配置但不共享对话，通过五个 Markdown 工件交接；
3. 为陌生项目初始化建立完整真实 Pi 路径：从尚无 `scenario-testing` 的临时 bare remote 提交 `manual-merge-source + initialization=true`，先真实经过 internal ref → prepared → 首次 non-force 创建 → resolved → 唯一 initialization Run，再进入：
   - Main Planning Session：静态勘察；
   - Runner Session：运行时侦察；
   - **新的** Main Planning Session：候选综合；
   - **新的** Runner Session：候选验证；
   - Reviewer Session：独立审核；
   - Main Finalization Session：最终汇总；
4. 初始化验收必须形成三个独立用例：
   - 直接新增场景：执行完整六 Session 序列，由候选验证 Runner 真实执行后再进入 Reviewer 和 Main Finalization；
   - 需要场景 PR：只执行 Main Planning 静态勘察 → Runner 运行时侦察 → 新 Main Planning 候选综合三个 Session；策略判断需要人工审核后立即 blocked，不创建候选验证 Runner、Reviewer、Main Finalization，不等待人类；Harness 生成特殊 blocked report；special finalize 按 patch/report allowlist 选择性完成，不能原样 rename 含临时 Markdown 的 running 目录；Archiver 再创建场景 PR；
   - 最终修订未重跑：只在已经完成候选验证并进入 Reviewer/Main Finalization 的直接新增用例中验证；Main · 最终汇总修订尚未发布 patch 后，不创建新的 Runner Session，因此结果保持 blocked；
5. 记录并断言每次 Session 的唯一 ID、Agent 配置来源、内置角色指令 ID/hash、工具集合、输入工件、输出工件和 dispose；多个 Main Planning Session、多个 Runner Session 均不得共享完整对话；
6. 把确定性故障证明纳入 local：使用真实生产代码和本地 Git、HTTP、S3-compatible 服务验证首次建分支竞争、普通 merge 冲突、归档失败重试、Indexer 暂时不可用、进程重启、队列恢复，以及 internal ref + prepared/resolved 的首次创建/merge 恢复；
7. 保留 FixtureSessionFactory 用于细粒度确定性单测，但普通/初始化 Pi 路径和上述生产恢复不得以 FixtureSessionFactory 作为 AC 证据；
8. 重构 acceptance AC 映射，每个 AC 运行或引用能证明自身行为的检查，不按粗粒度 proof 批量赋值；
9. 增加 `test:acceptance:local`、`test:acceptance:live`、`test:acceptance:release`；兼容 `test:acceptance` 只能别名 local；
10. live 输入预检一次列出所有 missing 字段；blocked/failed 非零；release 只在质量、local、live 全部 passed 时为零；
11. 报告拆分 local/live/release，保存命令和证据，不保存 Secret；
12. 更新 CI 只运行 local，输出明确“CI 未执行 live”；fork PR 不接收 live Secrets；
13. 更新 README 的最终命令和状态说明。

### 专项验证

- 普通 Run 创建四个不同 Session ID，显示 Main · 规划 → Runner → Reviewer → Main · 最终汇总；两个 Main Session 使用同一 Main 模型/thinking 配置但 Prompt、工具和对话隔离；
- 普通 Run 真实经过 Pi 模型消息和 custom tool 循环，写出 `plan.md`、`execution.md`、`draft-report.md`、`review.md`、`report.md` 并 dispose 全部 Session；
- 初始化用例开始时远端没有 `scenario-testing`；断言 `manual-merge-source + initialization=true` 只发布 internal ref 固定的 prepared source commit、写入同值 resolved 并创建一个 initialization Run；不调用队列外首次建分支端点；
- 初始化直接新增场景用例真实经过六个新 Session；两个 Main Planning Session 互不共享对话，两个 Runner Session 互不共享对话，每次只获得本阶段内置角色指令和工具；
- 初始化场景 PR 用例严格只创建 Main Planning/Runner/新 Main Planning 三个 Session 并全部 dispose；策略判断后立即 blocked，断言没有候选验证 Runner、Reviewer、Main Finalization；
- 在 running workspace 先制造三个 Session 的临时 plan/execution/draft，再执行 special finalize；completed artifact list 必须严格等于 `scenario-changes.patch`、Harness 生成的 `report.md`，四个普通工件均不存在；`isSpecialScenarioReviewRun()` 按两文件契约识别，Archiver 创建场景 PR 且不把它当普通 Run；
- 初始化最终汇总修订 patch 用例没有重新 Runner 执行，因此最终仍 blocked；
- 配置和 connectivity checks 仍只有 Main、Runner、Reviewer 三组，不出现 Planner/Finalizer 字段或第四个 Provider 检查；
- 模型协议返回非法工具、漏写文件、越权工具时生产校验拒绝；
- 本地真实 Queue/Repository/Archiver/Indexer 生产代码通过首次建分支竞争、普通 merge conflict、两条路径的 internal-ref/prepared/push/resolved 各退出点、临时工作区删除与 Git GC、terminal ref 清理、归档失败重试、Indexer 故障恢复、进程重启和队列恢复；
- `test:acceptance:local` 在无外部变量环境通过且不称 release passed；
- `test:acceptance:live` 缺任一字段列出完整 missing 集合并非零；构造 live failed/blocked 时 release 非零；全部 test double 只能使 local passed；
- 每个受影响 AC 报告自己的 evidence；报告与 CI 日志中注入 canary Secret，扫描阴性。

### 退出条件

`AC-CLOSURE-PI-01`、`AC-CLOSURE-ACCEPT-01`、`AC-CLOSURE-ACCEPT-02` 和上游 `AC-GIT-01` 通过；首次建分支、merge、归档、Indexer、重启和队列恢复的确定性故障证据已在 local 完成，Phase 7 只关注真实外部联合证明。

## 13. Closure Phase 7：真实联合验收和发布

### 目标

使用项目负责人提供的独立、可信、非生产资源完成完整生产闭环；只有证据通过后发布后续版本。

### 人类输入预检

实现 Agent 在任何副作用前输出一份不含值的检查表：

```text
[ ] 测试仓库 URL 和初始 source ref 已确认
[ ] GitHub Token 四项最小权限检查通过
[ ] scenario-testing 在验收开始时不存在，可首次创建并在之后 non-force 写入/PR
[ ] 非生产 Base URL 已确认
[ ] passed 流程、两个独立 failed 条件及一个 blocked 条件已确认且可复位
[ ] 专用测试账号已配置
[ ] 测试数据删除路径和“删除后不存在”核验证据已验证
[ ] Provider API Key 和三个模型已配置
[ ] Reviewer 图像能力已确认
[ ] 私有 OSS prefix 权限已配置
[ ] 候选实例 Admin/Master Key 已配置
[ ] 外部副作用 allowlist、网络和费用已授权
[ ] 发布权限存在；SemVer 可在验收后决定
```

只显示 configured/检查结果，绝不打印值。任一必需项缺失就结束为 blocked，不创建“部分通过”的 release 结论。

### 实施与验收范围

1. 构建候选 `quality` 和 `runtime` 镜像，从独立持久卷启动一个非 root 罗网实例；
2. 通过网站/API 配置真实测试仓库、用户确认的初始 source ref、环境、Provider、Main/Runner/Reviewer 三个模型、Playwright MCP、私有 OSS 和账号；不得出现 Planner/Finalizer 独立配置或第四个模型检查；
3. 在任何 Git 写入前证明远端 `scenario-testing` 不存在，再运行其余 connectivity checks 并保存脱敏结果；若分支已存在则本次 live blocked，不能删除含人类资产的分支来继续；
4. 提交 `manual-merge-source + initialization=true`，从指定 source commit 首次创建 `scenario-testing`；验证 FIFO、internal ref 先于 prepared、`prepared == source commit`、expected-absent non-force 创建、`resolved == prepared`，并创建且只创建一个固定该 target 的陌生项目 initialization Run；不能调用队列外首次建分支接口；
5. 场景分支建立后，再使用普通 merge-source 请求把可控产品/需求变化纳入 `scenario-testing`，验证已有分支的 `merge --no-ff`、prepared/resolved 和固定 target；
6. 完成一个真实 passed UI Run：真实 Pi 创建 Main · 规划、Runner、Reviewer、Main · 最终汇总四个隔离 Session，执行 Playwright MCP 操作、截图、OSS 上传和 Reviewer 看图；创建并删除测试数据，提交清理 claim 后由 adapter 独立核验，或由 Reviewer 实际读取 Harness 直接捕获的受控查询输出/Playwright 截图并确认；写五个工件、Git 正式报告，完成 Indexer 回读和实时 0/N→N/N；
7. 使用人类预先给出的两个独立、可逆失败条件完成一个真实 failed Run，确认至少两个不同 Bugs，幂等创建/关联多个 Issues，报告及 Issues 完成后才推进；
8. 完成一个真实 blocked Run：保留已确认 Bug（如有）但不推进；阻塞来源使用可控非生产依赖，不破坏环境；
9. 验证陌生项目 initialization 的真实场景 PR 特殊路径只创建三个 Agent Session 并仅持久化 patch + Harness report；PR 合并后旧 Run 不变，当前 HEAD 人工重测创建新 Run；若首次建分支 Run 采用直接新增路径，则另行提交一个已有分支的 initialization Run 覆盖该特殊路径；
10. 验证场景/报告 allowlist、历史报告 blob SHA 不变、罗网仓库无测试资产；
11. 验证所有测试数据和 OSS 临时探测对象按策略清理；被正式 Git 报告引用的证据对象保留到项目负责人明确执行后续保留/删除决定，不得在验收收尾时误删；
12. 运行 `npm run test:acceptance:release`；它必须复用 Phase 6 的 local 确定性故障证据并执行本 Phase live 联合证明，保存分层 JSON/Markdown 结果；不在真实 GitHub/官网环境重复制造首次建分支竞争、merge 冲突、归档、Indexer、重启或队列故障；
13. 发现生产问题时停止发布，在独立 `fix/*` 修复、合入 develop、重建候选并重跑受影响 AC 和完整 release acceptance；
14. 全部通过后由项目负责人选择 `v0.1.1` 或 `v0.2.0`，更新版本/README/变更说明；
15. 发起 `develop → main` PR，合并后创建指向发布 commit 的新 tag；核对 `v0.1.0` 指向未变化；
16. 轮换/撤销临时 GitHub Token、Provider Key、OSS Key 和测试账号，或记录它们作为专用长期凭据继续保留的人工决定。

### 必须保存的非 Secret 证据

- 候选镜像 digest、发布 commit；
- 测试仓库 URL、首次写入前场景分支不存在的证明、初始 source、prepared/resolved、后续 merge/target commits；
- passed/failed/blocked Run IDs；
- 内置角色指令 IDs/hash、Main/Runner/Reviewer 三个模型 ID；
- 场景进度 API/页面截图；
- OSS object keys/稳定受保护 URL 和 Reviewer 读取事实；
- 报告 commit、场景 PR、多个 Issue URLs；
- 清理前后脱敏数据 ID/查询结果；
- Phase 6 local 的首次建分支/merge 重启恢复、归档重试、队列恢复证据引用，以及本次 live Indexer 回读结果；
- local/live/release AC 矩阵和命令退出码；
- `v0.1.0` 与新 tag 指向。

### 退出条件

- `AC-CLOSURE-LIVE-01`、`AC-CLOSURE-LIVE-02`、`AC-CLOSURE-SECRET-01`、`AC-CLOSURE-RELEASE-01` 通过；
- Spec 全部 18 个 AC 有可追溯证据，没有未运行但视为成功；
- `npm run test:acceptance:release` 为零退出，报告 `release.status=passed`；
- 人类完成 Secret 轮换/保留决定；
- 新 tag 已发布且 `v0.1.0` 未改变；
- 没有实现本变更非目标。

## 14. 验收追踪矩阵

| Spec AC | 首次闭环阶段 | 最终复验 |
|---|---:|---:|
| `AC-CLOSURE-DOC-01` | Closure 0 | Closure 6、7 |
| `AC-CLOSURE-INSTR-01` | Closure 1 | Closure 6、7 |
| `AC-CLOSURE-INSTR-02` | Closure 1 | Closure 6、7 |
| `AC-CLOSURE-INSTR-03` | Closure 1 | Closure 6、7 |
| `AC-CLOSURE-MERGE-01` | Closure 2 | Closure 6、7 |
| `AC-CLOSURE-TARGET-01` | Closure 2 | Closure 6、7 |
| `AC-CLOSURE-MERGE-02` | Closure 2 | Closure 6 |
| `AC-CLOSURE-DATA-01` | Closure 3 | Closure 6、7 |
| `AC-CLOSURE-DATA-02` | Closure 3 | Closure 6、7 |
| `AC-CLOSURE-ACTIVE-01` | Closure 4 | Closure 6、7 |
| `AC-CLOSURE-HISTORY-01` | Closure 5 | Closure 6、7 |
| `AC-CLOSURE-PI-01` | Closure 6 | Closure 7 |
| `AC-CLOSURE-ACCEPT-01` | Closure 6 | Closure 7 |
| `AC-CLOSURE-ACCEPT-02` | Closure 6 | Closure 7 |
| `AC-CLOSURE-LIVE-01` | Closure 7 | Closure 7 |
| `AC-CLOSURE-LIVE-02` | Closure 7 | Closure 7 |
| `AC-CLOSURE-SECRET-01` | Closure 7 | Closure 7 |
| `AC-CLOSURE-RELEASE-01` | Closure 7 | Closure 7 |

## 15. 停止条件

以下条件全部满足时本计划结束：

- Closure Phase 0–7 全部达到退出条件并通过 PR；
- 所有受影响的上游 AC 回归通过；
- local、live、release 证据准确分层；
- 真实外部资源、数据清理和 Secret 生命周期已经人工收口；
- 新版本已发布，旧 `v0.1.0` tag 保持不可变；
- 没有引入 ambient Skills、通用 read、任意清理命令、复杂 workflow gate、多实例或罗网自测。

若实现中发现本 Spec 与 v0.7 权威设计存在新冲突，停止当前阶段，先在本目录更新 intent/spec/plan 并由项目负责人确认；实现 Agent 不得自行改变边界后继续。
