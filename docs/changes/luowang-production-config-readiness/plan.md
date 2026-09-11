# 实施计划

基于 develop@239e838，分支 feat/production-config-readiness。

1. 复用 configuration、Session 输入组装、test-data manager 和 HTTP adapter 的既有 owner；实现阶段策略、默认值、已批准的资源域绑定。更新配置说明和被覆盖 Spec，不迁移旧配置。
2. 添加回归，执行 quality 容器全量测试、format/lint/typecheck/build；保留失败日志，同一问题修复重试超过3次仍失败即停。
3. 提交并向 develop 开 PR，列出工程证据及 Limits；不等待合并，进入真实验收准备。
4. 在 `.cynos/acceptance/production-config-readiness/` 固定远程写入范围、桶/前缀、GitHub路径、保留与失败清理策略。范围内标记已预授权，超出范围停机请求批准。
5. 正常/缺陷各一次完整真实链路，总预算300请求；产品决定阶段思考，驱动不覆盖。输出 hash、请求计数、RunStore/OSS/GitHub/清理/归档证据与残余；不得重跑。额度或鉴权错误立即停。

## 已知事实

既有 HTTP adapter 只查询账号却可把任意 Run 前缀登记视为已清理，离线复现见 `cleanup-scope-probe.ts/json`。该复现不是真实验收，模型请求0、远程写入0。负责人已批准最小资源域绑定后继续；原复现及历史报告保持不变。

## 工程完成证明

阶段策略由 Session 输入组装和 Provider 能力校验共享实现；Main 同一模型验证 low/off 两种用途，不新增 Agent 配置。configuration 默认 low/off/low，SQLite 回归确认旧值不被覆盖。登记工具/manager 传递可选 website-accounts 域，HTTP adapter 在请求前拒绝未绑定域；失败保持可见告警。复用原有 DELETE/独立 GET、Run 归属、幂等和凭据边界。

quality 容器执行 format/lint/typecheck/build、全量236测试/33文件通过，日志 `engineering-5.log/.exit` 位于上述验收目录。阶段输入及生产 Pi 接线、默认/旧配置、清理成功/失败/未配置、未绑定域/重复登记和不改 passed/failed/blocked 均有回归。首次工程检查通过后扩充 blocked 回归时，记录了空场景聚合不一致和漏建场景两个 fixture 问题（engineering-2/3），分别修复，engineering-4/5通过；未删除失败记录、未进行模型重跑。

Limits：未声称真实模型或远端验收通过。存储的 thinking 保留但有效策略固定，旧模型如不支持所需阶段能力将明确拒绝；旧无域登记保留告警，不自动升级或补清理历史。#64/#65及此前措辞问题不在本次扩大修复范围。
