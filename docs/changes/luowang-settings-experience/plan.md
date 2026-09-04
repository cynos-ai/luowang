# 罗网设置与登录体验改进 Plan

## Phase 1：配置与目录接口

- 为 Harness 增加兼容性的 Provider Base URL 字段和校验。
- 扩展 Provider Adapter，使其可列出已知 Provider、按 Provider 查询模型，并在当前 Runtime 应用 Base URL 覆盖。
- 扩展认证后的 Provider API，补充 Provider 目录和筛选模型。
- 增加配置、Provider 和 API 专项测试。

完成证明：专项单元/API 测试与 typecheck 通过；无 Secret 出现在响应中。

## Phase 2：前端模块化与设置闭环

- 抽取 API helper、Shell、LoginPanel 和通用表单组件。
- 建立独立 SettingsPage，以模型服务、Agent、MCP、OSS、GitHub、测试环境、自动化和安全组件组合。
- 在所属组件内实现保存、保存并测试、结果反馈和模型能力提示。

完成证明：组件源文件边界清晰，`App.tsx` 不再包含设置与登录表单实现；UI E2E 覆盖关键交互。

## Phase 3：视觉比例与响应式

- 压缩顶部健康状态，增加控制台有效宽度。
- 调整登录页卡片、标题、间距和窄屏布局。
- 使用真实构建在桌面与窄屏截图检查设置页和登录页。

完成证明：浏览器截图无溢出、遮挡或过大空白；视觉模型能力与检查状态可辨认。

## Phase 4：完整验证与交付

- 运行 format、lint、typecheck、全量 test、build、E2E。
- 执行独立代码复核和 Secret 扫描。
- 通过功能分支 PR 合入 `develop`，不移动既有发布 tag。

完成证明：所有门禁通过，PR Quality 成功，遗留风险明确记录。
