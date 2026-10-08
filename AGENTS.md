# AGENTS.md

## 工作入口

- 开始任何实质性修改前，先阅读 `docs/cynos-default-project-layout.md`。
- 理解项目时读取 `docs/PROJECT.md`（存在时）；处理需求时读取对应的 `docs/changes/<change-id>/intent.md`、`spec.md` 和 `plan.md`（存在时）。
- 已发布 MVP 基线工件位于 `docs/changes/luowang-harness-mvp/`。
- 当前角色交接与收尾调整位于 `docs/changes/luowang-single-handoff/`：取消 Runner 草稿，最终 Main 只读计划/审核；最终 Main 后由 Harness 清理，收尾失败不改测试结论。涉及这些主题时，以该目录 Spec 覆盖下述旧基线，不做旧草稿格式兼容。
- v0.7 Production Closure 的规则位于 `docs/changes/luowang-v07-production-closure/`，用于 Built-in Role Instructions（内置角色指令）、固定分支请求、数据清理、实时进度、历史 Run 和真实联合验收；罗网不使用 Pi Skills，并保持 Main/Runner/Reviewer 三组 Agent 配置、正常 Run 四个隔离 Session。处理这些主题时先读该目录，冲突处以其 Spec 为准。
- 技术栈、产品边界和验收要求以对应需求 `spec.md` 为准，不在本文件重复维护。

- `docs/changes/luowang-code-understanding/` 对应已发布 v0.6.0 的内置代码深读方法；`docs/changes/luowang-multi-project/` 对应已发布 v0.6.1 的同一操作者多项目管理。实现这些主题时读取对应 intent/spec/plan；新增内置方法仍沿用受控角色资源加载，不开启 Pi Skill 自动发现。三个外部目标已完成交替真实 Run 和故障隔离，历史持久测试实例副本已完成迁移与回退演练；发布及最终验收证据以该目录 Plan 为准。

- 语义判断与客观事实的最新规则以 `docs/changes/luowang-model-semantic-decisions/spec.md` 为准：Main 显式声明浏览器执行需要，不用正则判断计划含义；安全和格式校验保留。
- MCP启动、工件可重写和审核证据读取的最新规则以 `docs/changes/luowang-retest-followup/spec.md` 为准：Reviewer可受控读取本Run的浏览器快照/日志，不开放任意文本；工具路由错误不冒充证据损坏，真实读取或完整性失败仍阻塞。
- 截图采集与取证状态的最新规则以 `docs/changes/luowang-screenshot-capture-integrity/spec.md` 为准：禁止为截图清空/覆盖表单或隐去待验证内容；合成测试截图按新计划改为警告和检测标签，文字保护复用 run-evidence-followup。报告保持自动归档、人工事后审核，不新增发布门禁；具体实现进度见新目录 plan.md，不把需求写成已完成事实。

## 仓库与分支

- 执行服务器、应用启动和 Compose 的规则位于 `docs/changes/luowang-execution-server-redesign/`。执行链与本机工程验证已接入，各服务器使用自己的 Docker；真实远程和模型联合验收进度以 Plan 为准，不把保存服务器资源当作已经验证远程运行。
- AI 启动配置、文件/脚本初始化和项目设置调整位于 `docs/changes/luowang-ai-test-environment/`。生成/更新只由用户点击并手动保存；正常分析只提醒。实现范围与本机、真实模型和远程验证分别见该目录 Spec/Plan，不增加数据库同步平台或另一条 Run 执行链。

- 项目并行开发位于 `docs/changes/luowang-project-concurrency/`：跨项目有界并行、同项目串行，准备阶段计入容量；实现与验收进度见 Plan，发布前不视为已上线。其 Spec 覆盖旧多项目全局单槽约束。

- v0.6.0 代码深读的实现与验收遵循 `docs/changes/luowang-code-understanding/`。它扩展 Main 的内置角色资源、固定版本读取回执与计划引用；不启用 Pi Skills，不新增角色 Session。当前多项目开发以 `docs/changes/luowang-multi-project/` 的 Spec 覆盖单仓库基线，不能将合成测试视为真实联合验收。

- 正式仓库是公开的 `cynos-ai/luowang`；许可证为 GNU Affero General Public License v3.0（`AGPL-3.0`）。它允许商业使用，但分发衍生作品或通过网络提供修改版时必须按 AGPL 提供对应源码。
- `main` 只保存正式发布历史；`develop` 是日常开发集成分支。两者都禁止直接提交和 force-push，通过 Pull Request 合并。
- 功能从最新 `develop` 创建 `feat/<short-kebab-name>`，完成后向 `develop` 提交 PR。
- 普通缺陷从最新 `develop` 创建 `fix/<short-kebab-name>`，完成后向 `develop` 提交 PR；正式版本紧急缺陷从 `main` 创建同样的 `fix/*`，合入 `main` 后必须同步到 `develop`。
- 不预设 `release/*`、`hotfix/*` 等额外分支。独立文档、CI 或依赖维护确有需要时可使用 `chore/*`。
- 发布通过 `develop → main` PR 完成，并在 `main` 使用 SemVer tag。项目负责人决定版本并逐次明确授权发布；授权后 AI 可以在验收满足对应 Spec、PR 检查通过且核对目标提交后协助合并发布 PR、创建**新的**指定 tag 和发布 GitHub Release，并执行发布后核验。不得无授权发布、覆盖/移动历史 tag，或把发布前验收冒充发布后核验。仓库级“合并后自动删除 head 分支”保持关闭，避免发布 PR 删除长期 `develop`；合并者只手工删除 `feat/*`、`fix/*`、`chore/*`。
- `scenario-testing` 只存在于罗网所管理的外部目标仓库中，用于保存该目标项目的测试事实；它不是 `cynos-ai/luowang` 的开发或发布分支。MVP 验收使用独立样例仓库和独立非生产样例应用。

## 本计划固定测试目标

- `docs/changes/luowang-harness-mvp/plan.md` 的全部阶段统一使用外部 GitHub 仓库 [`cynos-ai/cynos-website`](https://github.com/cynos-ai/cynos-website) 作为 Cynos 官网非生产测试项目；除非用户明确更换目标，不新建或切换其他测试项目，也不把 `cynos-ai/luowang` 当作被测产品。
- 用户已于 2026-09-29 明确授权将 v0.7.0 发布验收固定目标更换为独立公开仓库 [`cynos-ai/luowang-v070-release-fixture`](https://github.com/cynos-ai/luowang-v070-release-fixture)。该仓库的 `main` 固定在 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`，开始本轮 live 验收前不存在 `scenario-testing`；该分支必须由同一个持久候选实例首次创建。原 [`cynos-ai/luowang-closure7-fixture`](https://github.com/cynos-ai/luowang-closure7-fixture) 已产生历史分支、报告和 PR，只能作为历史验收事实读取，不得删除资产或冒充本轮首次创建。
- 目标仓库默认使用 `scenario-testing` 保存长期场景和正式报告；LuoWang 自身的代码仍按本仓库的 `develop`、`feat/*` 和 PR 规则开发。每个 Run 必须固定并记录不可变的 `target_commit`，不能把移动中的分支 HEAD 当作测试事实。
- 官网测试只使用非生产环境、合成数据和通过 Harness Secret Store 提供的预置测试账号；允许覆盖登录/注册等官网功能，但禁止触碰生产数据、把测试账号密码写入文档/日志/报告，且临时数据必须按 Run 标记并清理。
- 本计划当前模型约定为：Main/Runner 使用文本模型 `deepseek-v4-flash`；Reviewer 使用视觉模型 `deepseek-v4-flash-vision-exp`。模型 API Key、GitHub Token、OSS 凭据和测试账号信息只进入受控 Secret Store，不写入本文件或 Git。
- 当前 LuoWang 工程基线已实现 Phase 0–8；Phase 8 运维控制台通过普通 HTTP 轮询展示 Git、场景、Run、当前执行、归档、队列和依赖健康事实，并在外部依赖不可用时保留并标记陈旧缓存。
- 浏览器与构建环境由 `Dockerfile` 的 `quality`/`runtime` targets 固定：Node 基础镜像使用 digest，npm 与 Playwright 浏览器下载使用可覆盖的镜像源，CI 的全部质量检查在 `quality` 容器内运行；不要恢复为依赖 GitHub runner 宿主机预装 Chromium 的做法。

## 固定安全边界

- 空数据库的管理员密码只从 `LUOWANG_ADMIN_PASSWORD` 初始化；不提供匿名设密或默认密码，已有哈希不被环境变量覆盖。
- Main 的场景 patch 只能修改 `docs/scenario-testing/scenarios/**`，必须拒绝产品/需求/历史报告变更、越界 rename、symlink、submodule、二进制和无效场景。
- Archiver 只原样发布已验证场景 patch，并只为当前 Run 新增 `docs/scenario-testing/reports/<current-run-id>/**`；不得改写其他历史报告。

## 文档归档规则

```text
docs/
├── PROJECT.md
├── changes/<change-id>/
│   ├── intent.md
│   ├── spec.md
│   └── plan.md
└── scenario-testing/
    ├── scenarios/
    └── reports/<run-id>/
```

- 同一需求的 `intent.md`、`spec.md`、`plan.md` 必须放在同一个稳定的 `<change-id>` 目录。
- `intent.md` 只说明问题、期望结果、影响、约束、非目标和待确认问题，不承诺实现方式。
- `spec.md` 记录已确定的行为、设计规则、边界和验收条件。
- `plan.md` 只在 intent/spec 足够稳定后编写，记录实施阶段、修改范围、风险和完成证明。
- 不为目录完整而创建空文件、README、索引、suite、catalog 或其他未被真实流程需要的工件。
- 场景、报告和 Secret 的位置及所有权遵循 `docs/cynos-default-project-layout.md`，不得另建重复事实源。

## 行为底线

- 先理解再修改：优先检查已有文档、代码、测试和调用关系，不猜测可从仓库确认的事实。
- 做最小完整变更：只处理当前目标，不顺手重构、升级依赖或预设未来抽象。
- 延续已有职责边界：新增实现前先搜索现有 owner、工具和模式。
- 保持安全边界：不得提交密码、Token、密钥、生产数据或可取回的 Secret。
- 验证后结束：运行与风险匹配的最小充分检查，明确报告已通过、未运行、失败或受阻的项目。
- 重要且难以回退的产品、架构、安全或数据决策，一次向项目负责人确认一个问题，并给出推荐默认值。

## 前端组件与交互

- 页面优先使用 `src/web/components/` 提供的罗网 UI 组件，并从 `src/web/components/ui.ts` 的稳定入口复用；新增通用交互前先检查现有 `Button`、`Message`、`Dialog`、`Prompt`、`Field`、`SelectBox`、`ComboBox`、`NumberInput`、`StatusLabel`、`DataTable` 和 `PageHeading`。
- 页面只表达组件语义和业务状态，不复制组件的颜色、边框、阴影、层级或动效。视觉变量集中维护在 `tokens.css`，组件外观集中维护在 `components.css` 或对应共享样式中，以便统一调整罗网风格或切换主题。
- 不新增浏览器原生 `confirm`、`prompt`、`alert` 或原生 `select`。危险、不可恢复或会中断工作的操作使用罗网站内确认组件；选择控件使用 `SelectBox` 或 `ComboBox`。缺少通用能力时先补最小共享组件，再由页面使用。
- 所有改变系统状态的操作都必须在完成后通过全局 Message 明确反馈成功或失败；只读导航、筛选、展开收起和自动轮询不产生冗余提示。错误详情可以同时保留在相关内容区域。
- 共享组件必须保留语义化 HTML、键盘操作、焦点管理和辅助技术可读状态；不得为了视觉统一降低可访问性。
