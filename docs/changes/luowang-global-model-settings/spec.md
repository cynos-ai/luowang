# 全局设置模型页易用性修正 Spec

## 1. Provider 目录

- `GET /api/provider/providers` 在现有 `id`、`name` 之外返回可选的 `baseUrl`，值来自 Pi `ModelRuntime` 目录中该 Provider 的默认地址，不做推导或补全。
- 该接口只返回公开目录元数据，不返回任何凭据；未登录仍为 401。
- 旧服务与多项目服务使用同一 `createProviderAdapter` 行为。

## 2. Base URL 自动填充

- 顶部 Provider 输入支持输入和从目录选择，行为不变。
- Provider 值变化时，`Provider Base URL` 立即替换为该 Provider 的目录默认地址；目录中没有该 Provider 时置空。
- 目录异步加载完成后，如果当前 Provider 已有默认地址且 Base URL 仍为空，则填充一次；已有非空值（包括自定义代理地址）不被覆盖。
- 已保存的非空 Base URL 在 Provider 未变化时保持原值；用户仍可手工清空或改写。
- 不校验地址是否真实可达；可达性由连接检查判断。

## 3. Provider API Key

- “模型与角色”分组包含 `Provider API Key` 密码输入框，显示 `已配置 <掩码>` 或 `未配置`，不显示原值。
- “保存本分组”先保存普通配置，再在该输入非空时通过现有 `/api/deployment/secrets/providerApiKey` 写入 Secret；写入成功后清空输入并提示“配置与 Provider API Key 已保存。保存不等于连接检查通过。”。
- Secret 写入失败时，配置保持已保存状态，错误信息明确区分两者；输入保留以便重试。
- “全局凭据”分组继续提供 Provider API Key 的轮换与清除，两处操作同一 Secret，不新增第二个存储位置。

## 4. 文案

- 移除模型分组的标题说明段与 Provider、模型字段的用法提示。
- 目录状态只表达事实：`正在加载已知模型目录…`、`已载入 N 个已知模型`、`暂无已知模型`、`目录加载失败：<原因>`。
- 保留 Reviewer 非视觉/未匹配模型的阻塞性警示；保留加载失败与未配置等真实状态文字。
- 其他设置分组的现有文案不在本次范围。

## 5. 验收条件

- **AC-GMS-01**：选择已知 Provider 后 Base URL 自动填充为该 Provider 的目录默认地址；切换 Provider 时同步更新，未知 Provider 为空。
- **AC-GMS-02**：目录加载完成时，空 Base URL 被填充一次；已有自定义值时不被覆盖。
- **AC-GMS-03**：模型分组可直接保存 Provider API Key，响应体和页面不回显原值；连接检查语义不变。
- **AC-GMS-04**：未知 Provider、目录失败和目录为空时，Provider 与模型输入不被静默改写，错误以事实文字表达。
- **AC-GMS-05**：模型分组不再显示标题说明段和字段用法提示；Reviewer 视觉警示保留。
- **AC-GMS-06**：`format:check`、`lint`、`typecheck`、单元测试、真实多项目路由测试和浏览器 E2E 通过，并更新 4180 预览实例。
