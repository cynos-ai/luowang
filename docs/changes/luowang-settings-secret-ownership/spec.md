# 全局设置凭据归位 Spec

- 日期：2026-10-04
- 状态：已确认
- [Intent](intent.md) · [Plan](plan.md)

## 1 信息架构

全局设置只保留“模型与角色”“浏览器”“对象存储”“本地数据”四个分组，不再显示“全局凭据”。

“模型与角色”包含 Provider、Provider Base URL、Provider API Key、Main/Runner/Reviewer 模型及 Thinking。API Key 展示是否已配置及掩码，允许在该页面设置、轮换和清除，但不回显原值。

“对象存储”包含 Endpoint、Region、Bucket、Public URL、Object prefix、访问模式、OSS Access Key ID 和 OSS Access Key Secret。两项 Secret 分别展示配置状态，允许设置、轮换和清除，不回显原值。

## 2 行为与安全

- 普通配置仍通过部署配置 API 保存；Secret 仍通过既有 `/api/deployment/secrets/:key` 单项 API 保存或清除。
- 保存 Provider 分组时，非空的新 API Key 与普通配置一同提交；任一步失败都显示实际的部分完成状态。
- OSS Secret 使用各自明确的保存/轮换与清除动作，不要求修改 OSS 目的地配置。
- 全局存在运行中请求时，Provider 配置及凭据保持不可修改；服务端现有 guard 仍是最终约束。
- OSS 普通目的地配置在全局执行锁定时不可修改；OSS 访问凭据仍可独立轮换，以恢复归档认证故障。
- 清除动作要求确认，并说明受影响项目可能无法运行或归档。
- 页面和测试不得读取或断言 Secret 原值；只核对掩码、请求目标和原值未出现在页面正文。

## 3 兼容

旧地址 `/settings/credentials` 规范化到 `/settings/models`，不保留旧编辑页面，也不形成 404。应用内不再生成该地址。

数据库、Secret storage key、AAD、API 和运行时读取规则不变，因此不需要数据迁移。项目设置中的 `/projects/:projectId/settings/credentials` 不受影响。

## 4 验收条件

- AC-SSO-01：全局设置只显示四个分组，页面中不存在“全局凭据”入口。
- AC-SSO-02：Provider API Key 只能从“模型与角色”编辑，并可设置、轮换、清除。
- AC-SSO-03：OSS 两项凭据只能从“对象存储”编辑，并可设置、轮换、清除。
- AC-SSO-04：旧全局凭据地址替换为模型设置地址；项目凭据地址仍正常。
- AC-SSO-05：运行锁、Secret Store、脱敏和作用域边界保持；现有 Secret 无迁移或丢失。
- AC-SSO-06：路由、设置交互、768/1024/1440px 页面和适用质量检查通过。

