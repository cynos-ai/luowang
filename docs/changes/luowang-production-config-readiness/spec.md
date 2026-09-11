# 生产配置就绪 Spec

## 阶段思考与默认值

- 保留 main/runner/reviewer 三组配置和各自模型；产品创建 Session 时按阶段确定有效 thinking：策划 low、Runner off、Reviewer low、最终汇总 off，即低—关—低—关。初始化同职责阶段沿用同策略，不新增配置组或 Session。
- 阶段策略作用于 Session 配置副本，不写回用户保存值；已有实例配置不迁移、不覆盖。出厂三组 thinking 默认 low/off/low。配置文档说明存储值与固定阶段有效值的区别。
- 新验收不得在驱动中改写阶段 thinking；历史评测驱动/结果原样保留。Provider 校验以有效阶段策略而非旧存储 thinking 为准；Main 模型须同时支持 low/off，Runner 须支持 off，Reviewer 须支持 low 与既有视觉能力。不增加第四组检查。

## 清理资源域

- 复用既有 HTTP DELETE→独立 GET 适配器及非生产官网按完整 Run 前缀删除账号、外键级联会话的实现，不新增 Docker socket、SQL、脚本、路径或 URL 选择权限。
- 已批准在登记条目和 register_test_data 的可选字段加入 cleanupScope，唯一受支持值 website-accounts。只为当前 Run 在既定官网沙箱中创建的、按 Run 前缀标记的账号/会话选择该域；不能把容器、文件或其他资源绑定到该域。
- HTTP 适配器在任何网络操作前核对域及 Run 归属；未绑定、不支持的资源不调用删除接口，不生成 absent=true，保留残留待人工处理告警。旧登记不自动推断域，重复登记不能通过补字段篡改原归属。
- 域声明只选择已配置的固定能力，不提供删除完成证明。仍须真实删除、独立查询、响应 Run 校验、数量校验、超时/体积/重定向边界；未知和失败都不视为已清理。
- 清理在最终汇总后由 Harness 执行，保持幂等，失败可见但不改变 passed/failed/blocked 或 Bug。无配置继续告警。无新 Markdown、报告字段或持久化表。

## 验收与边界

工程证明覆盖有效阶段配置、默认值及已有值保留、已绑定成功/失败/未配置、未绑定/不支持域与跨 Run 拒绝、重复登记不升级归属、告警不改结果。全量测试及 lint/typecheck/build 在 quality 容器运行。

真实验收先冻结代码/输入/配置和远程写入范围。仅使用既有 OSS 桶/前缀的本次 Run 对象、cynos-ai/cynos-website 的 scenario-testing 测试资产与当前 Run 报告及 Archiver PR/Issue；不改历史报告或产品代码。本地 RunStore 不上传。正常/缺陷各一次，全链路请求总预算300，额度/鉴权错误立即终止。超出信封先停，不用本地替代器冒充真实验收。结果记录 hash、请求数、清理和归档事实、残余与限制；不声称全站/部署验收，不修改历史以提高分数。仅措辞问题入 backlog。
