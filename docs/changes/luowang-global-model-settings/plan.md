# 全局设置模型页易用性修正 Plan

- 状态：实现与本地验证完成；待 CI 与预览实例更新

## 修改范围

- `src/shared/types.ts`：`ProviderInfo` 增加可选 `baseUrl`。
- `src/server/runs/provider.ts`：`listProviders()` 从 Pi 目录带出默认 `baseUrl`。
- `src/web/pages/GlobalSettingsPage.tsx`：Base URL 自动填充、模型分组内 Provider API Key、移除解释性文案、目录状态精简。
- `src/web/pages.css`：模型服务字段三列响应式布局。
- `tests/e2e/v07-ui-workflows-smoke.ts`：Base URL 自动填充、API Key 保存、目录失败与迟到响应的回归。
- `tests/multi-project-app.test.ts`：真实多项目路由断言 Provider 目录含 `baseUrl`。

## 实施顺序

1. 目录响应带出 `baseUrl` 并补类型。
2. 页面接入自动填充与 API Key 保存流程。
3. 移除解释性文案，精简目录状态。
4. 更新 E2E 与多项目路由测试。
5. 运行质量门禁，合入 develop 后重建并更新 4180 预览。

## 验证

- `npm run format:check`、`npm run lint`、`npm run typecheck` 通过。
- quality 容器 `npm test`：475 passed / 2 skipped。
- 浏览器 E2E（v07 workflows）与完整 `npm run test:e2e` 通过。
- 4180 预览实例更新后健康，页面显示自动填充的 Base URL、API Key 输入与精简文案；真实登录状态由操作者确认。

## 第二轮反馈（预览实测）

- 问题：提示条沿用旧深色主题文字色，在纸白底上不可读；目录状态和能力标签同样对比度不足；保存提示仍带“保存不等于连接检查通过”等解释句。
- 修改：`src/web/pages.css` 用 v0.7 令牌覆盖 `.notice`、`.catalog-summary`、`.role-requirement`、`.capability-*`、`.model-meta` 的颜色；`src/web/pages.css`/`GlobalSettingsPage.tsx` 移除各分组标题说明段并精简保存提示。
- 客观证据：容器内构建后以无头浏览器读取计算样式，通知条 17.51:1、目录状态 19.77:1、能力标签 19.77:1、字段提示 6.1:1、模型描述 6.1:1，均高于 WCAG AA 4.5:1；全页截图见 `.cynos/settings-preview.png`（本地验证产物，不入库）。
- 预览脚本 `.cynos/settings-preview.ts` 仅为本地验证，使用模拟 API，不连接真实凭据。

## 风险与边界

- 自动填充来自 Pi 目录的公开默认地址；自定义代理写入后按普通配置保存，不改变 Secret 与检查语义。
- Provider API Key 在模型分组与全局凭据两处可写同一 Secret，页面间切换会触发未保存确认，不产生第二个事实源。
- 本次不改 Provider 解析、连接检查、Run 调度与归档。
