# Cynos 默认项目文件架构约定

- 状态：MVP Baseline v0.6
- 日期：2026-08-29
- 适用范围：Cynos 系列项目，以及接入 Cynos 测试 Harness 的项目
- 当前 Harness MVP：一个罗网部署只连接一个目标仓库，并只跟踪一个场景测试分支（默认 `scenario-testing`），不支持多仓库或多租户
- 目标读者：项目负责人、需求/开发 Agent、测试 Harness、维护这些约定的人

## 1. 目的

本约定只统一项目中需要长期保存、同时供人类和 AI 使用的工程工件，不规定源码、构建产物、单元测试或部署代码应该采用什么目录结构。

核心目标是：

1. AI 能在固定位置获得项目综合理解；
2. 每个需求的意图、规格和实现计划保持稳定关联；
3. 场景化测试资产可由 AI 维护、由 Git 审核和追踪；
4. 每次测试的正式报告可长期查看；
5. 不为了“目录完整”提前创建没有真实需求的文档；
6. 避免 README、索引、手工测试套件等重复事实源。

## 2. 核心偏好和明确取舍

本约定遵循以下已经确认的偏好：

- `PROJECT.md` 放在 `docs/` 内，由项目理解流程维护，不作为普通用户直接编辑入口；
- MVP 不要求 `AGENTS.md`、文档入口 README、`architecture.md`、`conventions.md`、`testing.md` 或 `release.md`；
- 项目原本已有上述文件时不删除，但 Cynos 默认流程不创建、不依赖它们；
- 不建立需要随其他文档同步更新的目录索引；
- 不建立 `suites.yaml`，测试范围由场景自身属性和 AI 判断产生；
- 场景不按固定 domain 目录拆分，MVP 使用平铺目录；
- 不单独建立 `journeys/`；跨模块旅程也是普通场景，用标签和描述表达；
- 场景状态只有 `draft`、`approved`、`deprecated`；
- 删除场景统一通过 `deprecated` 表达，不物理删除历史文件；
- 环境、账号、Token 等不写入项目文件，由测试 Harness 网站配置并安全保存；
- 运行详细记录不提交项目 Git；Git 只保存长期测试资产和正式 Markdown 报告；
- 需求目录只属于需求/开发流程，只包含 `intent.md`、`spec.md`、`plan.md`；
- 需求 Agent 不需要知道场景测试 Agent、场景 ID、测试选择或执行机制；
- 测试 Harness 独立读取需求、diff、代码和现有场景后决定如何测试，不要求需求 Agent 编写测试提案；
- 暂不规定 `outcome.md`，等需求 Agent 的真实工作流形成后再决定；
- 不把测试 Harness 与写代码的 Agent、修复 Agent 或需求生成系统耦合。

## 3. MVP 最小目录

```text
docs/
├── PROJECT.md
├── changes/
│   └── <change-id>/
│       ├── intent.md
│       ├── spec.md
│       └── plan.md
└── scenario-testing/
    ├── scenarios/
    │   ├── <SCENARIO-ID>.md
    │   └── ...
    └── reports/
        └── <run-id>/
            ├── draft-report.md
            ├── review.md
            └── report.md
```

这是一组固定位置，不表示每个项目初始化时必须一次性创建所有文件：

- 没有需求时，可以没有 `docs/changes/` 下的实例目录；
- 没有场景资产时，由测试 Harness 首次整理；
- 没有测试运行时，可以没有 `reports/` 下的实例目录；
- 除 `docs/PROJECT.md` 外，其他目录按真实需求出现。

## 4. `docs/PROJECT.md`

### 4.1 职责

`docs/PROJECT.md` 是 AI 使用的项目综合理解，不是目录索引或面向新用户的教程。它应优先记录需要跨代码和文档综合后才能得到的内容：

- 项目解决的问题和主要用户；
- 关键业务概念；
- 主要系统边界和跨模块流程；
- 不符合常规但属于有意设计的决定及原因；
- 重要外部依赖；
- 容易被后续 Agent 误判的风险或约束；
- 尚未确认的问题。

### 4.2 所有权

- 默认由项目理解 Agent 生成和更新；
- 普通用户通过需求、规格和实际代码表达变化，不直接维护该文件；
- 文件顶部应明确标注“由 Cynos 项目理解流程维护”；
- MVP 不通过复杂 gate 阻止人工修改，所有权先作为约定；
- 测试 Harness 默认读取它，但不负责生成它。

### 4.3 不应包含

- 完整目录树；
- 从单个配置文件即可读出的值；
- 冗长 API 清单；
- 每次需求的临时细节；
- 测试运行记录；
- 密码、Token 或环境凭据。

## 5. 需求目录

目录名使用稳定的 `<change-id>`。具体编号可以来自 Issue、需求系统或 Cynos 需求 Agent，但同一需求的工件必须放在同一个目录中。

```text
docs/changes/<change-id>/
```

采用“每个需求一个目录”的纵向组织，而不是分别创建全局 `intents/`、`specs/`、`plans/`。这样 intent、spec 和实现计划之间不需要通过文件名推测关联。

### 5.1 `intent.md`

表达：

- 当前问题；
- 期望结果；
- 受影响的人和系统；
- 约束；
- 明确不做什么；
- 尚待确认的问题。

它描述“为什么做、想得到什么”，不提前承诺实现方式。

### 5.2 `spec.md`

表达已经确定的产品和设计规格：

- 行为要求；
- 交互和数据规则；
- 异常与边界行为；
- 与现有系统的集成；
- 验收条件。

验收条件建议使用稳定 ID，例如 `AC-LOGIN-01`，便于需求内部描述、实现验证和后续引用。这不要求需求 Agent 了解场景测试资产或复杂需求状态机。

### 5.3 `plan.md`

表达实际实现计划：

- 修改范围；
- 实施顺序；
- 关键风险；
- 如何证明实现完成。

本文件是需求实现计划，不是某次测试运行的 plan。

### 5.4 暂不规定的文件

MVP 不规定 `outcome.md`、`review.md`、`release.md` 等需求级工件。以后只有在需求 Agent、代码审查或发布流程出现真实需要时才增加。

## 6. 场景化测试资产

### 6.1 位置

所有长期场景平铺在：

```text
docs/scenario-testing/scenarios/
```

MVP 不使用 domain 子目录。模块、流程和重要性通过场景字段表达。

跨模块、跨系统或端到端用户旅程也是普通场景，不建立单独的 `journeys/` 概念。陌生项目初始化时产生的能力图、页面图和 API 依赖图只属于当次分析，不作为长期 catalog、suite 或 model 文件提交。

### 6.2 最小格式

```markdown
---
id: AUTH-LOGIN-001
name: 登录状态恢复
description: 验证用户登录后刷新受保护页面时仍保持登录状态
status: approved
tags:
  - core
  - module:认证
  - flow:登录
  - flow:会话恢复
---

## 目的
……

## 前置条件
……

## 步骤
……

## 期望
……

## 需要记录
……
```

固定机器字段只有：

- `id`：稳定、唯一，建议使用 ASCII；
- `name`：供人类展示和 AI 检索的短名称；
- `description`：无需读取全文即可判断相关性的简短说明；
- `status`：`draft | approved | deprecated`；
- `tags`：场景自身属性和检索线索。

字段名固定使用英文。`name`、`description`、正文和标签值使用 Harness 配置的生成语言，可以是中文或其他语言。

### 6.3 状态

- `draft`：尚未确认的场景；
- `approved`：可以进入正常测试选择；
- `deprecated`：历史场景，不再默认执行，文件保留。

不增加“期望来源”“置信度”“审核中”等状态。场景审核通过 Git PR 表达，不再复制到场景状态机中。

### 6.4 标签

标签是 AI 检索提示，不是测试套件定义。

MVP 仅约定少量特殊标签：

- `core`：高权重核心场景；
- `module:<name>`：关联模块；
- `flow:<name>`：关联业务流程；
- `external`：涉及外部服务或外部副作用。

其他标签可以根据项目自然产生，不建立集中标签注册表。

测试 Harness 的项目配置可以要求每次测试都包含某些标签，例如始终包含 `core`。除此之外，AI 结合需求、提交 diff、`name`、`description`、标签和场景全文进行选择。

### 6.5 场景修改权限

测试 Harness 为当前唯一目标仓库提供三档配置：

- `autonomous`：AI 可新增、修改、标记 deprecated，并执行；
- `add-only`：AI 可新增并执行；修改和 deprecated 需要人工确认；
- `review-all`：所有长期场景变更都需要人工确认。

不需要人工确认时，Main 仍只产生本地 patch；Runner 在当前 Run 中执行变更后的场景，Reviewer 完成审核，随后由独立归档任务直接提交到场景测试分支，不创建 PR。场景变更本身不会让当前 Run blocked，Run 仍按实际测试结果形成 `passed | failed | blocked`。

需要人工确认时，当前 Run 生成本地场景变更 patch 和覆盖缺口说明后以 `blocked` 结束，不推进，也不长时间挂起 Pi 进程。独立归档/发布任务随后创建以场景测试分支为目标的 PR，并把 PR 与来源 Run、当时的目标 commit 关联；人类合并后可以人工重测，或等待下一次产品/需求变化触发测试，旧 Run 保持 blocked。

场景 PR 本身就是这次测试资产维护的审核对象，默认不为同一件事重复创建 Issue。已经确认的产品 Bug 仍单独创建或关联 Issue；场景 PR 可以引用这些 Issue，但不能因为合并测试资产而关闭产品 Bug。运行中的测试 Agent 不直接写远程 Git。

## 7. 测试报告

每次正式测试在场景测试分支中只保存长期可读的三个 Markdown 工件：

```text
docs/scenario-testing/reports/<run-id>/
├── draft-report.md
├── review.md
└── report.md
```

- `draft-report.md`：Runner 产生的未审核报告；
- `review.md`：独立 Reviewer 的审核发现和修正意见；
- `report.md`：基于审核结果形成的最终报告。

详细执行日志、临时计划、模型会话和中间证据不进入项目 Git，由测试 Harness 本地运行目录和 Run Store 管理。

报告可以直接引用 OSS 资源地址。场景文件和报告文件不得包含环境密码、仓库 Token、模型凭据或 OSS 写入凭据。

只修改 `docs/scenario-testing/scenarios/**` 或 `docs/scenario-testing/reports/**` 的 commit 不自动触发测试，也不进入下一批测试范围，无论它来自罗网直接提交、人工修改还是场景 PR 合并。下一次产品或需求变化触发测试时使用当时最新的场景资产；需要立即验证场景变更时由用户人工重测当前版本。

## 8. Git 与数据库的职责

### 8.1 Git 是长期工件的事实源

以下内容以目标项目的场景测试分支 Git 内容为准：

- `docs/PROJECT.md`；
- `docs/changes/**`；
- `docs/scenario-testing/scenarios/**`；
- `docs/scenario-testing/reports/**`。

Git 提供版本关联、人工审核和历史追踪。罗网 MVP 不跟踪其他开发分支的测试状态；其他 branch/tag/SHA 只有先合并到场景测试分支，才进入正式测试流程。

### 8.2 数据库是网站读模型、缓存和备份

测试 Harness 定期同步仓库，将测试场景和 Markdown 报告的路径、内容及对应提交缓存到本地数据库。网站默认读取数据库，而不是每次页面请求都直接扫描 Git。

原因：

- 查询和筛选更简单；
- 网站查询和筛选不依赖每次临时 Git 扫描；
- 可以与详细 Run 记录一起查询；
- Git 暂时不可达时仍可展示最近缓存；
- 数据库缓存可以从 Git 重建，不取代 Git 的所有权。

网站应展示当前目标仓库最近同步的 commit 和时间，避免把陈旧缓存误认为最新状态。

### 8.3 数据库独有内容

以下内容只以 Harness 数据库为准：

- Harness 配置；
- 加密 Secrets；
- 当前目标仓库配置和访问 Token；
- 登录临时 Token；
- 详细测试运行记录；
- 同步和归档任务状态。

## 9. 环境与 Secrets

环境信息不属于项目默认文件架构。MVP 的每个罗网部署只连接一个目标仓库，并由网站为该仓库配置一个测试环境：

- 环境说明；
- 服务地址；
- 外部数据库；
- 测试账号；
- 密码、Token 和 API Key。

Secrets 进入统一 Secret Store。测试 Agent 不直接读数据库，而是通过 Harness 提供的统一请求函数获得当前任务允许使用的环境信息。以后增加 SecretRef、字段掩码或专用工具时，不改变上层调用边界。

## 10. 明确不做

MVP 不包含：

- 为目录完整而创建的 README 或索引；
- 手工维护的 full/core/regression 套件文件；
- 复杂场景状态机；
- domain 和 journey 两套场景目录；
- 项目内环境密钥文件；
- 测试过程的 Git 全量归档；
- 需求 `outcome.md`；
- 源码目录标准化；
- 测试 Harness 对开发 Agent 或修复 Agent 的调度。

## 11. 参考资料和吸收的设计

以下资料对本约定有直接参考价值：

1. Anthropic AI-Native SDLC Playbook：`intent.md → spec.md → plan.md` 的版本化工件链；
2. opc-aicom `scenario-testing/`：长期场景唯一事实源、标签派生、候选场景、选择理由、独立审核；同时也证明复杂 gate、审批 hash 和重复 run 状态不适合本 MVP；
3. [Cucumber Markdown with Gherkin](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md)：Markdown 中承载可读场景和标签；
4. [Gauge](https://docs.gauge.org/overview)：Markdown specification、标签检索和场景级执行；
5. [Kiwi TCMS](https://kiwitcms.readthedocs.io/en/latest/guide/testcase.html)：Case 与 Run 分离、场景确认后进入正式执行；本约定只吸收概念，不引入其管理流程。

## 12. 后续可能演进但不预设

只有出现真实需求时才考虑：

- 新的需求级工件；
- 场景目录分片；
- 标签词表；
- 多环境；
- 报告格式迁移；
- Git 之外的正式资产源；
- 更严格的文件所有权或 CODEOWNERS。
