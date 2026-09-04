# 罗网设置与登录体验改进 Spec

## 1. 页面结构

设置页按独立职责展示以下组件：

1. 模型服务：Provider、可选 Base URL、Provider API Key、模型目录加载与连接测试。
2. Agent 模型：Main、Runner、Reviewer 的模型与 Thinking 配置。
3. 浏览器自动化：Playwright MCP 开关、浏览器、Headless 和超时，并可单独测试。
4. Evidence 存储：S3-compatible OSS 设置、凭据与读写测试。
5. GitHub 仓库：仓库、场景分支、模式、标签、Git Token 和四项 GitHub 能力检查。
6. 测试环境：Base URL、环境说明、外部数据库说明、测试账号与密码，并可单独测试 URL。
7. 自动触发与本地目录：轮询、Cron、commit 触发、目录和保留天数。
8. 安全：管理员密码修改。

每个有外部依赖的组件在本组件内提供测试动作与最近结果；底部保留统一连通性总览。

## 2. Provider 与模型

- Harness 配置增加 `providerBaseUrl`，为空时使用 Pi Runtime 的默认 Provider 地址。
- 非空 Base URL 必须是没有内嵌用户名或密码的 HTTP/HTTPS URL。
- Runtime 只对当前已知 Provider 应用 Base URL 覆盖；未知 Provider 仍明确失败。
- API 提供已知 Provider 目录，并可按 Provider ID 查询模型。
- 页面切换 Provider 后加载该 Provider 的模型目录；模型输入支持按 ID 或名称搜索。
- 模型选项和已选模型显示文本、视觉、推理能力及可用 Thinking levels。
- Reviewer 明确标注“视觉审核”；选择不支持图像输入的模型时显示阻塞性提示，不将该配置显示为可用于视觉场景。
- Provider 连接测试必须先保存当前 Provider、Base URL、API Key 和三个角色模型，然后调用现有 `provider-model` 检查。

## 3. 其他配置的测试闭环

- Playwright、OSS、测试环境和 GitHub 检查复用现有后端 connectivity owner。
- “保存并测试”先持久化对应配置与 Secret，成功后再运行该组件的检查。
- 页面清楚区分未配置、待检查、通过、失败、超时、不可达和能力未启用。
- 检查结果显示消息、延迟和检查时间；测试失败不得显示成功通知。
- 影响外部依赖的配置或 Secret 发生变化后，对应旧检查结果立即失效为待检查，不能继续显示旧的通过状态。
- Secret 输入继续使用密码控件；已保存值只显示统一掩码，可显式删除。

## 4. 布局与组件

- 顶部 Gateway/SQLite 由大卡片改为紧凑状态条，保留状态、版本和最近检查时间；默认版本从随镜像发布的 `package.json` 读取，不使用会过期的硬编码版本。
- 控制台最大内容宽度适当增加，减少三个 Agent 模型卡片拥挤。
- 登录卡片居中、限制宽度，标题与表单形成更均衡的比例。
- API 请求、通用表单控件、Shell、登录页和设置页分别拥有独立模块；设置页内部以职责组件组合。
- 窄屏下各配置组件、操作按钮和 Agent 卡片单列展示。

## 5. 安全与兼容

- 旧数据库中没有 `providerBaseUrl` 时规范化为空字符串，无需迁移。
- Provider 目录和模型目录只返回公开模型元数据，不返回凭据。
- Base URL 不允许 URL userinfo；API Key 不写入普通配置、日志或响应。
- 现有 `/api/provider/models` 默认行为保持兼容，新增 Provider 查询能力不影响 Run 调度。

## 6. 验收条件

- **AC-SETTINGS-01**：Provider、Base URL、API Key、保存与连接测试位于同一组件，测试使用刚保存的配置。
- **AC-SETTINGS-02**：模型按所选 Provider 加载并可搜索，显示视觉和推理能力。
- **AC-SETTINGS-03**：Reviewer 显示视觉审核要求，非视觉模型产生明确警告。
- **AC-SETTINGS-04**：Playwright、OSS、GitHub 和测试环境均可在所属组件中保存并单独检查。
- **AC-SETTINGS-05**：Secret 在 UI、API 和测试输出中不回显。
- **AC-SETTINGS-06**：顶部健康状态为紧凑布局，登录页比例在桌面和窄屏均可用。
- **AC-SETTINGS-07**：设置页、登录页、Shell、API helper 和表单控件不再集中在 `App.tsx`。
- **AC-SETTINGS-08**：旧配置兼容，完整 format、lint、typecheck、unit、build 和 headless E2E 通过。
