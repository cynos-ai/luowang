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

预检与业务 Run 证据保存在 `.cynos/acceptance/production-config-02/` 与 `.cynos/acceptance/production-config-02-completion/`；预检失败时业务 Run 不创建。完整 Cookie 值不落入报告与证据。模型不重跑，`humanScoring: not_run`；不声称发布、部署或全站验收。

## 真实验收结果（正常 blocked、缺陷已检出）

候选 `47557db`（PR #67，未合并）在授权轮内使用 228/300 请求，未重跑取分：

| Run | 环境 | 结果 | 请求 | 归档 |
| --- | --- | --- | --- | --- |
| 01M27WT4D369DJ42VXFTVRRZSC | 正常（阶段一） | failed：外部传输中断导致 Runner 异常中止，无业务结论 | 48 | 无 |
| 01M27X2RS07BRA6CBAW1TSKCKY | 注入缺陷 | **failed：命中注入缺陷** | 104 | `7760181` |
| 01M2HGSHY9MXQ4QP2S5SYDY831 | 正常（阶段二） | **blocked** | 76 | `6405a45` |

- 两次零模型预检均全绿：批准的 Cookie 三项工具存在、排除项不可见，浏览器导航/snapshot/PNG 与释放通过。
- 缺陷轮完整检出：退出未在服务端撤销会话，原 Cookie 退出后仍取得资料；confirmed Bug 以只读方式关联既有 cynos-website#5，未创建 Issue 或改写历史。
- 正常轮已实际使用 Cookie 重放，但期望 C 由 Reviewer 判 blocked：`browser_cookie_get/set` 输出与请求头记录未进入可复核证据面（现有证据类别只有 command/browser/image），401 无法与原会话撤销、无 Cookie 未认证区分。Reviewer/Main 未把叙述当证据、未降级期望、未虚构 Bug。
- 剩余 72 请求不足以再跑一条完整链路，且用户要求不重跑，因此正常通过目标在轮内未达成。
- 已确认边界：各 Run 账号 2→0 且独立核验；独立数据库计数 0；环境完全撤销；日常服务与官网镜像未变；`audit-round.py` exit 0。

后续若要正常轮判 passed，需负责人决定是否扩展“重放证据可持久化且 Reviewer 可读”的能力（工件/证据协议变更），并以新预算重新授权；本 PR 不包含该扩展。
