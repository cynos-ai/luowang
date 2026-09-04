# 罗网设置与登录体验改进 Intent

## 当前问题

当前配置页把模型 Provider、角色模型、MCP、本地目录和 OSS 放在一个很长的 Harness 表单中，凭据与所属服务分离。操作者无法按外部依赖完成“配置、保存、测试、查看结果”的闭环，模型也只能手工填写，容易给 Reviewer 选择不支持图像输入的模型。

页面顶部的服务与 SQLite 状态占用过多纵向空间，登录卡片与大标题的比例也不协调。前端主要界面集中在单个 `App.tsx`，继续演进配置体验时修改边界不清晰。

## 期望结果

- 每项外部依赖按自身职责组织配置、Secret、测试按钮和最近结果。
- Provider 可配置可选 Base URL 和 API Key；模型从所选 Provider 的实际目录中筛选。
- 模型能力可见，Reviewer 的视觉能力要求不会被静默忽略。
- 页面更紧凑，登录页、顶部健康状态和设置表单的视觉比例合理。
- 设置、登录和通用表单控件具有清晰的组件边界。

## 影响

主要影响管理员控制台、配置 API 的 Provider 元数据、Provider Runtime 的 Base URL 覆盖，以及 UI/E2E 回归。

## 约束

- 保持单租户、单目标仓库、单测试环境和单 active Run。
- Secret 只进入现有 Secret Store，接口与页面不得回显 Secret。
- 保持确定性 Built-in Role Instructions 和“不使用 Pi Skills”的运行边界。
- 连接测试必须使用已保存配置，不把未持久化草稿伪装为已验证状态。
- 不改变现有 Run、归档、队列和仓库事实语义。

## 非目标

- 不增加多 Provider 凭据库或每个 Agent 独立 Provider。
- 不实现任意自定义模型目录编辑器；本次支持选择 Pi Runtime 已知 Provider/模型及覆盖已有 Provider Base URL。
- 不重做总览、场景、Runs 和 Git 树的产品结构。
