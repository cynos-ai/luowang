# 模型设置交互收尾 Plan

- 日期：2026-10-04
- 状态：Draft PR 快速预览迭代中
- [Intent](intent.md) · [Spec](spec.md)

## 阶段

1. 统一运行时 Thinking 解析，Main/Final Main 共用保存值并为旧配置提供回退。
2. 实现可复用组合框、可编辑 Thinking、紧凑能力图标和角色帮助。
3. 统一 Provider 与 OSS Secret 行，调整管理员头像及响应式布局。
4. 更新单元与 UI workflow，运行格式、lint、类型、完整单元和 E2E 检查。
5. 提交 PR，检查通过后合入 develop，并使用原数据卷重建本地预览。
6. 根据页面走查修正组合框候选展示、统一 SelectBox、能力图标和浏览器工具设置；每批使用原数据卷重建预览，最终确认后再更新 PR 并执行完整合入流程。
7. 统一页面确认与输入弹窗，移除浏览器原生 confirm/prompt，并禁止缓存 SPA 入口 HTML，避免预览刷新继续加载旧资源。
8. 将单 Provider 迁移为多模型来源，增加来源独立凭据、连接验证、模型目录快照和按角色来源解析；模型来源与角色配置分区展示。
9. 将设置操作反馈接入顶部 Message 浮层，并修复模型分组保存漏传 `modelProviders` 导致新增来源的密钥保存返回 404。
10. 为模型来源删除增加站内二次确认、立即持久化和 Message 结果反馈，并复查设置页其他删除与凭据清除入口。
11. 为共享依赖增加配置变更触发和 30 分钟周期检查，保留只读状态快照与手动立即检查入口。

## 风险与控制

- 目录请求存在延迟和乱序：只展示当前 Provider 对应的结果，组合框允许手工输入。
- 历史 Thinking 可能不被新模型支持：运行时和 UI 使用同一角色默认规则回退。
- Secret 布局调整不能降低保密性：只根据 metadata 表达状态，禁止填入原值。
- 多来源凭据继续由 Secret Store 加密，配置 JSON 只保存来源元数据和已验证的公开模型目录；旧单 Provider 配置和密钥必须无损迁移。
- 本地预览包含尚未保存的用户输入：重建必须保留 `luowang-preview_luowang-data`，页面刷新不得擅自放弃或保存用户输入。

## 完成证明

- 运行时统一解析角色已保存的 Thinking；Main 与 Final Main 共用 `agents.main` 配置，无效旧值按角色默认档位回退。
- 模型页面已使用可输入组合框、可编辑 Thinking、能力图标、Reviewer 帮助、内联 Secret 状态和头像菜单。
- 2026-10-04 本机通过 `format:check`、`lint`、`typecheck` 和 `git diff --check`。
- 2026-10-04 在 `quality` 容器通过完整单元测试：103 个文件通过、1 个文件按设计跳过，共 518 项通过、2 项跳过。
- 2026-10-04 在 `quality` 容器通过完整 `test:e2e`，包括基础、Phase 8、v0.7 导航及 workflow smoke。
- Draft PR #128 已创建；最终确认前不合并。
- 快速预览批次已通过 `format`、`lint`、`typecheck`、`build` 和 `v07-ui-workflows-smoke`，并在保留原数据卷的前提下重建本地容器；完整质量门待最终确认后统一重跑。
- 站内弹窗批次通过多项目 `v07-ui-workflows-smoke`；`tests/app.test.ts` 与旧模式 `phase8-ui-smoke` 在固定 quality 容器通过。宿主机 Node 24 缺少 `better-sqlite3` Windows 原生绑定，不影响容器验证结论。
- 2026-10-05 Message 与 DeepSeek 来源修复通过 `format:check`、`lint`、`typecheck`、`build`；固定 quality 容器内多 Provider 相关 4 个测试文件、23 项测试全部通过。
- 本地预览实际完成临时 DeepSeek 来源的配置保存、独立密钥保存和连接探测，返回真实探测错误而非“模型来源不存在”；临时来源随后删除并保存，页面恢复为原有单来源。
- 2026-10-05 删除来源已使用罗网站内确认弹窗；未保存来源实测确认后移除并显示信息 Message。全仓前端扫描未发现浏览器原生 `window.confirm`、`window.prompt` 或 `window.alert`。
- 多项目页面的配置保存、凭据更新、检查、项目启停、测试提交、停止与后续处理统一接入 Message 成功/失败反馈；只读导航、筛选和展开操作不产生冗余反馈。
- 2026-10-05 共享依赖监控已接入配置变更、服务启动及 30 分钟周期刷新；相关 3 个测试文件在 quality 容器共 8 项通过。本地预览启动后自动检查模型 Provider、浏览器运行环境和对象存储，三项均产生真实成功快照，系统状态页可见检查时间且每 30 秒只读刷新。
- 2026-10-05 提交前完整回归发现配置 YAML 未接受新增模型来源字段，已补来源和角色引用的严格字段校验，并验证拒绝来源内的凭据字段；同步补齐路由测试的新迁移及浏览器 workflow 的异步等待、资源模拟和新控件定位。
- 本轮 quality 的格式、lint、类型、构建及全量单元通过（526 passed / 2 skipped）；完整 local 浏览器回归仍在执行，结果追加后才能声明本轮质量门完成。首次失败报告保存在本地忽略目录 `.cynos/settings-checkpoint-acceptance/` 和 `.cynos/settings-checkpoint-final/`。
- 最终收尾：2026-10-05 `test:acceptance:local` 返回 `local=passed, live=blocked, release=blocked`；格式、lint、类型、全量单元（526 passed / 2 skipped）、构建、完整 E2E、Phase 9 和工程专项全部通过。报告：`.cynos/settings-verified-local/2026-10-05T09-05-14-987Z-local/report.json`。新版 workflow 已覆盖命名 Token 接入、语言 SelectBox、模型分区、系统设置接口及项目资源返回，不删除原流程/视口断言。
- 同一实现的 runtime 镜像构建通过；只读文件系统、隔离 tmpfs、断网条件下原生 MCP/截图预检 `passed`，`modelRequests=0`。未部署长期实例、未运行真实模型联合验收或发布；旧失败证据保留。
