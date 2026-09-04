# Run 可观测事实重启持久化 Plan

## Phase 1：数据库与 Store

- 增加可向后升级的 JSON 列迁移。
- 扩展 Completed Run 导入、读取和幂等冲突校验。

证明：migration 与 Run Store 专项测试通过。

## Phase 2：生产写入与读模型

- Orchestrator 完成 Run 时传入 Evidence、阻塞原因、进度和活动。
- Operations Service 在没有进程内 Run 时使用持久事实。

证明：API 测试只使用 Stored Run 仍返回完整字段。

## Phase 3：重启验证

- 在真实候选实例创建含截图的 passed Run 和环境 blocked Run。
- 重启容器后重新读取两者，并执行 Closure live acceptance。

证明：截图 Evidence、活动、阻塞原因和不推进事实在重启后可复核。
