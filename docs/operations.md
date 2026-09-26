# 罗网运维检查与恢复演练

适用于已经完成多项目离线升级的 v0.6.1 实例。测试服务器的容量只代表该机器当时的条件；部署容量应按项目镜像、构建缓存、浏览器和实际并发负载测量。

## 资源归属与容量

在与服务使用同一数据目录和 Docker Engine 的受控环境运行：

```bash
npm run build
npm run ops:inventory
```

Docker Compose 部署可使用 `docker compose exec luowang npm run ops:inventory`。此命令以只读模式打开现有数据库，只向 Docker 发出 `ps`、`image ls` 和 `inspect` 查询；没有数据库、迁移不完整、Engine 不可用或归属标签不一致时直接失败。JSON 中的 `instanceId` 和 `projectId` 用于确认资源属于哪个实例和项目。`referenced` 镜像被当前镜像状态或历史 Run 引用；`restart-candidate` 与启动恢复清理的标签、项目和 tag 条件相符；`manual-review` 需要人工核对，不能据标签直接删除。列出的容器也通过实例、项目、Run ID 和容器名共同核验。

`candidateImageBytes` 是候选镜像 `Size` 的相加值，不等于实际可释放空间：镜像层可能共享，容器或其他 tag 也可能阻止删除。无实例标签的旧镜像、无标签构建缓存和其他应用资源不在结果中。检查宿主机总占用时另用 `docker system df`，但不要在共享 Engine 上执行全局 prune。定期记录两者及 `/data` 所在文件系统的剩余容量；容量异常时先定位归属，再决定维护动作。当前没有自动删除历史 Run 或报告的期限。

## 恢复演练

1. 停止服务和调度，在停机状态下保存同一时点的 SQLite、repo、report 目录，以及部署配置中解密数据所需的主密钥材料。备份保存在受控位置，不提交 Git。
2. 将备份复制到隔离数据目录，使用独立的 Compose 项目名或测试 Docker Engine 启动候选；不要让副本与原实例同时连到同一 Engine。保留原数据库的 `instance_id`，因此隔离 Engine 是必要条件。
3. 在副本执行 `npm run db:multi-project -- verify` 和 `npm run ops:inventory`，启动服务并检查 `/health`、项目列表、历史 Run 与报告。断开并恢复一个非生产依赖，确认失败被显示为依赖故障，恢复后可重新检查。
4. 用专用测试数据在隔离 Engine 演练中断 Run 的恢复，核对其状态为 `interrupted`，遗留容器按实例、项目和 Run 归属清理，已引用镜像和历史报告保留。记录开始/结束时间、镜像与容器数量、数据库完整性检查及失败项。
5. 关闭并删除本次隔离候选的容器和临时数据，原实例按正常流程恢复。若演练失败，保留错误和备份，先查明原因，不在原实例上试删资源。

连续运行观察至少覆盖一次排队、执行、归档、重启恢复与依赖短暂失联；每次记录队列是否继续推进、是否有残留容器、候选镜像变化、磁盘余量和报告可读性。一次合成恢复测试只能证明这条受控路径，不能替代真实非生产环境的完整 Run。
