# 实施计划

基于 origin/develop 的最新合并提交 e935cca（PR #66）创建独立分支，仅处理受控 Cookie 会话重放能力。

1. 复用 `src/server/browser/playwright-mcp.ts` 的既有 owner：启用标准 `--caps=storage` 开关，导出批准的三项 Cookie 工具常量，并把未获授权的 storage 工具加入排除清单；连接检查把三项工具纳入必需面并校验完整排除清单。
2. 在 `src/server/browser/preflight.ts` 的真实适配器清单上校验“批准面存在、排除面不可见”，其余状态目录、tmpfs、导航、截图与释放检查不变。
3. 回归覆盖启动参数、排除清单、缺能力失败路径；执行 quality 容器 format/typecheck/lint/build 与全量测试，保留失败日志。
4. 新增本变更的 intent/spec/plan 与必要文档说明；提交并向 develop 开 PR，不等待合并继续验收准备。
5. 冻结新候选，在真实隔离容器对两个非生产沙箱执行零模型预检；预检全绿后才创建正常/缺陷各一次业务 Run，总预算 300 请求，不重跑、不追分。任一环节超出远程写入信封或出现鉴权/额度错误即停止。

## 已知事实

合并后新轮预检仅因缺少 Cookie 读取/恢复能力失败：技术预检全部通过，业务 Run 未创建，请求 0/300，环境已撤销。既有失败证据保留。

## 工程完成证明

- 启动参数、必需工具、排除清单与缺能力失败路径的回归；quality 容器全量检查与构建。
- 真实 CLI 预检：批准面存在、排除面不可见、浏览器导航与截图成功。

## 真实验收与限制

预检与业务 Run 证据保存在 `.cynos/acceptance/production-config-02/`；预检失败时业务 Run 不创建。完整 Cookie 值不落入报告与证据。模型不重跑，`humanScoring: not_run`；不声称发布、部署或全站验收。
