# AGENTS.md

## 工作入口

- 开始任何实质性修改前，先阅读 `docs/cynos-default-project-layout.md`。
- 理解项目时读取 `docs/PROJECT.md`（存在时）；处理需求时读取对应的 `docs/changes/<change-id>/intent.md`、`spec.md` 和 `plan.md`（存在时）。
- 罗网 MVP 的当前需求工件位于 `docs/changes/luowang-harness-mvp/`。
- 技术栈、产品边界和验收要求以需求 `spec.md` 为准，不在本文件重复维护。

## 仓库与分支

- 正式仓库是公开的 `cynos-ai/luowang`；许可证为 GNU Affero General Public License v3.0（`AGPL-3.0`）。它允许商业使用，但分发衍生作品或通过网络提供修改版时必须按 AGPL 提供对应源码。
- `main` 只保存正式发布历史；`develop` 是日常开发集成分支。两者都禁止直接提交和 force-push，通过 Pull Request 合并。
- 功能从最新 `develop` 创建 `feat/<short-kebab-name>`，完成后向 `develop` 提交 PR。
- 普通缺陷从最新 `develop` 创建 `fix/<short-kebab-name>`，完成后向 `develop` 提交 PR；正式版本紧急缺陷从 `main` 创建同样的 `fix/*`，合入 `main` 后必须同步到 `develop`。
- 不预设 `release/*`、`hotfix/*` 等额外分支。独立文档、CI 或依赖维护确有需要时可使用 `chore/*`。
- 发布通过 `develop → main` PR 完成，并在 `main` 使用 SemVer tag。仓库级“合并后自动删除 head 分支”保持关闭，避免发布 PR 删除长期 `develop`；合并者只手工删除 `feat/*`、`fix/*`、`chore/*`。
- `scenario-testing` 只存在于罗网所管理的外部目标仓库中，用于保存该目标项目的测试事实；它不是 `cynos-ai/luowang` 的开发或发布分支。MVP 验收使用独立样例仓库和独立非生产样例应用。

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
