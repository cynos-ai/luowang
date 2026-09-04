# Run 可观测事实重启持久化 Spec

## 行为

- Completed Run Store 保存 `evidence`、`blockingReasons`、`scenarioProgress` 和 `activities`。
- Evidence 只保存既有引用元数据，不保存对象正文；Secret 边界保持不变。
- 同一 Run 的重复导入保持幂等；非空且不同的可观测元数据构成冲突。
- Operations read model 在运行时状态不存在时从 Stored Run 恢复上述字段。
- 迁移为旧行提供空 Evidence、空阻塞原因、空活动和未知进度，不宣称旧事实已恢复。

## 验收条件

- **AC-RUN-RESTART-01**：新完成的 passed Run 在进程重启后仍返回截图 Evidence、完整进度和活动。
- **AC-RUN-RESTART-02**：新完成的 blocked Run 在进程重启后仍返回阻塞原因且保持不推进。
- **AC-RUN-RESTART-03**：从现有数据库升级不丢失 Run、报告、Issue 或归档状态。
- **AC-RUN-RESTART-04**：重复导入相同数据幂等，冲突数据 fail closed。
