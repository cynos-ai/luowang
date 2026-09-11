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

Limits：工程检查不等于真实业务验收通过。存储的 thinking 保留但有效策略固定，旧模型如不支持所需阶段能力将明确拒绝；旧无域登记保留告警，不自动升级或补清理历史。#64/#65及此前措辞问题不在本次扩大修复范围。

## 真实验收结果：业务验收 blocked

工程提交 `f602aad4ce7c338b17afd3ed7ab762fba065f1f6` 已提交 [PR #66](https://github.com/cynos-ai/luowang/pull/66)，对应 Quality CI 成功。随后按授权正常/缺陷各执行一次，未等待合并、未重跑。两次均完成四 Session、真实 RunStore、OSS、清理和 Archiver 流程，但 **AUTH-LOGIN-001 均未获得业务观察，不能宣称正常通过或缺陷检出成功**。

| 环境 | Run | 模型请求 | 功能结果 | 归档提交 |
| --- | --- | --- | --- | --- |
| 正常 | 01M27MDNT9QBJ7GAM68F3728C6 | 39（8/22/5/4） | blocked | c5aee38683eeeb9f73f50096b63488989a29e707 |
| 注入退出不撤销 Session 缺陷 | 01M27MKXPXKB53H58FD4TM9AB2 | 36（8/19/6/3） | blocked | e980181ff1562093deca6a48419102c370faf936 |

- 总计 **75/300 请求**，均 HTTP200、无 length 截断；API `total_tokens` 合计876248，不代表账单。八个 Session 均完成并 disposed。实际出站 thinking 为 low/off/low/off：low 使用 enabled + reasoning_effort=low，off 使用 disabled；驱动没有覆盖 thinking。
- 官网镜像 revision 为 `3e67fc4bfb4acc4465ba75a937fe2808982aeab5`。正常 Run target 为该 SHA；缺陷 Run target 为前次归档后的 `c5aee38683eeeb9f73f50096b63488989a29e707`。每 Run 固定不可变 SHA，独立 Git 比较确认除报告外全部内容与镜像 revision 一致，不能说两 Run 使用了同一个 target SHA。缺陷仅由独占沙箱代理注入，不修改 Git 产品代码。
- 两组各真实创建2个 Run 前缀账号并登记 website-accounts 域，产品 DELETE→独立 GET 后剩余0；独立 SQLite 查询 users/sessions/orphans 均为0。随后撤销独占容器/网络；环境撤销不充当产品清理证明。清理未改变两个 blocked 结果。
- OSS 实际上传13个命令证据（9+4），逐个远端 GET 与本地 SHA256 一致；不是浏览器/业务成功证据。Git 只新增各 Run 的 review.md/report.md，共4文件；归档内容逐字/hash 校验一致，未改历史或场景，无 Issue/场景 PR 创建，未推进通过基线。远程范围详见本地 `remote-write-scope.md`，本轮写入均在已预授权范围内。

### 阻塞归因与责任

验收驱动的零模型预检只覆盖模型解析与 GitHub 读取，没有先验证原生 Pi MCP 扩展在同一容器中的实际可用性，这是本轮验收准备缺口。两组 Runner 均转述 MCP 初始化失败 `ENOENT: mkdir '/home/node/.pi/agent'`，没有浏览器证据；受控命令不能绕过边界执行任意 HTTP/内联代码。正常组还保留依赖缺失、exit127及 npm 缓存 ENOSPC 的命令证据。

事后在相同镜像、只读根目录、无网络/无模型的文件系统诊断中，创建该目录复现同一 ENOENT；隔离容器没有给 Pi 状态目录提供可写位置。原始 MCP 返回未独立落成工件，因此将模型转述、文件系统复现、无浏览器证据三者分开，不把后验诊断补进原报告，也不把隔离缓存 ENOSPC 扩大为宿主机全盘空间不足。缺陷代理 `logoutInterceptions=0`，明确未触达注入点。HTTP200 和 controller exit0 都不能覆盖上述失败。

### 证据、限制与 backlog

- 上述验收目录保存冻结 source/driver/proxy manifest、两个 attempt 标记、`native-data/proof/`、`checks.json`、`audit.py`、`filesystem-diagnostic.json`、`image-provenance.json` 及 `independent-database-counts.json`。离线审计 `audit-1.exit=0` 只表示记录/边界核对通过，不表示业务通过。
- 正式报告：[正常](https://github.com/cynos-ai/cynos-website/blob/c5aee38683eeeb9f73f50096b63488989a29e707/docs/scenario-testing/reports/01M27MDNT9QBJ7GAM68F3728C6/report.md)、[缺陷环境](https://github.com/cynos-ai/cynos-website/blob/e980181ff1562093deca6a48419102c370faf936/docs/scenario-testing/reports/01M27MKXPXKB53H58FD4TM9AB2/report.md)。详细本地工件、数据库和凭据不上 Git。
- 41个 proof/Run 工件及证据文件的受控 Secret 精确扫描零命中（不扫描加密 Secret Store 数据库）。扫描先遇宿主缺原生 SQLite binding，再由源文件比较拒绝陈旧镜像代码；改用 quality 依赖和冻结源码后成功，`secret-scan*.log/.exit` 全保留，未因此重跑模型。
- 出站 cwd 中性检查通过；第二组可查询第一组已归档历史，不是盲测。最终 Main 未调用原始证据工具/OSS 读取；工具参数未保留，不能逐次追认 read_run_artifact 的读取对象，权限边界以产品门禁和工程回归为据。`humanScoring: not_run`。
- 后续工程 backlog：先以零模型验证实际 Pi MCP 扩展的可写状态目录、连接和取证能力，不能用模型/Git 连通代替；核对受控命令依赖及缓存容量。此轮未扩展命令/删除权限，未继续修复后重采样。
- 仅措辞 backlog：报告混用步骤/期望数量，缺陷报告 command-1 引入原证据不存在的 api.example.com 描述；真实命令是被策略拒绝的沙箱 health 请求。保留原报告，不追改、不单独以这些措辞阻塞发布；本轮未达到业务验收目标的原因是实际场景没有执行。

两个日常服务仍为原镜像且 healthy；未替换旧容器、卷、配置或历史。保留剩余225请求未使用，不创建额外样本。PR #66 未合并；没有发布 PR、部署、release 或 tag。本轮正常通过/缺陷检出的验收目标未达成，不能据机制审计通过声称已满足发布条件。
