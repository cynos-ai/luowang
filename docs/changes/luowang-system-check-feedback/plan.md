# 系统状态检查反馈 Plan

- 状态：实现与本地验证完成；待 CI 与预览实例更新

## 修改范围

- `src/shared/types.ts`：新增 `SystemCheckResponse`。
- `src/server/projects/console-service.ts`：`runSystemCheck` 返回 `{ check, result }`。
- `src/server/projects/console-routes.ts`：直接返回服务结果，不再包装为 `{ check }`。
- `src/web/pages/SystemStatusPage.tsx`：行内状态覆盖、未启用原因与失败文本；移除顶部检查错误通知。
- `src/web/pages.css`：`.dependency-note` 行内提示样式。
- `tests/multi-project-console-routes.test.ts`、`tests/multi-project-system-status.test.ts`：断言新响应结构与结果。
- `tests/e2e/v07-ui-workflows-smoke.ts`：OSS 检查返回未启用原因、失败路径显示行内错误。

## 实施顺序

1. 接口返回实时 `result` 与持久化 `check`。
2. 页面以本次结果更新行内状态，并渲染未启用原因/失败文本。
3. 补样式与单元/E2E 回归。
4. 质量门禁通过后合入 develop，重建并更新 4180 预览。

## 验证

- `npm run format:check`、`npm run lint`、`npm run typecheck` 通过。
- quality 容器 `npm test`：475 passed / 2 skipped。
- 完整 `npm run test:e2e` 通过，含“未启用原因行内显示”和“请求失败行内报错”。

## 风险与边界

- `result` 只描述本次检查，不替代持久化快照；未启用能力仍不写库。
- 行内提示不缓存跨页面状态，刷新后回到真实快照。
- 不改变既有检查判定、告警与归档语义。
