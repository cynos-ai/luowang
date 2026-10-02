# 项目独立并行测试 Plan

- 日期：2026-10-02
- 状态：实现、完整 local 与本轮并行 live 已完成；PR #120 交付，未发布
- [Intent](intent.md) · [Spec](spec.md)
- 负责人已授权开发、隔离实例与两个指定非生产目标的真实模型验收；模型调用不另设次数上限，费用由负责人外部限制。未授权发布。

## 1. 当前事实与 owner

开发基线为 develop `2009689664405981429ff6cbdf3c54347c110ec3`，2026-10-02 只读核对本地与远端一致。GitHub 最新 Release 为 v0.7.1；develop 含后续设置及系统状态修复。`docs/PROJECT.md` 的 v0.6.2 当前基线段已陈旧，开发收尾时按真实发布/合入状态校准，不能提前写成本功能已上线。

| 现有 owner | 已核对事实与后续修改重点 |
| --- | --- |
| `src/server/automation/project-queue-coordinator.ts`、`queue.ts` | 两层都存在全局 running 拒绝；须一起改为容量和项目互斥，原子性不能只依赖进程 Map |
| `src/server/automation/project-dispatcher.ts` | 单 activeRun、顺序等待 processClaimed；改为有界活动集合和可靠完成调度，沿用现有恢复/归档 |
| `src/server/projects/background-scheduler.ts` | tick 等待 drain，长 Run 可持续占住 activeTick；调整等待职责并验证自动触发能持续入队 |
| `src/server/projects/task-runtime.ts`、`run-services.ts` | 已按任务冻结项目输入，装配各自 repository/Secret/workspace/OSS/cleanup；并行下核验可变状态与锁 |
| `src/server/browser/playwright-mcp.ts`、`src/server/projects/command-session.ts`、`docker-recovery.ts` | 浏览器 isolated、Run 容器及实例标签已有；补同时存活、分项释放和启动回收边界证明 |
| `src/server/projects/deployment-configuration.ts`、`guarded-secrets.ts` | 已按所有 running 请求/本项目任务保护配置，审计并行认领与更新竞争，不能缩成只看一个 Run |
| `src/shared/types.ts`、项目 console/run routes/service 与 `src/web/pages/**` | 单 currentRun/activeRun 和全局 position 需要贯通调整，包含尚无 Run 的准备请求 |
| `src/server/config.ts`、`compose.yaml`、`.env.example` | 接入启动并发上限，系统只读展示；不修改真实 `.env` |
| `src/web/styles.css`、`tokens.css`、`pages.css`、模型设置页 | #118/#119 局部修复，不退役整套旧 UI |
| `src/server/repository/git-repository.ts`、项目 readiness | Git 超时已存在（远程检查 30 秒、传输 5 分钟）；#94 核对通用 catch 是否丢失原因，不重写网络层 |

## 2. 实施顺序与退出条件

从已核对的最新 develop 基线建立 `feat/project-concurrency`，通过 PR 交付。下面保留实施和退出要求，实际进展见第 5 节。

### Phase 0：授权与基线固定

- 负责人审阅本目录并授权开发；版本号和发布授权不预设。
- 核对本轮候选输入、既有测试和未提交工作。以 Spec 的 owner/AC 为范围，发现影响产品或数据边界的偏差先更新规格。
- 按现有模式追踪所有认领入口、同项目 Git 锁、共享 MCP/模型状态、退出和恢复调用关系。
- 退出：实现范围与测试切片明确；不依赖 live Secret 即可开始确定性工程工作。

### Phase 1：明确缺陷与既有能力核验

- 修复 #118/#119，增加目录四状态及真实滚动条占宽条件的浏览器回归。
- #94 先核对 `tests/git-remote-timeout.test.ts`，再补 stalled remote → readiness API → 页面链路。仅在真实缺口处修改。
- 验证局部滚动、内容完整、768/1440px、项目页与全局页，以及安全失败信息。
- 退出：AC-PC-09/10 有可复核证据；不把 issue 状态或既有测试文件存在写成当前测试通过。

### Phase 2：并发调度与执行隔离

- 接入启动并发上限和校验，统一原子认领；在 existing Coordinator/Queue/Dispatcher 上完成项目内串行、跨项目轮转填充。
- 管理多个活动请求，包括准备中无 Run 的请求；拆开后台触发调度与等待任务结束的职责，防止 activeTick 长期阻断后续自动请求。
- 复核任务快照、Git 互斥、MCP、命令容器、证据和清理；保持共享配置保护。
- 用可控屏障/事件的确定性测试证明 A1/B1 已进入执行而 A2 尚未开始，避免靠随机 sleep 推断并行。覆盖容量 1/2/多项目、准备卡住、反向完成、失败、暂停和重复唤醒。
- 退出：AC-PC-01–06、11 的工程部分通过；先完成后台行为，再做 UI。

### Phase 3：重启与控制台贯通

- 启动统一协调多任务恢复，再开始新认领；验证 prepared/resolved、运行中中断、等待归档、报告已写但回执丢失等既有恢复路径。
- 审计所有活动任务的服务退出/资源释放；孤儿清理不得对仍存活的另一项目执行。
- API/read model 改为活动任务集合与容量；更新工作台、项目页、等待原因、系统只读配置和缓存处理。
- 若需要 schema 变更，使用备份副本验证迁移和回退，保留历史工件与结果。只调整前后端契约时不凭空添加迁移。
- 退出：AC-PC-07/08/11 通过；相关 owner 的集成测试证明前后台一致。

### Phase 4：完整本地与零模型联合检查

- 沿用 Docker `quality`/`runtime`，运行格式、lint、类型、构建、相关与全量测试、浏览器 E2E、`npm run test:acceptance:local`，依赖失败保留记录。
- 对两个独立应用/数据域执行真实 MCP、容器、截图/哈希/OSS 替身及清理集成；验证一个 Run 退出后另一个仍可操作，并实测重启回收。测试替身不能作为真实模型/live 证据。
- 复用 `tests/multi-project-queue*.test.ts`、`multi-project-dispatcher.test.ts`、`multi-project-background-scheduler.test.ts`、配置/Secret、workspace/routes、Docker recovery、OSS 和 E2E 相关 owner；新增测试只覆盖并发风险和契约变化。
- 运行完整 runtime 原生浏览器预检，测量两个浏览器及容器同时工作的内存/CPU；不改为依赖宿主机 Chromium。
- 退出：AC-PC-01–12 的适用确定性证据齐备。历史跳过项仍明确标记，不用 local 代替 live。

### Phase 5：本轮真实并行验收

- 使用第 3 节资源清单准备新的隔离候选实例、两套非生产应用与独立数据卷；不恢复旧实例后直接覆盖其证据。只读历史卷可作核对来源。
- 正式调用前固定候选 commit/image digest、角色资源版本、检查器版本、两个 project/repository、目标提交、应用版本、模型设置、证据目的地及本轮预算；实际 queue/Run ID 生成后追加绑定。清单放本地忽略证明目录，复用已有格式的必要字段，不实现 #103 通用证据复用。
- 有限案例：A1/B1 两条正常四 Session Run 同时执行，A2 排在 A1 后；另做一轮 A 的受控局部依赖故障与 B 的正常 Run。第三项目轮转和崩溃组合主要在确定性/零模型路径验证，不无限扩展付费矩阵。
- 证明重叠要使用本候选实际 Session/工具执行时间区间和归属记录；两个排队请求或仅 startedAt 接近不能证明并行。
- 分别核对固定 target/digest、场景结果、截图原件与哈希、正式 Git 报告、必要 Issue/PR、独立清理余量和凭据保护；故障不会串到另一项目，失败样本原样保留。
- 记录同时运行期间 CPU、峰值内存、容器/浏览器存活、Provider 限流或错误及总耗时；只报告实测容量，不声称并发必然使耗时减半。
- 本轮已获明确独立授权，不设调用次数上限；仍执行上述有限案例矩阵，保留失败和重试成本事实，不因无限次数授权扩展无关验收。
- 退出：AC-PC-13 通过或明确列出 blocked/failed。历史三项目交替事实只能作参考，不重标为本候选并行事实。

### Phase 6：文档与交付

- 回填本 Plan 每项完成证明、失败与未运行状态，按实际进度更新 AGENTS 入口、PROJECT 与部署操作说明。
- 对照 AC 核查 PR 最终提交和 CI；负责人未授权发布时止于开发交付，不创建 release PR/tag/Release 或部署现有长期实例。
- 如后续授权发布，沿用现有 local/live/release 分层，明确本候选生产调度已变化，不能套用 v0.7.1“仅检查器变化”的历史证据复核捷径。

## 3. 资源盘点与准备清单

### 3.1 2026-10-02 只读盘点事实

只检查文件位置、环境变量键及是否有赋值、JSON 白名单结构和 Docker 名称/状态；未输出 Secret 值，未解密数据库、登录远端服务器、调用模型或修改应用数据。下列本地位置均为运行资源，不进入 Git；不是新 Secret 事实源。

| 资源 | 已找到的位置或事实 | 可复用判断与仍需验证 |
| --- | --- | --- |
| 基本部署、GitHub、模型、OSS 配置入口 | 根 `.env` 含管理员/主密钥、GitHub Token、DeepSeek endpoint/文本及视觉模型/Key、OSS endpoint/bucket/访问凭据等已赋值键 | 仅证明有赋值；不证明非占位、解密匹配、有效权限或当前连通。禁止整文件输出或写入文档；候选需经受控配置/Secret Store 装载 |
| 多项目候选部署环境 | `.cynos/multi-project-live/harness.env`，含管理员、主密钥和 Docker 连接配置键 | 不能把旧主密钥配给不匹配数据库；复制备份后受控验证，不覆盖原件 |
| 清理及合成测试账号 | `.cynos/multi-project-live/final-fixture.env`、`fixture-storage.env` 含清理 Token 键；`python-fixture.env` 另有测试账号/密码键；`final-context.json` 有历史账号/清理字段 | 不复制字段值；当前账号是否仍存在、清理端点范围和 Token 是否一致均待验证 |
| 既有多项目验收目标和记录 | `.cynos/multi-project-live/acceptance-manifest.json` 列出 `cynos-ai/luowang-closure7-fixture`、`cynos-ai/cynos-website`、`cynos-ai/luowang-mp-python-fixture` 共 5 条历史 Run | 只作历史参考；旧 closure7-fixture 受 AGENTS 限制仅供历史读取，不删除资产、不拿它替代本轮固定发布靶场 |
| 两种工具链的本地源码 | `.cynos/multi-project-live/sources/` 下有上述三个目标的目录 | 目录存在不证明提交新鲜；后续按已授权目标固定 commit，镜像可重建，不能仅按旧标签复用 |
| 历史备份 | `.cynos/multi-project-live/backups/candidate-20260926/`、`published-v061-20260926/`；`.cynos/v062-release-archive/` 有 Harness 与 fixture 数据归档 | 恢复时校验完整性和配套密钥，使用隔离副本；历史备份不作为新测试写入位置 |
| Docker 当前实例 | 本机 Docker 可返回容器/卷清单；`docker ps -a --filter name=luowang` 无匹配容器 | 当前未发现可直接继续使用的罗网容器；存在其他正在运行的项目，禁止重启或 prune 共享资源 |
| 本机开发依赖 | Node 可用，版本为 v24.19.0；`node_modules` 存在，但本轮格式化命令发现 `prettier` 包缺失 | 不能仅凭 node_modules 目录宣布可跑质量门禁；开发时使用固定 quality 镜像准备完整依赖，本轮未安装或升级依赖 |
| Docker 历史数据卷 | `luowang-mp-live-data-4d420840`、`luowang-mp-site-data-4d420840`、`luowang-v061-closure-data-20260926`、`luowang-v061-closure-data-20260926-r2` | 只确认卷名存在，未挂载核验内容；保留原卷，按所有权选择副本，不把存在等同于可恢复 |
| 服务器验收资料 | `.cynos/server-acceptance/` 中有 context、部署/恢复/传输脚本及 known_hosts | 未读取服务器凭据、未连接服务器；首轮本机隔离验收可不依赖远程服务器 |
| 固定发布靶场 | AGENTS 指定 `cynos-ai/luowang-v070-release-fixture` | 本轮未确认对应当前应用容器/候选数据位置和远端提交；后续继续遵守该目标约束，不凭旧 manifest 切换 |

`.env` 和 `.cynos/` 已通过 `git check-ignore` 核对被忽略。上述材料足以避免先向负责人重复索要 Key，但不能提前宣布资源已就绪。旧临时代理/部署脚本仅是历史材料，使用前审查作用范围，不能直接执行以“恢复环境”。

### 3.2 开发授权后可准备、仍需证明的资源

1. **候选实例与容量**：一套新的罗网 runtime 和独立数据卷、可用 Docker Engine、至少容纳两个并行浏览器/Run 容器的实测余量。现有机器上有其他服务，预检可用容量后选本机或服务器，不预设最低硬件数字。
2. **两个外部目标**：已随完整 Plan 授权确认 `luowang-v070-release-fixture` 与 `luowang-mp-python-fixture`。新隔离应用分别固定 main `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`、`47328c32606c7446101f8e1cbf09c17f7c6f817b`；正式 Run 的 target 以队列冻结的场景分支提交单独记录，不混同应用源码提交。
3. **应用、账号与清理**：两套可独立启动的非生产应用、独立数据域/测试账号、按 Run 清理及独立查询能力。优先从已有源码、env 和备份核对，不从历史账号值推断当前可登录。
4. **外部凭据与模型**：验证现有 GitHub 凭据对两个确定仓库的最小权限、OSS 专用对象范围、Main/Runner 文本模型及 Reviewer 视觉能力；保持三组配置。已有 `.env` 中变量名不等于当前 Session 实际生效配置。
5. **验收输入与授权**：本轮明确授权开发及整个 Plan 的真实模型调用，次数不设上限，外部金额限制由负责人管理。保留正常与局部故障的有限矩阵；没有发布授权。

不要求负责人现在重新提供 Secret。能够在本地受控验证的材料先验证；确实缺失时只询问具体资源或授权，Secret 仍通过原受控入口补齐。

## 4. 风险与控制

| 风险 | 控制与完成证明 |
| --- | --- |
| 只改 Dispatcher，Queue 仍串行或可绕过上限 | 两层认领统一约束；竞争测试验证数据库事实与活动集合一致 |
| 任务完成时漏唤醒或提前释放 | 可控完成顺序、准备/清理阻塞与重复 drain 测试；不依赖随机延迟 |
| 长 Run 占住后台 tick | 验证 A/B 未完成期间仍可轮询、入队和更新索引/归档状态 |
| 并发暴露全局可变状态或错误清理 | 同名场景/证据、不同账号、交叉结束和双任务重启；真实 MCP/容器路径核验 |
| 共享测试账号/数据库互相影响 | live 两套独立应用与数据域，不将 Harness 隔离误称业务环境隔离 |
| 内存不足、Provider 限流 | 初始并发 2、可显式 1；预检和记录实测负载，不偷偷换模型或追加预算 |
| 旧资源或旧事实被当作当前就绪 | 新候选、新证明目录、明确绑定新 Run；历史原件不覆盖 |

## 5. 本轮完成记录

- Phase 0 已完成：负责人明确授权，基线与功能分支已固定；根 `.env` 和历史资源只经受控程序读取，未向对话/Git 输出凭据。
- Phase 1–3 已实现：并发配置与事务认领、项目内互斥、活动任务集合、异步后台调度、恢复与退出、工作台/项目页/系统状态；没有新增 schema 或修改历史工件。另补共享 clone 操作级互斥，避免后台索引与准备/归档竞争。
- 定向验证已通过：A1/B1 重叠及 A2 等待、B 先结束与二次唤醒、慢准备占槽、容量 1/2/三项目轮转、暂停/待归档、双 Run 重启、准备中无 Run 展示和部分项目读取失败、原生 MCP 双浏览器与同名截图隔离、关闭 A 后 B 继续运行。
- #94：真实挂起 HTTP Git remote 经 `GitRepository` 超时、生产 readiness API 与持久状态保持失败且脱敏；浏览器回归检查失败信息展示。没有实现代理设置或自动重试。
- #118/#119：四种目录状态在 768/1440px 验证独立布局行；取消 Playwright 默认隐藏滚动条，断言滚动条实际占宽后验证 768/1024/1440px 页面无整体溢出，保留局部滚动与键盘访问。
- Phase 4 已完成：固定候选完整 local=passed；483 passed、2 skipped，格式、lint、类型、构建、整套 E2E 与逐 AC 工程证明通过。runtime 原生双浏览器、截图及 A 关闭后 B 继续操作通过。首次 local 的格式/临时 dist 权限失败，以及 root 测试权限失真和遗留 `/tmp` socket 权限失败均原样保留。没有使用宿主 Chromium。
- Phase 5 已完成：同一候选完成 7 条真实 Run / 28 个角色 Session。项目并发与证据完整性验收通过；目标场景结论是 3 passed、4 blocked，含预定的局部故障，不称“所有场景通过”。详见下文。
- Phase 6：规格入口、PROJECT、部署操作说明和逐项证明已回填；[PR #120](https://github.com/cynos-ai/luowang/pull/120) 面向 develop。实现候选 [CI quality](https://github.com/cynos-ai/luowang/actions/runs/37018470240) 已通过。最终实际界面复核另修复最近完成列表长 Run 编号挤占状态/时间的问题，仅调整 CSS 列宽；构建及完整 workflows E2E 通过，并将最终样式注入实际候选页面验证 768px 三列无重叠（`ui-final-wrap-2.log`、`ui-runtime-wrap.log`）。真实模型验收仍绑定下述不可变镜像，未把样式补充冒充重新执行模型验收。没有创建 release PR、tag 或 Release，也未部署现有长期实例。
- 本地原始证明位于 `.cynos/project-concurrency/` 及各次 `.cynos/acceptance/2026-10-02*/`；该目录被忽略，敏感原件不提交。初次只读盘点及缺少宿主 Prettier 的事实保留在 Git 历史；后续检查统一使用 quality 容器依赖。

### 5.1 不可变候选和环境

- 实现 commit：`989c8de6587495a4e88d4b28f7fa0fdaad027a74`；runtime manifest digest：`sha256:03d6cdae96f4bf2f53c7bccc8e759853571bcc737d7cbb24c07939c48b2c9677`。quality/runtime 均由本仓库 Dockerfile 对应 target 构建，最终使用已支持的 Debian mirror build args 指向华为 HTTP 镜像；默认阿里源慢下载和 HTTPS 源缺少初始 CA 的失败记录保留，没有修改产品网络/重试策略。
- 全量 local：`.cynos/project-concurrency/local-frozen/report.json`（UTC 14:15:21–14:18:58），`local=passed`。其中旧模型质量对照仍 not_run，未授权的发布层仍 blocked，不混同本轮 AC-PC live。
- A=`cynos-ai/luowang-v070-release-fixture`，project `46cbc568-cbb9-4dc8-b541-ea89a94c90f8`；B=`cynos-ai/luowang-mp-python-fixture`，project `620b83b0-7ecb-4aa8-b80b-c1df7dcdb5a1`。两套新应用、数据卷、合成账号及 cleanup Token 独立。角色模型沿用已授权 DeepSeek 文本/视觉组合；使用 `deepseek` Provider 注册项。没有新建目标仓库或使用历史 closure7 靶场写入。
- `live-manifest.json` 固定实现、镜像、角色资源哈希、项目和应用版本；`live-audit.json` 逐 Run 保存 target、实际执行镜像 ID、场景结果、报告 commit、Session 模型和执行区间。后续 target 的变化来自该项目已归档报告推进分支，每个 Run 内的 target/image 均固定。

### 5.2 真实 Run 与边界

| 队列 / 用途 | Run | 目标场景结论 | 不可变正式报告 |
| --- | --- | --- | --- |
| A1 / 首轮并行 | `01M3YG2E11VYV5REGDP80R20NG` | blocked：注册场景缺少运行时密码存储证据 | [报告](https://github.com/cynos-ai/luowang-v070-release-fixture/blob/c985f1c7e6d9f3979756e374f2c1be443774f3f5/docs/scenario-testing/reports/01M3YG2E11VYV5REGDP80R20NG/report.md) |
| B1 / 首轮并行 | `01M3YG2E1PC31W3GG4NEX2Z6GA` | passed：4 场景 | [报告](https://github.com/cynos-ai/luowang-mp-python-fixture/blob/20e0681ba85f02beb5396dab5f7458c76905aa40/docs/scenario-testing/reports/01M3YG2E1PC31W3GG4NEX2Z6GA/report.md) |
| A2 / 项目内等待 | `01M3YG2E4SMCNHYMZHVJH76T94` | blocked：同一存储证据缺口 | [报告](https://github.com/cynos-ai/luowang-v070-release-fixture/blob/49c6e889fbb7770abea55cc3b9cb065e8ecee960/docs/scenario-testing/reports/01M3YG2E4SMCNHYMZHVJH76T94/report.md) |
| A3 / 单场景补验 | `01M3YGS2D616QE8M82N1C5SCD4` | blocked：删除账号后的旧 Cookie 服务端失效未被实际重放验证 | [报告](https://github.com/cynos-ai/luowang-v070-release-fixture/blob/18e3a94ccb5352eb1c2405da2a186f90f062756a/docs/scenario-testing/reports/01M3YGS2D616QE8M82N1C5SCD4/report.md) |
| B2 / 同期单场景 | `01M3YGS2GG8RGM2VZ53ZZ7TRRB` | passed | [报告](https://github.com/cynos-ai/luowang-mp-python-fixture/blob/df309eb9fab78047494c0f50d5fb9c76f8ec716d/docs/scenario-testing/reports/01M3YGS2GG8RGM2VZ53ZZ7TRRB/report.md) |
| A4 / 应用停机故障 | `01M3YH55TN80SR7NYAB9BDNY34` | blocked：受控应用不可用 | [报告](https://github.com/cynos-ai/luowang-v070-release-fixture/blob/909d467f1ad5cecf7b42e97788e461fa99f086d6/docs/scenario-testing/reports/01M3YH55TN80SR7NYAB9BDNY34/report.md) |
| B3 / 故障隔离对照 | `01M3YH55YED95SZFQ7K5ZM3B50` | passed | [报告](https://github.com/cynos-ai/luowang-mp-python-fixture/blob/924f1d1f7bdd9ff72b152e779684427fc0138e9f/docs/scenario-testing/reports/01M3YH55YED95SZFQ7K5ZM3B50/report.md) |

首轮 A1 真实工具区间 UTC 14:26:10.276–14:27:50.369，B1 为 14:26:22.575–14:27:07.228，重叠 **44.653 秒**；依据已绑定 Run/target 且与证据哈希一致的 operation 记录，不是 startedAt 推断。A2 在 A1 queue completed 的 14:30:30.473 才认领。A3/B2 的 Run 生命周期重叠，但工具区间不重叠，不拿它们冒充第二份工具并行证明。

7 条 Run 均走完四个角色 Session，全部最终 archive=completed。32 张真实 PNG 从私有 OSS 经认证路由读取并校验哈希；278 条实际工具操作的本地文件与归档证据哈希一致；跨项目 Run、报告、证据读取均返回 404。正式报告的远端 Git 内容与索引一致。恢复应用后对每个 Run 独立查询，清理余量全部为 0，共 13 条 absent=true 回执；故障 Run 未产生登记数据，不伪造清理回执。两条早期 Node Run 的 Git 归档曾 partial，既有重试后均完成；没有声称已解决其底层网络原因。

A1 使用并删除了独立预置合成账号；后续请求明确要求 Run 专用账号，收尾重新建立预置账号。A1/A2 的存储观察资源缺口、A3 的模型执行取证缺口均保留，不修改场景期望或报告把 blocked 改成 passed，不扩展本阶段为 #95 模型质量工程。一次本地审核脚本错误要求所有正常场景 passed，已纠正为核验本 Spec 的并发与证据规则，原失败日志仍保留。

84 次约 10–13 秒间隔采样中，有 30 次双项目占槽，最多观察到 2 个 Run 容器同时存活。相关容器合计采样内存峰值 **1361.56 MiB**，候选服务峰值 **1242.11 MiB**，合计 CPU 峰值 **137.75%**（Docker CPU 百分比，可超过单核 100%）。这是本机该矩阵的采样值，不是持续测量极值或并发 8 容量承诺。7 条 Run 的 SDK 汇总约 1881.81 万 token（含大量 cache read），目录估价约 USD 0.2709，不是 Provider 账单；连接预检不计入该 Run 汇总。

### 5.3 AC 关闭记录

| AC | 状态及证明 |
| --- | --- |
| 01–02 | passed：coordinator/queue/dispatcher 屏障测试覆盖容量 1/2、第三项目、暂停、重复唤醒及准备占槽；live A1/B1/A2 证明并行与顺序 |
| 03–04 | passed：慢准备、失败、waiting_archive 和反向完成测试；后台 tick 不等待 Run/归档重试；live B 先结束未抹掉 A，A2 后续正确开跑 |
| 05 | passed：scoped Secrets、命令容器与证据测试、原生双 MCP 同名截图隔离；live 32 张截图、项目对象路径、跨域 404 和 7 条独立清理查询 |
| 06 | passed：`multi-project-configuration-guards.test.ts` 追加双 running 和 A 退出后 B 仍保护全局/自身的验证；live target/image 绑定不变。live no-op 写入可成功，不能当作保护失败；后续 live guard 脚本错过执行窗口，未记为通过 |
| 07 | passed：双中断 Run 与既有 prepared/resolved/归档恢复测试；实际双项目 Docker 孤儿回收及幂等重复回收，未影响 live 实例；live 全部完成后重启，7 条 Run/queue/target/report 绑定逐项一致。没有声称强杀了真实付费执行中的两个 Run |
| 08 | passed：准备无 Run、多个活动任务、部分项目读失败的服务测试与双任务浏览器展示；live workspace=2/2，排空/重启后=0/2 |
| 09–10 | passed：真实滚动条及目录四状态/键盘 E2E；stalled Git remote → readiness API → 持久状态及页面超时提示 |
| 11 | passed：配置边界、旧 schema 兼容测试；只读挂载历史卷并复制后校验，1 项目/9 Runs/29 报告全表指纹相同，隔离副本回退一致，原卷字节未变；无需 schema 迁移 |
| 12 | passed：固定候选 Docker quality/runtime、完整 local 与 runtime 双浏览器截图预检；失败日志和 2 项跳过保留 |
| 13 | passed（并发行为与证据完整性）：本候选 7 条真实 Run，首轮工具区间重叠、同项目顺序、A 停机/B passed、归档/截图/清理和容量采样齐全；目标场景的 4 blocked 不改判 |

原始证明：`live-audit.json`、`metrics-summary.json`、`runtime-browser-preflight-2.log`、`docker-recovery-pair.log`、`history-proof-3.log`、`restart-before.json` / `restart-after.json`、`guards-final-2.log`。候选和两个应用保留在本机隔离网络/数据卷，应用恢复且最新就绪检查均通过；自动触发关闭、队列为空。检查器及证明脚本位于被忽略的本地证明目录，不含提交到 Git 的 Secret。
