# 罗网配置操作优化 Spec

## 1. GitHub 综合检查

- GitHub 配置区只有一个“保存并测试 GitHub”主动作；保存成功后一次执行仓库读取、场景分支写入前提、Pull Request 和 Issue 四项内部检查。
- 页面以一个 GitHub 综合结果块展示总体状态，并列出四项子结果、消息、耗时和时间；不再为每项显示独立按钮。
- 检查不得创建 PR、Issue 或远端测试分支。
- 仓库读取结果必须验证目标仓库。
- 场景分支写入前提必须验证 repository `push` 权限，并明确罗网实际发布仍使用 non-force/CAS 安全写入。
- 对 classic PAT，当 GitHub `X-OAuth-Scopes` 明确包含私有仓库 `repo` 或公开仓库 `public_repo` 时，可结合仓库权限和功能开关将 PR/Issue 写入能力判为通过。
- GitHub 没有提供可验证写 scope 时保持 `unknown`，并说明是“无法无副作用确认”，不能伪装为通过。

## 2. 自动测试

- 新配置默认 `triggerOnCommit=false`、Cron 为空，因此默认不自动创建测试 Run。
- 新提交检查间隔在页面以分钟输入，持久化仍使用兼容字段 `pollIntervalSeconds`；默认和最小值均为 5 分钟。
- 间隔只在“新 commit 自动测试”启用时可编辑；它表示多久查看一次场景测试分支是否出现可测试提交，不表示每隔该时间无条件执行测试。旧配置在启用自动 commit 测试时若小于 5 分钟，按 5 分钟安全下限读取。
- Cron 是独立的可选定时测试入口，留空不启用；页面明确使用 UTC 和五段表达式。
- 不新增后台自动连通性测试。

## 3. 全部配置检查

- Connectivity Registry 提供一次运行全部检查的能力，按固定顺序运行所有当前可用检查并返回完整列表。
- API `POST /api/connectivity/checks` 执行全部检查；`GET` 继续只读取最近结果，单项 POST 保持兼容。
- 总览只有一个“测试全部”按钮，不再显示逐项按钮。
- 总览显示通过数量和需要处理数量；每项继续显示具体状态、消息、时间和耗时。
- 未配置与未启用必须作为明确结果展示；不能算作通过。

## 4. YAML 导入导出

- `GET /api/config/export` 返回版本化 YAML；只包含 `harness` 与 `repository` 普通配置。
- YAML 根结构固定为 `version: 1`、`harness`、`repository`。
- Secret、Secret 掩码、连接检查结果、Run、队列和数据库状态均不导出。
- `POST /api/config/import` 接受 YAML 文本，大小受限；拒绝 YAML alias、重复键、未知字段、未知版本和任何 `secrets` 字段。
- 导入在一个 SQLite transaction 内更新 Harness 和 Repository；任一字段无效时全部回滚。
- 导入不删除、不替换现有 Secret；成功后使所有受影响的连接检查失效，并把确认后的配置返回页面。
- active Run 期间如果 YAML 改变目标仓库或场景分支，沿用现有拒绝规则。

## 5. 验收条件

- **AC-CONFIG-OPS-01**：GitHub 只有一个测试动作，并显示四项可解释的子结果。
- **AC-CONFIG-OPS-02**：具备明确 classic PAT scope 和仓库权限时 PR/Issue 不再显示 `unknown`；无法安全确认时仍 fail closed。
- **AC-CONFIG-OPS-03**：自动测试默认关闭，页面用分钟解释新提交检查间隔且不把它描述为周期测试。
- **AC-CONFIG-OPS-04**：总览一个按钮执行全部已保存配置检查，并逐项展示问题原因。
- **AC-CONFIG-OPS-05**：YAML 导出不含 Secret；导入严格、原子且不覆盖 Secret。
- **AC-CONFIG-OPS-06**：单项 Connectivity API、旧数据库配置和既有调度语义保持兼容。
- **AC-CONFIG-OPS-07**：format、lint、typecheck、unit、build 和 UI E2E 全部通过。
