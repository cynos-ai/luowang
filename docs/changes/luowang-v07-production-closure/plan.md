# 罗网 v0.7 生产闭环补齐实施计划

- 状态：Implementation Plan v0.1
- 关联 Intent：[intent.md](./intent.md)
- 关联 Spec：[spec.md](./spec.md)
- 上游计划：[罗网 Harness MVP Plan](../luowang-harness-mvp/plan.md)
- 实施方式：Closure Phase 0–7 顺序执行；每阶段独立分支、PR、验证、退出条件和 AC 证据

## 1. 计划目标

本计划在现有 `v0.1.0` 代码上补齐 v0.7 的生产闭环，不重新执行旧 Phase 0–9，也不以重写代替增量修复。

完成后必须同时证明：

1. 角色方法被确定性、按角色、安全地加载；
2. 所有正式 target 都来自固定场景测试分支；
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
| 测试仓库 | 默认 `https://github.com/cynos-ai/cynos-website`，或明确替换 URL | 可信、不是罗网仓库、允许 `scenario-testing` 测试写入 | Phase 7 blocked |
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
| Closure 1 | `feat/closure-role-skills` | 版本化 Role Skills 被按 Session 确定性注入且不开放 ambient 发现 | INSTR-01/02/03 |
| Closure 2 | `fix/closure-merge-test-queue` | branch/tag/SHA 经同一 FIFO 合并并测试固定分支 HEAD | MERGE-01/02、TARGET-01 |
| Closure 3 | `fix/closure-test-data` | Runner 能确认实际清理，残留可靠 blocked | DATA-01/02 |
| Closure 4 | `fix/closure-live-progress` | 真实 Run 上报当前场景、总数和完成数 | ACTIVE-01 |
| Closure 5 | `feat/closure-run-history` | Main 可查询相关 SQLite/Recovery 历史摘要 | HISTORY-01 |
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

## 7. Closure Phase 1：确定性内置 Role Skills

### 目标

保留当前显式 Prompt 的安全和确定性，把工作方法从 Orchestrator 长字符串中抽离为版本化 Role Skills，并消除 system/user 重复注入和跨角色 Context 过宽。

### 修改范围

1. 新建 `resources/agent-roles/` 中 Spec §3 固定的六个 Markdown 资源；
2. 增加现有 Session owner 内的资源装载/构建边界：
   - 固定 allowlist；
   - 每个文件固定逻辑 ID 和格式版本；实际装载版本以 `逻辑 ID + 应用版本 + SHA-256` 标识；
   - 缺失/空文件失败；
   - 生产 build/Docker 必须携带资源；
   - 可输出逻辑 ID/hash 用于测试，但不记录内容或本地敏感路径；
3. `agent-session.ts` 继续关闭 ambient Skill/Prompt/Context/内置工具；不启用通用 `read`；
4. 重构 `orchestrator.ts` 的 prompt 组装：
   - system prompt = common + 唯一角色 + 可选初始化 + 输出契约；
   - user message = 角色裁剪后的 Run 上下文和本次任务；
   - 不再把同一字符串传两次；
5. 把 opc-aicom 可吸收原则压缩进对应 Role Skill，不复制 suite/catalog/checkpoint/五状态/三轴/gate；
6. 维持全部 custom tool allowlist 和 writer 权限；
7. 为每个 Session 和初始化变体增加 prompt/resource 快照或结构断言。

### 专项验证

- 在临时 target 仓库创建恶意 `.pi/skills`、`.agents/skills`、`AGENTS.md`，system prompt 中不存在其标记；
- 在临时 host agentDir 创建全局 Skill，仍不进入 Session；
- 分别创建 Main A、Runner、Reviewer、Main B，断言只包含自己的 Role Skill，不包含其他角色专属标记；
- 断言 user message 不含完整 Role Skill，Runner/Reviewer Context 不含历史 Issues/测试密码；
- 删除一个内置资源后，Session 创建明确失败且不回退；
- 断言工具名集合与修改前一致；
- 生产 build 和 Docker 内资源存在。

### 退出条件

`AC-CLOSURE-INSTR-01`、`AC-CLOSURE-INSTR-02`、`AC-CLOSURE-INSTR-03` 通过；角色行为测试保持，未扩大任一角色权限。

## 8. Closure Phase 2：人工 merge 与测试进入同一 FIFO

### 目标

任何 branch/tag/SHA 只有先进入 `scenario-testing` 才能成为正式 target；人工 merge 不再是队列外副作用。

### 修改范围

1. 通过新 migration 为现有测试请求队列增加 request kind 和可选 `source_ref`，保持旧行可读取；
2. 在 Queue/Automation owner 中实现 Spec §4 三类请求；自动请求仍只合并 queued automatic，人工请求永不合并；
3. 调度 `manual-merge-source` 时依次执行 fetch、ancestor check、`merge --no-ff`、non-force push、固定返回 HEAD、启动 Run；
4. 改造 `/api/repository/merge` 和网站合并入口为异步入队，返回 queue/request ID；
5. 普通 `/api/runs` 和网站 Run 表单移除任意 target 输入；非空旧字段明确 `400`；
6. 重测入口复用原请求说明但在调度时读取当前场景测试分支 HEAD；
7. Orchestrator 只接收调度层已经证明属于场景测试分支的固定 SHA；保留 checkout 后 SHA 一致性检查；
8. 增加 merge 后进程退出恢复、来源已包含、冲突、push 竞争和重复请求测试；
9. 更新 API/UI 文案，明确“已排队”而不是“已经合并”。

### 专项验证

使用临时 bare remote：

- 排队两个普通人工请求和一个 merge-source，按 FIFO 执行且不丢失；
- merge-source 产生 `--no-ff` merge commit、non-force push，Run target 等于远端新 HEAD；
- 来源已是祖先时不重复 merge，但创建新的人工 Run；
- merge 冲突、来源不存在、远端竞争时无 Run、无推进、工作树清理；
- merge 成功后模拟重启，恢复不重复 merge并最终创建一个 Run；
- `/api/runs` 任意 SHA/ref 返回 `400`；
- 普通人工和重测 target 为调度时远端场景分支 HEAD；
- 自动合批行为和 last completed target 计算不回归。

### 退出条件

`AC-CLOSURE-MERGE-01`、`AC-CLOSURE-TARGET-01`、`AC-CLOSURE-MERGE-02` 通过；没有队列外人工 merge 写入路径。

## 9. Closure Phase 3：真实测试数据清理确认

### 目标

生产默认路径允许 Runner 通过 UI/API 清理数据，但不信任 Runner 自述；只有 adapter 独立核验或 Reviewer 读取受控证据后确认，数据才成为已清理事实。未确认残留仍可靠 blocked。

### 修改范围

1. 扩展现有 TestDataManager，维护当前 Run 的 registered、cleanup claim、verified-cleaned 和 pending 查询；
2. 增加 Runner 的 `submit_test_data_cleanup_claim`、`list_pending_test_data` custom tools：claim 必须引用当前 Run Evidence Store 中真实存在的证据 ID，只能进入待核验状态；
3. 为脱敏删除后 API 查询结果增加受控文本 evidence 保存/读取；沿用当前 Run 路径、大小、类型和 Secret 校验；
4. 增加 Reviewer 的 `verify_test_data_cleanup`：只有 Reviewer 已实际读取 claim 对应 evidence 后才能确认或拒绝，不能执行目标环境命令或访问账号；
5. 更新 Runner/Reviewer Role Skills：
   - 创建前取得 run-id prefix；
   - 创建后立即登记；
   - 场景结束通过 UI/API 删除；
   - 保存“删除后不存在”的脱敏截图/查询证据并提交 claim；
   - Reviewer 先读证据，再结构化确认或拒绝；
6. 调整 Run 收尾顺序：Runner 后 adapter 可先核验 pending，Reviewer 后做最终检查，再把未确认项作为 blocking reason 交给 Main B；
7. 无数据或全部 verified-cleaned → 正常；纯声明、未受控/未读取证据、Reviewer 拒绝、pending 或 adapter 失败 → blocking reason + execution/report 残留清单；
8. 不增加网站任意 cleanup command、数据库写权限或“相信 Markdown 自述”的捷径；
9. 测试账号、数据 ID、清理证据和 adapter receipt 全部脱敏。

### 专项验证

- 默认生产 manager：登记 → UI/API fixture 删除 → 保存删除后证据 → claim → Reviewer 读取并确认 → Run 不因缺 adapter blocked；
- Runner 只 claim、不提供证据、引用任意路径/URL、Reviewer 未读取证据或拒绝 → 不能 verified，Run blocked；
- claim 未登记 ID、其他 Run ID、重复确认被拒绝或明确幂等；
- 受控 adapter 删除并独立查询不存在，可直接产生 verified receipt；adapter 部分失败仍 blocked；
- 多场景数据分别核验，pending 数量正确；
- 零数据 Run 不要求 adapter或 Reviewer cleanup 工具；
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

## 11. Closure Phase 5：Main 相关历史 Run

### 目标

Main 能使用 SQLite/Recovery 中未写入正式 Git 报告的历史事实，同时保持查询有限、脱敏和角色隔离。

### 修改范围

1. 扩展 RunStore/Recovery owner，提供 Spec §7 的摘要查询；复用已有表，不复制历史；
2. 支持 recent、commit、scenario、bug/Issue 过滤和 20/100 限制；
3. 增加 Main 专用 `query_run_history` custom tool；Main A 可查询，Main B 只查询本次 bug 相关摘要；
4. Runner、Reviewer 工具集中不存在该工具；
5. 返回正常 completed、特殊 blocked、interrupted、场景 PR、归档失败和多个 Issue 摘要；
6. 查询失败显式 unavailable，成功空结果显式 empty；
7. 更新 Main Role Skills，要求按相关性查询，不把全部历史塞进 prompt。

### 专项验证

- 构造正常 passed、failed、多 Issue、特殊 blocked + PR、interrupted、archive failed；
- Main 按场景/commit/Issue 查到正确摘要和稳定顺序；
- limit 边界、无结果和数据库失败区分；
- 摘要不含完整工件、测试账号、Secret 和未经脱敏错误；
- Runner/Reviewer 调不到历史工具；
- Main 计划真实引用相关历史，不回写旧 Run。

### 退出条件

`AC-CLOSURE-HISTORY-01` 和上游 `AC-HISTORY-01` 通过。

## 12. Closure Phase 6：生产路径本地验收与状态分层

### 目标

本地 acceptance 真实穿过 Pi SDK Session/Role Skill/custom tools，同时把 local、live 和 release 状态彻底分开。

### 修改范围

1. 建立本地可控模型协议服务或等价 adapter，使测试不调用公网但真实经过生产 `createPiAgentSessionFactory` 和 `createAgentSession()`；
2. 至少完成 Main A → Runner → Reviewer → Main B 的真实 Pi 消息/工具循环、五文件和 dispose；不能注入 FixtureSessionFactory 作为该 AC 证据；
3. 保留 FixtureSessionFactory 用于细粒度确定性单测，但验收报告准确标记层级；
4. 重构 acceptance AC 映射，每个 AC 运行或引用能证明自身行为的检查，不按七个粗 proof 批量赋值；
5. 增加 `test:acceptance:local`、`test:acceptance:live`、`test:acceptance:release`；兼容 `test:acceptance` 只能别名 local；
6. live 输入预检一次列出所有 missing 字段；blocked/failed 非零；release 只在质量、local、live 全部 passed 时为零；
7. 报告拆分 local/live/release，保存命令和证据，不保存 Secret；
8. 更新 CI 只运行 local，输出明确“CI 未执行 live”；fork PR 不接收 live Secrets；
9. 更新 README 的最终命令和状态说明。

### 专项验证

- 生产 Session factory 的四个角色确实创建/销毁，工具调用和 Role Skill 标记可审计；
- 模型协议返回非法工具、漏写文件、越权工具时生产校验拒绝；
- `test:acceptance:local` 在无外部变量环境通过且不称 release passed；
- `test:acceptance:live` 缺任一字段列出完整 missing 集合并非零；
- 构造 live failed/blocked，release 非零；全部 test double 只能使 local passed；
- 每个受影响 AC 报告自己的 evidence；
- 报告与 CI 日志中注入 canary Secret，扫描阴性。

### 退出条件

`AC-CLOSURE-PI-01`、`AC-CLOSURE-ACCEPT-01`、`AC-CLOSURE-ACCEPT-02` 通过；Phase 7 可以只关注真实外部系统，而不回头补验收基础设施。

## 13. Closure Phase 7：真实联合验收和发布

### 目标

使用项目负责人提供的独立、可信、非生产资源完成完整生产闭环；只有证据通过后发布后续版本。

### 人类输入预检

实现 Agent 在任何副作用前输出一份不含值的检查表：

```text
[ ] 测试仓库 URL 已确认
[ ] GitHub Token 四项最小权限检查通过
[ ] scenario-testing 可 non-force 写入/PR
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
2. 通过网站/API 配置真实测试仓库、环境、Provider、三个模型、Playwright MCP、私有 OSS 和账号；
3. 运行所有 connectivity checks，保存脱敏结果；
4. 使用 merge-source 请求把可控产品/需求变化纳入 `scenario-testing`，验证 FIFO 和固定新 HEAD；
5. 完成一个真实 passed UI Run：真实 Pi 四 Session、Playwright MCP 操作、截图、OSS 上传、Reviewer 看图、数据创建/删除/mark cleaned、五文件、Git 三报告、Indexer 回读和实时 0/N→N/N；
6. 使用人类预先给出的两个独立、可逆失败条件完成一个真实 failed Run，确认至少两个不同 Bugs，幂等创建/关联多个 Issues，报告及 Issues 完成后才推进；
7. 完成一个真实 blocked Run：保留已确认 Bug（如有）但不推进；阻塞来源使用可控非生产依赖，不破坏环境；
8. 验证场景 PR、PR 合并后旧 Run 不变、当前 HEAD 人工重测；
9. 验证 merge 冲突、归档失败重试、Indexer 暂时不可用恢复、进程重启 interrupted 和队列恢复；
10. 验证场景/报告 allowlist、历史报告 blob SHA 不变、罗网仓库无测试资产；
11. 验证所有测试数据和 OSS 临时探测对象按策略清理；被正式 Git 报告引用的证据对象保留到项目负责人明确执行后续保留/删除决定，不得在验收收尾时误删；
12. 运行 `npm run test:acceptance:release`，保存 JSON/Markdown 证据；
13. 发现生产问题时停止发布，在独立 `fix/*` 修复、合入 develop、重建候选并重跑受影响 AC 和完整 release acceptance；
14. 全部通过后由项目负责人选择 `v0.1.1` 或 `v0.2.0`，更新版本/README/变更说明；
15. 发起 `develop → main` PR，合并后创建指向发布 commit 的新 tag；核对 `v0.1.0` 指向未变化；
16. 轮换/撤销临时 GitHub Token、Provider Key、OSS Key 和测试账号，或记录它们作为专用长期凭据继续保留的人工决定。

### 必须保存的非 Secret 证据

- 候选镜像 digest、发布 commit；
- 测试仓库 URL、场景分支、source/merge/target commits；
- passed/failed/blocked Run IDs；
- Role Skill IDs/hash、三个模型 ID；
- 场景进度 API/页面截图；
- OSS object keys/稳定受保护 URL 和 Reviewer 读取事实；
- 报告 commit、场景 PR、多个 Issue URLs；
- 清理前后脱敏数据 ID/查询结果；
- 重启、归档重试和 Indexer 回读结果；
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
| `AC-CLOSURE-MERGE-02` | Closure 2 | Closure 6、7 |
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
