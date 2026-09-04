# 罗网配置操作优化 Plan

## Phase 1：检查语义与 API

- 扩展 Connectivity Registry 的全部检查入口。
- 增加 `POST /api/connectivity/checks`。
- 使用 GitHub repository permissions 与明确的 classic PAT scopes 改善非破坏性权限判断。
- 增加 GitHub 与 Connectivity API 回归测试。

完成证明：一个请求返回完整有序结果；明确权限不再误报 unknown；不产生远端副作用。

## Phase 2：自动测试与总览交互

- 把轮询输入改为分钟并解释实际语义。
- 保持自动测试默认关闭，把新数据库默认检查间隔调整为 5 分钟。
- GitHub 配置区改为单动作、聚合结果；总览改为单个“测试全部”按钮与问题计数。

完成证明：UI E2E 覆盖单按钮、结果明细、默认关闭和分钟换算。

## Phase 3：YAML 配置迁移

- 建立严格、版本化、无 Secret 的 YAML serializer/parser。
- 增加认证后的导出/导入 API和 SQLite 原子更新。
- 增加独立配置文件组件，实现下载、选择文件、确认导入和页面状态刷新。

完成证明：round-trip、未知字段、Secret、重复键、alias、无效值、原子回滚与 active Run 边界测试通过。

## Phase 4：完整验证与交付

- 运行 image-native format、lint、typecheck、全量 test、build 和 UI E2E。
- 在桌面和窄屏检查 GitHub、自动测试、总览与 YAML 操作。
- 执行独立代码复核和 Secret 扫描，经功能分支 PR 合入 `develop`。

完成证明：所有门禁通过；不移动 `v0.3.0` 及既有 tag。
