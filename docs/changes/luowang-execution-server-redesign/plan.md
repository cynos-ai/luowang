# 项目执行服务器与应用启动 Plan

- 日期：2026-10-05
- 状态：实施中；Phase 0–3 的工程实现与本机确定性验证完成，Phase 4–5 的远程真实资源和联合验收仍受外部资源阻塞。
- [Intent](intent.md) · [建议 Spec](spec.md)
- 评审输入：[原审核稿](../../../execution-server-redesign-review.md)。它保留为输入，不作为实施后的第二份规格。
- 当前代码基线：`feat/model-settings-polish` 的 `b81a8e8`；依赖 [PR #128](https://github.com/cynos-ai/luowang/pull/128)，尚未合入 develop 或发布。本需求在 `feat/execution-server-runtime` 上包含该基线实施。

## 1 评审结论

方向合理：控制端保留调度/模型/证据，所选服务器用自己的 Docker 跑项目；SSH 无常驻 Worker 足以支持首版。三种运行模式和测试/Beta 分离也应保留。原稿可作为需求输入，不能照其阶段顺序直接开工。

首版明确支持 Compose。增加 `compose up` 的调用不难，主要工作是把它纳入已有固定 target、服务器身份、运行隔离、凭据、取消和恢复机制；不能让 Compose 成为绕过原受控执行边界的旁路。

| 原稿需要调整的点 | 根据当前代码的原因 | 推荐处理 |
| --- | --- | --- |
| “统一执行接口”只描述 Docker 命令 | 构建接口依赖本地 cwd/文件；执行接口只能收短文本，且 prepare 中的 build 默认自行创建本地 adapter | 同时抽象文件传输、构建产物、流式输出、取消、通道和资源登记，所有调用从所选服务器注入 |
| 服务器绑定变化仅使检查失效 | 绑定未进入 queue 配置快照，缓存没有 server 维度 | 增加稳定执行身份、修订和缓存键；历史与当前配置分开 |
| 把产品源码和场景 patch 一起用于镜像 | 当前镜像从固定提交构建，patch 只属于 Run 工作副本 | 保留分离；Compose 每个 build context 也遵循同一规则 |
| Runner 容器兼作应用后沿用现有清理 | 当前 commandSession 在 Runner finally 关闭，应用清理却应在最终 Main 后 | 由 Run owner 持有应用/服务栈，先业务清理再关应用 |
| 临时地址只需“开 SSH 隧道” | 控制端通常在容器中，本机/远程 localhost 属于不同命名空间；HTTP 和能力工具多处读静态 baseUrl | 引入 Run 运行环境，明确通道所在命名空间、服务内地址和浏览器 origin |
| 文件注入作为远程之后的可选收尾 | 登录、数据库和 Compose 服务常依赖配置文件；无注入能力不能完成目标项目的真实路径 | 本机链路稳定后先完成安全注入，再接远程；远程之前验证脱敏与残留恢复 |
| 服务器异常“不能占住全部全局容量” | 现有可靠性 Spec 要求资源未确认退出时保留真实占用 | 首版保留硬上限，保证其他服务器使用剩余名额；不把超时当资源退出 |
| 未列 SSH 主机身份信任 | 已有服务器只有主机/认证凭据，没有指纹 | 首次核对固定主机指纹、变化即阻塞，不能默认接受未知主机 |
| 预检只属于设置操作 | 手动 image/prepare 和接入探测可在 Run 外触发 | 同一资源登记和服务器额度覆盖准备阶段及 Run 外准备 |
| 从单容器直接推导 Compose 支持 | 独立服务名、网络、卷、端口和外部资源有不同生命周期 | 单容器/Compose 共用执行 owner，增加受控 Compose 规范化与逐资源恢复 |

## 2 可确认的现状与修改位置

以下引用均为本轮工作树已核对的实现，不把历史发布记录或 Issue 描述当作当前功能。

| 现有 owner | 已有事实 | 本需求需要的增量 |
| --- | --- | --- |
| `projects/connection-resources.ts`、迁移 `0021` | Token/服务器/文件资源及绑定；remoteExecutionEnabled 和 runtimeInjectionEnabled 固定 false | 服务器检查、主机指纹、修订、容量与受控读取；不重建另一份 Secret Store |
| `projects/configuration.ts`、`task-runtime.ts`、`automation/queue.ts` | 配置修订及入队快照；快照字段只有 executionDockerfile/baseUrl 等 | 增加运行模式、Compose 与服务器/文件版本引用，更新严格字段 allowlist 和导入导出 |
| `projects/image-source.ts`、`run-source.ts` | 固定 Git 树、512 MiB 源码归档上限、受控场景 patch；内置镜像只有 Node 基线 | 复用固定树校验；增加受控传输及 Compose 上下文，明确安装/编译阶段 |
| `image-builder.ts`、`image-preparation.ts`、`image-state.ts`、`run-image.ts` | 本地 build、iidfile、标签校验；缓存键为 project/target/dockerfilePath | 各 service 镜像身份、服务器/平台/构建摘要缓存、固定 Run 记录与远端 inspect |
| `execution-container.ts`、`command-session.ts` | Docker create → cp → start(sleep infinity) → exec；容器命令不暴露宿主通用 Shell | 应用启动和 Compose adapter，受控参数、传输、流式有界输出与中止；复用命令解析 |
| `projects/run-services.ts`、`runs/orchestrator.ts` | 每任务装配依赖；Runner 创建并关闭命令 Session；HTTP/环境工具用静态 URL | 全 Run 的环境 owner，顺序协调地址、MCP、证据冻结、业务清理与资源销毁 |
| `readiness.ts`、`readiness-adapters.ts`、`image-admin.ts` | 无 baseUrl 就不就绪；手动镜像准备为独立入口 | 分模式条件、服务器/Compose检查、显式启动探测；新资源版本纳入检查指纹和检查期间变更检测 |
| `automation/project-queue-coordinator.ts`、`project-dispatcher.ts` | SQLite 原子认领、项目轮转、全局上限、同项目串行 | 同事务服务器额度与故障跳过；准备探测同样登记；未知占用读模型 |
| `projects/docker-recovery.ts`、`automation/recovery.ts` | 本机启动前按实例/项目/Run 标签核对资源；若干取消路径循环等关闭成功 | 持久资源意图、按服务器限频恢复、Compose 网络/卷/传输目录/隧道核对 |
| `runs/controlled-http.ts`、`capabilities.ts`、`browser/playwright-mcp.ts` | HTTP 同源；MCP 在控制端独立进程；当前无 Run 专属浏览器 origin 契约 | Run URL 注入和目标范围约束，真实容器网络验证；保留证据工具边界 |
| `ProjectOnboardingPage`、`ProjectSettingsPage`、`ConnectionResourcesSettings`、Run 页面 | 服务器可选但远程未启用；受控文件显示未注入；接入仍要求 URL | 随已完成能力分阶段展示，避免先取消必填/启用远程再补后端 |

代码路径除前端外均相对 `src/server/`；不新增总架构框架、通用发布服务或第二套队列。

## 3 推荐实施顺序

### Phase 0：确定契约和依赖基线（工程完成）

- 从负责人指定的 `feat/model-settings-polish` `b81a8e8` 建 `feat/execution-server-runtime`；保留 PR #128 的全部前置代码，不从旧 develop 重做，也不在 main/develop 直接提交。
- 以本目录 Spec 审阅固定运行模式、Compose 首版支持/拒绝项、硬全局容量取舍、迁移规则及 SSH 信任流程。本轮用户已明确各服务器自己的 Docker 和 Compose 首版支持。
- 做零模型技术验证：原生/Compose 控制端到本机容器的访问路径、SSH 隧道终点、Compose JSON 规范化、build/exec 中止以及 host key 校验。SSH 库选型以这些能力、许可证和现有部署方式为依据，尚不指定/安装依赖。
- 给出字段和迁移差异：服务器修订/指纹/能力快照、项目运行配置、请求固定引用、镜像/Run 镜像身份、资源意图与资源回执。资源台账归属原 SQLite，Secret 仍在现有加密表。
- 退出：契约可测试，网络小样实际可达，取消不被 Promise 超时假冒；仍不开展真实模型 Run。

### Phase 1：执行身份、统一接口与本机回归（工程完成）

- 新增离线迁移；保留历史记录，本机身份与既有镜像对应，新 Run 不读取移动的服务器绑定。
- 将 local build/inspect/create/exec/logs/remove 全部注入同一选定执行端。远端文件路径与控制端文件路径分类型或明确对象字段，不能简单复用 cwd。
- 先登记再执行；接入 queueId/attemptId，覆盖无 Run 的准备窗口；完善服务器容量及部署容量原子认领，保存未知资源时不释放假名额。
- 本阶段只切换底层依赖，旧 external 流程仍完整可用；不要仅实现 run(args) 就宣布抽象完成。
- 验证：复用 `multi-project-image-*`、`execution-container`、`command-session`、`task-runtime`、`queue/coordinator/dispatcher`、配置保护及 migration 测试；新增跨执行端镜像误命中、回执丢失和准备名额竞争。
- 退出：AC-ES-01/06/10 的确定性基础通过，旧行为无回归。

### Phase 2：本机应用环境，单容器与 Compose（工程完成）

- 新增三种模式与受控启动定义。补内置镜像的初始化/编译步骤；Compose 从固定文件生成受控配置，固定服务镜像，规范化名称/端口并拒绝不支持/危险项。
- 实现 Run 级环境 owner；启动、健康和临时地址先成为真实事实，再创建相应 HTTP/环境工具/MCP。规划 Main 只读当前能力与待准备状态，不声称应用已就绪。
- 清理顺序调整为证据冻结 → Reviewer → 最终 Main → 业务清理 → 资源关闭；停止和异常按已有中断语义，不强行补模型 Session。
- 同时更新配置 API、readiness 和最小页面入口，三种模式按需求校验 URL；repository-only 同时解除就绪检查对浏览器的无条件依赖，实际 requiresBrowser 仍严格校验。接入启动探测通过容量控制，与普通就绪状态读取分开。
- 验证：两个 Compose service（应用+隔离数据库或测试依赖）实际服务发现、临时卷、HTTP/MCP访问、命令测试；单容器正常、构建/启动/健康失败及取消；原生和 Docker 控制端网络均验证。
- 退出：AC-ES-02/03/04/05/09 的本机部分通过，应用关停晚于依赖应用的清理。

### Phase 3：受控文件安全注入（工程完成）

- 承接 [#129](https://github.com/cynos-ai/luowang/issues/129)，继续使用既有资源与 Secret Store。增加选择文件到 service 的规则、版本引用、相对路径/链接/冲突校验及总量限制。
- 源码构建完毕后注入临时副本/卷；不上传至镜像 build context。准备、运行、取消和重启均记录文件资源归属。
- 在输出进入日志/模型/证据之前统一脱敏；验证多行 env/JSON/YAML、标量值、跨 chunk、错误路径，不能仅验证整文件替换。
- 验证：合成 Secret canary 扫描构建上下文、image history/layers、容器日志、工具输出、报告/Git/OSS 替身和恢复后工作目录；不使用真实凭据做泄漏测试。
- 退出：AC-ES-08 完整本机证明；有文件配置的 managed/Compose 真实准备路径可执行，失败默认不保存原始输出。

### Phase 4：远程 SSH、SFTP 与访问通道（实现完成，真实远程验收阻塞）

- 承接 [#130](https://github.com/cynos-ai/luowang/issues/130)，实现主机指纹确认、密码/私钥认证、目录根约束、受控传输、固定 Docker/Compose 参数与回环隧道。
- 同一份本机契约在远程执行，包括 build、单容器、Compose、测试命令、文件注入、健康及资源回收；不把模型 Shell 直接发送 SSH。
- 验证服务器检查与准备快照失效：主机/平台/资源版本改变后拒绝旧快照，检查期间配置变化不能被晚到成功覆盖。
- 对上传、build、create、start、exec、清理回执分别注入断线；从资源意图及实际 daemon 查询恢复，不靠“ssh 进程退出”判断远端进程结束。
- 退出：AC-ES-01/04/07/09/11 的远程工程证明，陌生或变化主机指纹会阻塞，其他服务器的剩余容量可用。

### Phase 5：恢复、迁移与完整页面（本机工程完成，联合验收未完成）

- 将取消路径的无界同步等待改为持久化待核对与后台有界恢复，保留真实占用、项目互斥和终态规则；无模型自动续跑。
- 从同一登记核对容器、Compose services、network、volume、源码和临时配置目录；清理仅作用于本任务的已确认资源，保护其他 Run/实例以及外部依赖。
- 旧项目默认 external、已绑定远端待重新验证；历史显示真实旧执行信息或未知，不回填当前绑定。对包含历史 Run/Secret 的隔离副本完成迁移、重试、完整性、回退证明。
- 完成服务器检查/容量、接入模式与 Compose、文件绑定、Run 实际服务/阶段和残留提示；所有操作沿用共享 UI、Message、确认组件和键盘支持。
- 验证两项目/两服务器并行、同项目顺序、手动准备竞争、配置保护、未知占用、late response、重启多阶段及 UI 三视口。
- 退出：AC-ES-10/11/12/13，工程完整质量检查通过。不能将未知资源标为已清理以消除队列阻塞。

### Phase 6：同一候选的真实联合验收（部分完成，远程与真实模型阻塞）

- 先执行 Docker quality/runtime、完整 local 和零模型原生 MCP 验证，再固定候选提交/镜像及资源清单。
- 同一候选验证本机单容器、本机 Compose、远程单容器、远程 Compose；其中 Compose 至少两个服务、私有网络和本 Run 数据卷。证明对应服务器 daemon 实际资源，不仅检查 SSH 返回码。
- 覆盖 external 和 repository-only；故障矩阵含构建失败、应用早退、健康失败、SSH 中断、取消、控制端重启和清理响应丢失。能用确定性或零模型 Docker 证明的基础设施故障，不必逐项消耗模型预算。
- 真实完整 Run 核对固定 target、三组模型/四 Session、浏览器/HTTP、原始证据、审核/正式报告、归档及资源清理；首轮失败保留，不能仅保存最后通过样本。
- 使用仓库已经授权的非生产目标，优先核对既有 fixture 是否覆盖 Compose；若须补外部目标源码或新建/更换目标，在执行前单独确定。不得把 luowang 当被测产品，也不沿用 v0.7.0“首次分支创建”的旧证明。
- 远程服务器具体资源、SSH 指纹、Docker/Compose 版本、模型预算、Secret Store 引用和目标提交在此阶段执行前确定；当前未取得这些材料，不执行真实远程/模型验收，也不将其记为 passed。
- 退出：AC-ES-14 及前述所有 AC 有对应证据；发布仍须逐次指定版本授权，不包含在本计划中。

## 4 实施与验证记录

### 已完成

- 数据与调度：迁移 `0022_execution_runtime` 已增加执行位置修订、服务器容量、主机指纹、能力、受控文件快照、位置隔离镜像缓存、资源台账及 Run 执行上下文；旧项目仍迁移为 external。
- 执行端：本机 Docker 与 SSH2 远程 adapter 共用构建、传输、执行、中止和资源登记契约；SSH 固定主机指纹，支持密码/私钥、SFTP 和回环隧道，不把模型 Shell 直接转发给 SSH。
- managed 单容器与 Compose：固定产品提交构建镜像，场景 patch 只进入 Run 命令副本；保留服务原 ENTRYPOINT、CMD 和工作目录；Runner 进入指定 command service；应用栈由 Run owner 持有到最终收尾。
- 容器化控制端：每个 Run 使用专用网络并通过受控应用容器 IP 访问；原生本机发布到 `127.0.0.1`，远程发布到远端 `127.0.0.1` 并经 SSH 隧道访问。未使用 `0.0.0.0` 扩大宿主机暴露范围，也未依赖 `host.docker.internal` 与网关猜测。
- 受控文件：无选中文件时不访问 service 源码；有文件时只写入明确的 service 源码根，执行路径不进入镜像 build context；已覆盖大小、路径、链接、冲突、版本及跨 chunk 脱敏。
- 运行时收口：命名数据卷保持默认可写、源码挂载强制只读；能力检查使用本 Run 动态地址；Docker 查询失败保留 unknown 和容量占用；应用准备、受控文件注入和健康检查贯穿取消信号；Compose 构建缓存只使用稳定构建输入，可跨不同 Run 复用。
- 浏览器：Run 专属 origin proxy 限制 HTTP、redirect、CONNECT 和 WebSocket，真实 Chromium 已证明外部重定向不会请求目标 origin 之外的地址。
- 页面：接入与项目设置已使用共享 `SelectBox`、`NumberInput`、`HelpLabel`、Message 和确认组件；加入运行模式、单容器/Compose、服务器修订/检查、受控文件 service/revision 和 Run 实际执行信息。

### 本轮证据

- 最终工作树 quality 镜像构建通过，镜像内 Docker Compose 为 `v2.39.2`，Playwright Chromium 预检通过。
- quality 容器完整测试：112 个文件通过、2 个显式 Docker fixture 跳过；537 项通过、4 项跳过。
- 将默认跳过的真实 Docker fixture 单独启用：4 项通过，覆盖原生/容器化控制端的单容器和 Compose、应用+可写数据卷+Runner、DNS、两个源码卷、受控文件注入、指定 service 执行、不同 Run 镜像缓存复用及全量清理。
- 真实 Chromium origin proxy 测试通过；foreign redirect 在 Run origin 返回 403，未请求外部 origin。
- runtime 镜像构建和独立容器启动通过，`/health` 返回数据库与服务正常；项目接入页在 768、1024、1440 CSS 宽度下无横向溢出。项目设置的完整三视口人工检查仍待具有项目数据的候选实例复核。
- 宿主机 `npm test` 因现有 `better-sqlite3` 原生二进制与宿主 Node ABI 不匹配而未运行；同一最终工作树已在仓库固定的 Node 24.14.1 quality 容器完整通过。这是宿主原生依赖问题，不是前端数据库或本需求运行时失败。

### 仍阻塞

- 没有两台真实远程服务器、各自主机指纹和受控凭据，因此远程单容器、远程 Compose、两服务器并行、断线及重启恢复不能记为 passed。
- 没有本轮授权的真实模型预算、完整目标资源和 Secret Store 引用，因此真实四 Session 完整 Run、报告归档及清理不能记为 passed。
- 以上阻塞不影响本机零模型 Docker 合约和现有功能回归验证；发布、合并和 tag 均不属于本轮授权。

## 5 风险和范围控制

1. **默认行为迁移**：只对新项目默认 managed；升级已有项目不改变执行环境或触发远程操作。
2. **Compose 兼容范围**：支持常见多服务结构，但必须先解析和校验。禁止“忽略不支持项继续运行”，也不增加通用部署平台来兼容全部 Compose。
3. **主机失联与全局上限**：持久 unknown 解决恢复可靠性，不消除实际算力占用。首版推荐保守语义，取舍在 Spec 第 8 节明确。
4. **Secret 与构建**：运行期注入不支持需要秘密进入镜像层的构建；如需 BuildKit build secret，另行确定专用契约，不把运行文件顺手加入 build context。
5. **外部依赖清理**：删除 Compose 临时卷不等于已清理外部数据库/第三方 API；继续使用原按 Run 清理契约和告警。
6. **网络与应用形态**：临时入口不天然兼容固定 OAuth 回调或多公开域名；首版不伪造通用兼容能力，可保留 external 模式。
7. **测试证据边界**：本轮设置提交、工程 fixture、零模型 Docker、真实模型联合、人工复核与发布后核验分别记录。

## 6 本轮交付事实

- 已按 Intent/Spec 实现执行位置、容量、恢复、单容器、Compose、受控文件、动态 Run 地址和浏览器 origin 边界，并保留既有 Secret Store、队列及角色职责。
- Phase 0–3 的工程与本机确定性证明完成；Phase 4 的实现完成但真实远程证明受阻；Phase 5 的本机恢复/迁移和页面工程完成，真实双服务器与完整三视口仍未完成；Phase 6 只完成本机零模型 Docker、quality/runtime 构建和 Chromium 边界证明。
- 本文不是远程运行或真实模型联合验收报告，不把本机 fixture、SSH mock、静态检查或质量镜像构建冒充外部资源验证。
- 本轮不修改长期预览实例，不合并 PR、不发布版本、不创建或移动 tag。
