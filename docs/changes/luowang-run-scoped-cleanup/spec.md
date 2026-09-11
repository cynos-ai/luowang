# 按 Run 清理契约

## 测试目标

cynos-ai/cynos-website 是负责人授权的专用非生产目标。仅清理 email 或 display_name 以 `luowang-<完整Run ULID>-` 开头（大小写不敏感）的账户；删除账户关联会话由现有外键级联完成。未标记数据不在范围，不能将其称作已清理。Run 标记规则不变，不接受自由 SQL 或任意用户 ID。后续 [生产配置就绪 Spec](../luowang-production-config-readiness/spec.md) 要求登记显式绑定 `cleanupScope: website-accounts`；未绑定或不支持的资源保留人工处理告警，不得依据账号计数替代其他资源的清理核验。

## 接口

目标仅在部署提供不少于32字符的 `CYNOS_TEST_DATA_CLEANUP_TOKEN` 后启用 `GET/DELETE /api/luowang/test-data/:runId`。无Token时无路由；不提供默认Token。使用独立Bearer Token鉴权，不借用共享测试账号。Run ID须为完整ULID，不能使用前缀、通配符或全库操作。响应只有runId、deleted、remaining，不返回账户信息。DELETE在事务内执行；GET重新查询事实，不使用缓存。

## Harness

部署设置 `LUOWANG_TEST_DATA_CLEANUP_URL` 为完整接口前缀（不含Run ID、凭据、query/hash）。共享专用Token存入现有加密Secret Store的 `testDataCleanupToken`，在设置页测试环境区域维护，不交给Agent环境工具；所有Secret扫描和脱敏覆盖此键。

默认应用入口配置了URL时自动注入受控HTTP adapter；未配置时保留原有能力告知和告警。adapter在网络操作前验证本Run登记前缀和账号清理资源域，固定URL追加完整Run ID，拒绝重定向；先DELETE，后独立GET。两次响应均须HTTP200、对应Run和非负整数remaining；GET为零才确认absent。总超时10秒，响应限制4096字节；不将远程原文或异常中的凭据写入收尾。

时序、结果和Bug所有权保持single-handoff Spec：最终Session结束后清理，不因清理失败改变功能结果。已配置表示存在adapter，不代表凭据/网络/清理已通过。无额外角色、发布权限或语义结果门禁。

## 验收

覆盖默认关闭、鉴权/Run错误、精确标记、其他Run与相似前缀保留、级联会话删除、重复删除幂等、独立GET、缺少Token、网络/响应异常及剩余数据告警。工程测试通过后用隔离真实HTTP联通两端；运行期密钥只驻留受控Secret Store和内存/部署密钥传输，不写Git或报告。不把脚本Session声明成真实模型Session。
