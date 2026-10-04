# 模型设置交互收尾 Plan

- 日期：2026-10-04
- 状态：实现与本地验收完成，等待 PR
- [Intent](intent.md) · [Spec](spec.md)

## 阶段

1. 统一运行时 Thinking 解析，Main/Final Main 共用保存值并为旧配置提供回退。
2. 实现可复用组合框、可编辑 Thinking、紧凑能力图标和角色帮助。
3. 统一 Provider 与 OSS Secret 行，调整管理员头像及响应式布局。
4. 更新单元与 UI workflow，运行格式、lint、类型、完整单元和 E2E 检查。
5. 提交 PR，检查通过后合入 develop，并使用原数据卷重建本地预览。

## 风险与控制

- 目录请求存在延迟和乱序：只展示当前 Provider 对应的结果，组合框允许手工输入。
- 历史 Thinking 可能不被新模型支持：运行时和 UI 使用同一角色默认规则回退。
- Secret 布局调整不能降低保密性：只根据 metadata 表达状态，禁止填入原值。

## 完成证明

- 运行时统一解析角色已保存的 Thinking；Main 与 Final Main 共用 `agents.main` 配置，无效旧值按角色默认档位回退。
- 模型页面已使用可输入组合框、可编辑 Thinking、能力图标、Reviewer 帮助、内联 Secret 状态和头像菜单。
- 2026-10-04 本机通过 `format:check`、`lint`、`typecheck` 和 `git diff --check`。
- 2026-10-04 在 `quality` 容器通过完整单元测试：103 个文件通过、1 个文件按设计跳过，共 518 项通过、2 项跳过。
- 2026-10-04 在 `quality` 容器通过完整 `test:e2e`，包括基础、Phase 8、v0.7 导航及 workflow smoke。
- PR、合并和预览重建结果在完成后补充。
