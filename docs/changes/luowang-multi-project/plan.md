# 同一操作者管理多个 Git 项目 Plan

- 目标版本：v0.6.1，依据 [spec](spec.md)。
- 状态：v0.6.0 已发布；v0.6.1 的多项目入口、离线升级、全局调度和项目镜像已实现。两个 Node 目标与异构 Python 目标已完成交替真实 Run，并做了单项目应用停机、其他项目继续完成的隔离对照；Python 全量 Run 的一项 blocked 已由后续定向复测闭合，旧失败/blocked 记录保留。本机候选已完成只读复核、离线备份及临时容器/网络收尾，原始数据卷保留供回退。负责人指定的测试服务器已完成隔离 Compose 部署形态与 Docker 回收验收；该机器未运行完整模型/浏览器负载，也不作为该负载的单独发布门禁，不能据此推断罗网支持的最低服务器配置。正式旧实例迁移条件和最终发布审核仍未完成，详见本计划末尾的验收记录。
- 实施分支：`feat/multi-project`，从 v0.6.0 发布后的 develop 创建；已推送节点以 Git 历史及下方阶段记录为准。

## 阶段 1：项目身份、数据归属与升级

- [x] 盘点全局配置键、唯一约束、状态键、文件路径与进程单例，修改清单见下方阶段证明。
- [x] 在 `db/schema.ts` 和既有迁移机制中建立项目归属及组合唯一约束；保留全局唯一 Run/请求 ID。
- [x] 为唯一管理员保存显示名称；旧实例迁移时设为“管理员”，不引入用户表或按用户分区的项目所有权。
- [x] 改造 configuration、config-transfer 和 Secret Store，分别提供部署及显式项目作用域；AAD 加入 scope/projectId/key。
- [x] 实现离线备份、迁移预检、旧唯一仓库归属、Secret 重加密、事务回滚和幂等标记；启动默认 paused。
- [x] 用合成旧库验证空实例、有完整历史实例、无法归属、错误主密钥、迁移中断/重试；核对数量、结果和内容哈希。

完成证明：AC-MP-01 的身份部分、AC-MP-02/03/10；不在真实持久验收库上首次试迁移。风险是把旧全局 Secret 直接复制为多个项目凭据，或把多仓库历史错误归给一个项目。

阶段 1 盘点证明（develop `d005294`；只完成定位，尚未修改数据或验证迁移）：

| 单项目假设 | 当前 owner / 位置 | v0.6.1 修改方向 |
| --- | --- | --- |
| 配置与凭据 | `configuration.ts` 的 `harness`/`repository` 两个全局键；`config-transfer.ts` 的单仓库 YAML；`secret-store.ts` 按 Secret 名称作为键和 AAD | 拆部署与项目作用域，项目 Secret 的存储键和 AAD 均绑定 projectId；旧密文需解密后重加密，不直接复制 |
| 数据唯一性与进度 | `db/schema.ts` / `db/migrations/0001–0004` 的全局场景 ID/路径、报告路径、索引状态 `id=1`、推进 `id=1`、队列与中断记录 | 场景/路径/错误/进度按项目复合定位；Run/请求 ID 保持全局唯一并显式关联项目；子记录经 Run 校验归属 |
| 索引副作用 | `repository/indexer.ts` 按全表删除与全局场景 ID 去重 | 删除、upsert、错误缓存和状态更新全部限定 projectId，避免 A 的重建清空 B |
| 调度状态与认领 | `automation/poller.ts`、`scheduler.ts` 的全局轮询/cron 键；`queue.ts` 全局队尾合并和 FIFO 认领；`service.ts` 单 activeRunId | 状态键和合并按项目；原子认领仍保持全局单 Run，增加项目轮转与 paused 检查 |
| 目录和对象 | `config.ts` 的单 `repoDir`/`reportDir`；`runs/workspace.ts` 的 `running|completed/<runId>`；`storage/oss.ts` 的共享前缀 | 新写入使用受控 projectId/Run 路径与 OSS 前缀；旧工件保持原路径并在迁移表中绑定唯一项目 |
| 本地测试命令 | `runs/command-runner.ts` 允许多语言命令，但 `Dockerfile` 的 runtime 主要安装 Node、Git 与浏览器，命令在罗网进程内执行 | 项目镜像承载自己的语言/依赖，Runner 的受控命令转交绑定项目和固定提交的执行容器；罗网服务不安装所有项目工具链 |
| 服务及 HTTP 路由 | `app.ts` 创建一组 Repository/Indexer/Orchestrator/Archiver/Operations 实例，业务路由无 projectId | 显式项目上下文贯穿服务和业务 API；不能以页面当前选择决定后台副作用 |
| 管理员资料 | `admin_credentials` 固定 `id=1`，现有改密码会撤销会话 | 仅增显示名称并迁移默认值，保留唯一管理员认证，不建多用户所有权 |

迁移先验证旧数据是否能归属唯一仓库，再在离线副本中建立项目和复合键；不能让旧全局配置或 Secret 在新运行时隐式充当任意项目的默认值。仓库身份、旧目录和报告 URL 的保留规则按 Spec 第 7 节执行。

阶段 1 首个实现切片：新增项目身份表和受验证身份的存储入口，projectId 由服务端生成，仓库 ID 与不区分大小写的 owner/name 均去重，新项目固定从 paused 开始。该迁移暂不注册到自动启动链；空库和旧库的归属、备份与 Secret 重加密尚未完成前，不让现有实例自动进入半套项目模式。专门测试覆盖空项目、旧配置/索引原样保留、迁移重复执行及仓库别名拒绝；这些结果不等于 AC-MP-10 整体验收。

GitHub 身份读取新增独立的只读校验：必须收到正整数稳定仓库 ID 和规范 full_name，创建项目时应将该结果交给存储入口；原有连通性读取保持兼容。仓库 URL 不接受 query/fragment，`.git` 后缀按大小写忽略。这个校验不代替旧历史归属证明：旧 Run 没有逐条记录仓库 ID，仅凭当前配置和索引状态不能断言所有历史都属于同一仓库。

离线升级预检的只读部分已开始：统计待归属数据，并交叉比较当前仓库配置、索引状态、轮询状态与历史 Issue/PR 链接。无项目数据的空库保持空库；仓库信号冲突、已有数据却缺仓库、仍在运行的队列请求，以及含 Run/请求/推进历史但无法逐条证明仓库归属，均报告阻塞，不自动创建“旧项目”。后续仍需补外部稳定 ID 验证、历史归属核对方式、备份、Secret 重加密和完整事务迁移，不能把只读预检当成升级完成。

Secret 作用域的独立实现已开始：部署级只接受 Provider/OSS 凭据，项目级访问器创建时绑定 projectId 且只接受 GitHub/测试账号/清理凭据；存储键与 AES-GCM AAD 均包含 scope、projectId 和 Secret 名。测试证明旧全局键不会回退到新项目，项目间调换密文会解密失败。旧运行路径暂未改用新访问器，只有离线升级完成并在服务调用链绑定项目后才能删除旧接口。

离线备份工具已开始：使用 SQLite 一致快照，复制仓库与报告工作目录，记录数据库及目录树摘要和完整性结果；目标必须是新目录且不能位于源工作目录中。未完成备份保留显式标记，校验器拒绝缺失或摘要变化的内容。合成实例验证了备份原样保留、二次写入拒绝和篡改检测。此工具尚未用于真实数据；停止服务、保留主密钥和完成历史归属确认仍是实际升级前提。

单管理员资料的数据库切片已加入待执行的离线迁移：旧管理员行增加默认“管理员”显示名称，密码哈希保持原样；独立资料存储只允许读取和修改显示名称。迁移尚未注册到自动启动链，账号 API 与页面也未接入，因此上方阶段 1 的完成框保持未勾选。

索引归属的待执行离线迁移已实现：旧索引状态、场景、报告和错误按明确指定的旧项目搬入带 projectId 的表；场景 ID/路径及报告路径改为项目内唯一，Run ID 仍全局唯一。迁移事务保存所有原文并写入归属标记，重复执行必须匹配原项目；合成双项目证明相同场景 ID/路径和相同报告路径可共存，失败时旧表不变。该迁移未进入自动启动链，Indexer 和 API 尚未切换，不能把此项视作阶段 1 完成。

Run 归属的待执行离线迁移已实现：旧 Run、队列请求、中断记录和推进位置归属指定项目，Run/请求 ID 保持全局唯一；子工件与 Issue 仍经 Run 继承归属。SQLite 对旧大表新增可空列后使用触发器强制后续写入有效 projectId、禁止改投另一项目；合成旧库验证了原记录和子工件保留、外键完整、重试幂等及无项目写入被拒。最终切换仍须把索引与 Run 迁移包在同一外层事务，完成 Secret/配置迁移和运行服务改造后再启用。

配置归属的待执行离线迁移已实现：旧仓库设置去掉重复的仓库 URL 后进入项目配置，语言复制到项目，自动化状态和 GitHub／测试环境检查移至项目表；Provider、浏览器和 OSS 检查仍属部署。迁移前核对旧仓库地址与已验证项目身份，拒绝未知配置字段和无效类型；合成旧库验证了重复执行和错误配置不产生半迁移。此迁移同样未注册到自动启动链，部署与项目配置服务尚未切换。

旧 Secret 的待执行离线迁移已实现：先用旧 AAD 解密全部已知密文，再在同一事务中按部署或指定项目的新 AAD 重新加密、删除旧键并记录归属。未知键、错误主密钥和目标项目缺失都会阻止迁移；合成旧库核对明文不变、旧密文清除、重试幂等及错密钥时原表不变。它尚未与其余迁移包成一次离线切换，也未用于真实实例。

跨迁移事务演练已在合成旧库验证：把项目身份、索引、Run、配置和 Secret 五段放入同一个外层 SQLite 事务，最后一段用错误主密钥失败时，前四段的表结构和数据一并回滚；改用正确主密钥后同一路径通过。此测试证明事务组合可行，不等于已有可执行的离线升级入口；备份核验、历史归属复核、空库路径和升级后的服务切换仍待实现。

已增加针对**唯一已配置旧仓库**的待接入离线升级入口：验证备份清单及源库逻辑摘要一致，要求外部取得的 GitHub 稳定身份与旧配置一致；若存在旧 Run、请求或推进历史，必须提供与当前库完全一致的人工核对摘要，其他预检阻塞不能绕过。五段迁移在同一事务内执行，外键检查与升级标记同事务提交。合成文件库验证了错主密钥全量回滚、备份后源库变化拒绝、历史摘要缺失拒绝以及成功重试。该入口尚未由 CLI 或正常服务调用；人工核对摘要只是锁定被审核的数据快照，不代替实际核对归属；旧历史审查操作流程仍未完成。

空实例的独立离线升级入口已补齐：同样要求备份与当前库摘要一致，仅在只读预检确认为无项目数据时创建新表和约束，不创建项目；如果仍有旧索引、Run、自动化状态、项目检查或项目 Secret，就拒绝把它当作空库。合成文件库验证了零项目、重复执行和外键完整。两个升级入口都尚未进入正式 CLI／服务启动，实际旧历史核对流程和回滚演练仍待完成。

项目配置存储的独立切片已实现：按显式 projectId 读写，每个项目从已验证仓库身份生成固定 URL，配置 JSON 不再保存可改写的仓库地址；现有仓库字段校验由旧配置和新项目配置共用。保存时只增加该项目的配置修订，拒绝请求中的仓库身份字段。合成双项目和原有配置回归通过。配置冲突、就绪检查、HTTP 路由及服务调用链尚未接入。

项目绑定的 Repository Indexer 已开始：创建时核对项目与仓库名称，运行同步前再次核对；场景、报告、错误和同步状态均按 projectId 查询，快照删除与 upsert 仅作用于当前项目。Run ID 仍全局唯一，报告索引发现同一 Run ID 已归其他项目时拒绝覆盖。合成双项目验证同名场景 ID/路径并存、A 清空快照不影响 B；既有单项目索引回归通过。项目 Repository Service 和网站调用链仍未切换，不能据此声明 AC-MP-02 完成。

项目绑定的 Repository Service 已加入创建入口：仓库 URL 只从不可变的项目身份生成，配置读取固定 projectId，Git Token 由工厂绑定相同项目的 Secret scope，本地 clone 使用受控根目录下的 `projects/<projectId>/repo`；仓库状态读取也限制为该项目的索引状态和错误。合成双项目验证固定地址与不同 clone 路径，既有 Repository 回归通过。实际 GitHub 稳定 ID 在改名/重定向后的重新核验、后台调用链及真实双仓库操作尚待完成。

项目绑定的 Run Store 已加入独立创建入口：导入时写入 projectId，历史和待归档列表按项目筛选，跨项目 Run ID 导入或状态修改拒绝，推进位置按项目主键维护。合成双项目验证 A/B 历史互不可见、A 归档推进不影响 B；原有 Run 回归通过。Run 工作目录、队列、归档服务和 API 仍须与该归属贯通。

自动化状态存储也已按项目绑定：轮询和调度可使用相同状态键而不互相覆盖或删除；合成双项目及原有调度测试通过。项目级状态访问器仍待接入 poller/scheduler，队列合并和认领尚未改造。

队列上下文迁移与项目绑定访问器已开始：旧 queued 请求从明确归属的项目回填稳定 GitHub 仓库 ID、配置修订和非 Secret 项目配置快照；新请求同事务读取项目状态与配置，暂停时拒绝入队；自动请求只在本项目、相同配置修订和请求语义下合并。项目认领在同一 SQLite 事务内检查 active、全局已有 running 和本项目 waiting_archive，跨项目 ID 读取／修改拒绝。合成双项目、旧 queued 迁移及原有调度回归通过。公用部署配置快照和完整恢复调用链仍未实现。

全局队列轮转选择器已加入：在一个 SQLite 事务中读取 active 且可执行的项目、按持久最近项目游标选下一个，并复用项目队列的全局单 running 与 waiting_archive 检查。合成双项目验证选择器重建后仍轮转、A 等待归档时 B 可以运行、两项目都有请求时交替认领。它尚未替换现有 Automation Service 的单项目消费循环；恢复及部署配置快照仍待贯通。

项目配置写入现已检查同项目的 queued/running/waiting_archive 请求：生成语言、场景分支/模式/标签、环境与数据库说明等语义字段发生变化时拒绝保存并给出待处理数量；轮询频率等调度字段可修改，修订号增加后新自动请求不会与旧修订请求合并。合成队列与配置测试通过。测试账号、清理凭据和部署配置的冲突规则仍待接入。

项目绑定的 Run 工作目录入口已加入：新 Run 写入受控 `reportRoot/projects/<projectId>/running|completed/<runId>`，创建时核对项目存在且目录未越界；已有 Run 的完成目录继续按原存储记录读取，不批量迁移。合成双项目验证同名工件与证据文件互不覆盖、单项目删除不影响另一项目，旧完成目录仍可读；服务调用链尚未切换到此入口，浏览器状态和 OSS 前缀仍待隔离。

项目绑定的 OSS 入口已加入：使用部署级凭据，在部署前缀下为新证据生成 `projects/<projectId>/runs/<runId>/...`；项目入口的 URL 生成、读取和删除拒绝其他项目及旧格式的对象键。合成双项目验证同一 Run ID/文件名生成不同对象键、跨项目访问被拒，旧 OSS 入口的回归测试通过。历史证据仍保留原键和 URL，后续网关必须先核对迁移后的 Run 所有者，再选择历史读取路径；当前运行服务尚未调用新入口。

项目执行镜像配置的首个切片已加入：项目配置可保存受控的仓库相对 Dockerfile 路径，空路径表示罗网内置基础镜像；旧配置读取时默认空路径。越界与非法路径被拒，有待处理请求时不可修改该字段，入队快照随项目配置保存。当前只建立配置契约，尚未构建镜像、核验 Dockerfile 是否存在或转移命令执行。

固定提交的镜像源码准备入口已加入：要求完整 SHA 和受控项目 ID，在 Git tree 中确认 Dockerfile 为普通文本文件，拒绝 submodule、越界路径与指向上下文外的符号链接；从该提交导出到项目独立的临时构建目录，并逐项核对导出文件。合成双项目验证同一仓库当前 checkout 变化后仍拿到各自指定提交内容，错误路径和链接被拒；Repository 回归通过。该入口尚未调用 Docker 构建，也未解决运行时场景 patch 如何覆盖镜像内源码，不能作为执行镜像整体可用证明。

Docker 构建入口已开始：只接受固定提交的受控构建目录，从仓库内指定 Dockerfile 构建并写项目/提交标签，读取 Docker 返回的不可变本地镜像 ID；CLI 进程不继承罗网 Secret 环境变量。合成执行器验证命令参数、镜像 ID 格式与错误拒绝；本机 Docker smoke 构建一次最小项目镜像，`image inspect` 返回相同 ID，测试镜像已清理。该入口尚未连到调度、镜像状态持久化或正式部署的 Docker Engine，也尚未证明两种工具链的真实构建和 Run 命令可用。

项目命令容器的独立入口已加入：启动前核验不可变镜像 ID 上的项目和固定提交标签，为 Run 创建专属容器；命令复用现有白名单及参数校验，且核对 Run ID、提交和工作目录，完成后删除容器。单元测试覆盖跨项目镜像、错误上下文、禁止内联代码和启动失败清理；本机 Docker smoke 已用真实 Node 镜像执行 `node --version` 并确认容器删除。此时镜像中的源码仍未接入本 Run 的场景 patch，容器入口也未接入 Orchestrator、镜像状态和重启恢复；因此尚不能把它当作正式 Run 的执行环境证明。

Run 源码快照的独立入口已加入：从固定提交导出经核验的源码树，在项目独立临时目录应用本 Run 的场景 patch，校验所有结果场景及稳定 ID，并记录 patch SHA-256；失败时删除临时目录。合成测试证明当前 checkout 的未提交代码不会混入快照，patch 结果准确且不修改原仓库。尚未把快照交付容器，亦未接到 Orchestrator；这个切片只解决可核验的 Run 源码准备。

执行容器现要求绑定同项目、同 Run、同固定提交的受控源码快照，只挂载 `projects/<projectId>/run-sources/source-*/context` 到 `/workspace/source`，在该目录执行命令，并把 patch 摘要写入容器标签；不接受任意本机目录。真实 Docker 联合 smoke 从 Git 固定提交构建镜像，应用场景 patch 后在容器内读取到变更后的场景，测试资源已清理。此节点证明快照交付可行，但项目配置/镜像状态、Orchestrator 正式调用链及重启回收仍未接入；不能把独立 smoke 当作正式 Run 完成。

镜像状态的待切换数据层已加入：按项目、固定提交和 Dockerfile 路径保存 preparing/ready/failed、不可变本地镜像 ID 与脱敏失败代码；准备状态只允许由一次准备流程完成或失败，重启时可将悬留准备标为中断。新表纳入空库和唯一旧项目的离线切换事务；合成双项目及旧库回归通过。尚未接入实际镜像准备服务、Docker 可用性复核与队列消费，不能把 ready 记录直接当作镜像可执行证明。

镜像准备服务现将固定提交源码、项目 Dockerfile 或带版本的内置 Node 基础定义、Docker 构建与状态表串起来：仅在不可变镜像 ID 的项目/提交/构建定义标签都匹配时复用；镜像丢失或标签不符则重建，Docker Engine 不可用单独报错。内置基础定义当前只承诺 Node 基线，其他语言由项目 Dockerfile 提供；真实 Docker smoke 已构建内置镜像并核验标签，另用项目镜像读到 Run 的场景 patch。队列、就绪页、重启恢复和正式 Orchestrator 调用链仍未接入。

Runner 的正式命令入口现支持按 Run 创建并关闭受控命令 Session；项目工厂串联镜像准备、固定提交加场景 patch 的源码快照和容器启动，结束时先删容器再清理快照。项目 Session 准备失败会停止 Runner，不回退到本地执行；Orchestrator 回归测试验证注入 Session 的命令结果进入 execution 及失败无回退。现有 App 尚未创建项目绑定的 Orchestrator，也没有把队列任务快照和 image ID 记录到 Run，故这仍是可注入调用链而非网站多项目可用。

项目运行时只读访问器现已加入：从部署配置读取共用模型、浏览器及 OSS 设置，从明确 projectId 读取语言和仓库/环境配置，并将 repo/report 路径固定在该项目目录；Secret 按固定键分派到部署或本项目作用域，不回退旧全局键，也不允许运行时写入。中断 Run 访问器按项目筛选历史，跨项目同 ID 的写入、删除不会越界。双项目合成测试及 quality 容器静态检查通过。访问器尚未接入 App、Orchestrator 和队列，因此正常服务仍不是多项目运行模式；配置快照与凭据轮换规则仍待贯通。

队列任务快照现有可读取的运行时入口：仅接受已认领任务，核对固定 GitHub 仓库 ID、项目存在及配置修订；拒绝夹带仓库 URL 或未知字段的快照。项目语义配置和当时生效的部署模型/浏览器/OSS 设置在创建入口时固定，仓库地址由不可变项目身份生成，执行 Dockerfile 随任务快照返回，工作路径固定在项目目录。合成双项目验证任务创建后的部署配置变动、项目调度字段变动以及任务结束后的环境变动都不会改写该任务读取结果；quality 容器测试、类型、lint 与格式检查通过。这个入口仍未接入正式调度与 Orchestrator；Secret 使用同 scope 最新值的轮换规则、全局部署配置写入冲突和镜像 ID 的 Run 记录仍待实现。

项目 Run 服务的组装入口现已把已认领任务的固定配置、项目仓库/索引、Run Store/中断恢复、项目工作目录、OSS 前缀及受控容器命令 Session 传入 Orchestrator。清理地址改为项目配置和队列快照语义字段：运行时清理适配器只读取该项目的清理 Token；活动请求期间不能改清理地址，旧全局部署清理地址不会被项目 Run 隐式使用。合成双项目验证仓库、工作目录、证据键和恢复历史隔离；完整 quality 容器测试 393 通过、2 跳过，类型、lint 与格式检查通过。网站 App 和自动化队列仍用旧单项目调用链；此组装入口尚未证明正式多项目 Run、镜像 ID 记账或真实 HTTP 清理。旧实例的项目清理地址需在启用新项目 Run 前明确配置，不能从旧部署环境变量推断归属。

项目 Run 组装入口现也绑定 Archiver：归档只扫描该项目完成目录，并复用同项目仓库、索引和 Run Store。新增 Run 镜像记录表进入离线升级事务；仅在容器成功启动后，记录与该项目、固定提交和 Dockerfile 的 ready 镜像完全一致的不可变 image ID。同一 Run 的记录不可改写，跨项目读取为空、跨项目重用 Run ID 被拒；记账失败时关闭容器并清理源码快照。合成双项目及错误路径测试通过；完整 quality 容器回归 395 通过、2 跳过，类型、lint、格式检查通过。全局调度器和网站仍未使用这套项目服务，真实 Run/归档及重启回收仍需联合验收，不能从组装测试推断已上线。

独立的全局项目调度入口现已接上持久轮转认领和项目 Run/Archiver 组装：按队列中固定的 projectId、GitHub 仓库身份及配置快照解析 target，启动该项目 Run，完成后转 `waiting_archive` 并释放唯一执行槽；归档继续使用原项目服务。重启恢复从原队列归属重建服务，对无 Run 的认领请求重新排队，对中断/待归档请求分别处置。合成双项目覆盖 A 归档未结束时 B 启动、A 镜像准备失败/归档失败/恢复失败时 B 仍完成；完整 quality 容器回归 400 通过、2 跳过，类型、lint、格式检查通过。此入口尚未切入正常 App/后台定时器，未用真实 Git、模型和 Docker 证明完整项目 Run；部署配置更新冲突、项目级 poller/scheduler、内部 ref 恢复核对及正式升级切换仍待完成。

离线升级现有正式命令 `npm run db:multi-project -- inspect|backup|upgrade-empty|upgrade-project|verify`。操作者必须先停止服务和后台任务，确认数据库路径及主密钥环境变量，先用 `inspect` 查看预检和数据库 fingerprint，再用 `backup <新目录>` 制作 SQLite、repo 和 report 一致备份；有历史时逐条核对归属后，向 `upgrade-project <备份目录> <已审 fingerprint>` 提交同一份摘要。命令会从旧配置和同 scope Git Token 向 GitHub 验证稳定仓库 ID，不接受手填 ID；空实例使用 `upgrade-empty`，完成后运行 `verify`。同一升级命令重复执行只返回已完成状态，半迁移或未知版本拒绝启动。备份需连同主密钥材料保存在受控位置，回退必须同时恢复数据库和工作目录。当前版本网站仍是旧单项目 App，因此**不要在真实实例执行升级**；已迁移库会被旧 App 和旧 db:migrate 入口明确拒绝，待新 App/API 完成后才能实际切换。合成文件库和完整 quality 容器验证为 403 通过、2 跳过；类型、lint 与格式检查通过。

部署与项目凭据写入门禁现有独立入口：部署设置只接受 Provider、三组模型、浏览器、OSS 和保留天数；运行中请求阻止模型/浏览器与 OSS 目的地变化，已有 Run 证据引用阻止 OSS 目的地原位变更。Provider 密钥在运行中不可轮换；项目 GitHub Token 仍允许原位修复，但测试账号和清理 Token 在本项目 queued/running/waiting_archive 未排空前不可替换或删除，另一项目不受影响。离线迁移继续使用底层 Secret Store，避免旧 queued 记录让升级无法重加密。新写入入口尚未接入网站 API；正式 App 切换时必须只暴露受控入口，不能让旧全局配置 API 绕过门禁。

项目管理 HTTP 路由现有独立注册模块：认证后列出/读取项目，创建时先向 GitHub 验证稳定仓库身份，再在同一数据库事务中保存 paused 项目、初始语言配置与可选 Git Token；凭据写入失败回滚整个创建。项目配置和凭据的更新只接受明确 projectId，路由内部强制套用上一节点的凭据门禁，返回内容只有掩码与配置状态。合成 API 验证未认证/跨 Origin 拒绝、仓库去重、项目 A/B 配置隔离、A 有任务时写入冲突、B 仍可更新、错误 scope 拒绝及创建回滚；完整 quality 容器测试 407 通过、2 跳过，类型、lint 和格式检查通过。此模块尚未挂到正式多项目 App，也未提供暂停/恢复和就绪检查；现有网站仍保持旧单项目路径。

项目暂停/恢复与就绪判断现接入上述独立 HTTP 模块：新项目保持 paused，检查返回仓库、部署、环境、镜像和凭据各自的状态与检查时间；缺项或外部检查失败时恢复返回冲突并保持 paused。恢复要求调用方提供实际的仓库、部署、环境和镜像检查实现，不能省略检查后默认通过；检查期间配置、凭据、镜像记录或暂停状态变化时要求重检。暂停与队列认领共享 SQLite 事务边界，已有运行和排队请求保留，暂停后不再认领新任务。合成测试覆盖错误仓库身份、外部失败、不可解密 Secret、检查中配置变化、明确恢复和运行中暂停；完整 quality 容器测试 408 通过、2 跳过，类型、lint 和格式检查通过。实际 GitHub/环境/Docker 检查适配器、持续就绪缓存和正式 App 挂接仍待下一阶段，不能把此节点称为真实可启用的多项目模式。

真实就绪适配器现已作为可注入模块提供：每次检查重新核验项目 GitHub 稳定身份，分别检查部署模型、浏览器和 OSS，访问该项目的环境 URL，并在场景分支尚不存在时回退到 GitHub 默认分支的当前固定提交，核对该提交的镜像状态及 Docker 镜像标签。测试覆盖 A/B 的 Token、环境地址和提交隔离，以及缺镜像、镜像不匹配、部署失败保持 paused。就绪 GET 不隐式构建镜像；独立管理路由尚未注册到正式 App，镜像显式准备入口和正式 App 接线是后续节点。此处只是适配器和合成验证，不能称为真实项目已可启用。

项目管理路由现增加受认证的显式镜像准备操作：服务端自行核验项目 GitHub 稳定身份，先查场景分支、首次接入时回退到默认分支，固定完整提交并刷新项目 clone 后调用受控镜像准备服务，返回不可变 image ID 与复用状态；请求不能自选提交或本机路径。缺 Token、身份不符、目标分支不可读、源码获取失败、Docker 不可用和构建失败分别阻止准备，镜像准备期间配置变化要求重检。合成 HTTP 测试覆盖认证、跨 Origin、跨项目、首次分支缺失、失败及复用；完整 quality 容器测试 410 通过、2 跳过，类型、lint、格式检查通过。正式 App 尚未注册这些管理路由，控制台、持续状态展示和真实双项目验收仍待后续节点，不能把独立路由的合成测试当作功能上线。

新的多项目 App 组装入口现已建立，只接受完整离线升级后的数据库；接入现有单管理员登录、密码修改和退出、账号显示名称、部署设置与受控部署凭据，以及项目管理、就绪和镜像准备路由。新 App 不注册旧 `/api/config`、无 projectId 的 Run 等单项目业务入口。合成 HTTP 验证完整升级标记、登录与改密码后的会话失效、项目创建、部署/项目 Secret 分 scope 和旧路由关闭；完整 quality 容器测试 411 通过、2 跳过，类型、lint、格式检查通过。`main.ts` 仍启动旧 App，新组装入口尚未挂入正式启动；项目绑定的业务路由、全局 dispatcher、控制台和恢复必须接齐后再切换，否则升级实例虽可配置项目却不能执行 Run。

多项目 App 现接入按 projectId 提交普通 Run/确认合并来源、读取项目队列和已完成 Run 的业务路由；提交只接受服务端所属项目，不接受请求体自选 projectId、targetCommit 或其他额外字段。新请求经项目队列写入固定配置快照，暂停项目拒绝入队；提交后唤起已有全局 dispatcher，队列和 Run 查询使用项目受限 Store，异项目 ID 按不存在处理。合成 HTTP 覆盖暂停、跨项目读取、旧无项目路由关闭、来源确认和跨 Origin 拒绝；完整 quality 容器测试 411 通过、2 跳过，类型、lint、格式检查通过。项目调度的启动恢复、轮询/定时器、运行中详情及其他项目业务视图尚未接齐，`main.ts` 仍未切换；此节点不能作为服务已正式多项目运行的证明。

多项目后台调度入口现复用既有 Git Poller，逐项目读取配置、仓库、Run 进度及持久轮询/cron 状态，只扫描 active 项目；单项目 poll 错误记录在该项目并继续扫描其他项目，所有入队请求仍经同一个全局 dispatcher 认领。新 App 在启用后台任务时先完成 dispatcher 恢复，再启动单个定时器；关闭时停止定时器并等待当前 tick。合成验证 A 检查失败、B 正常入队、暂停后不再扫描、cron 同分钟去重及 App 生命周期；完整 quality 容器测试 412 通过、2 跳过，类型、lint、格式检查通过。索引、失败归档重试、运行中详情、项目业务视图和正式启动切换仍需后续节点；本节点不等于完整自动化运维验收。

新 App 现提供项目绑定的索引状态、手动仓库同步、场景和正式报告读取 API；同步同项目并发请求复用一次任务，索引器只使用项目仓库与项目数据库分区。合成 HTTP 验证两个项目相同场景 ID/路径分别返回自身内容，报告和 Run 交叉读取返回 404，匿名及不存在项目拒绝访问；完整 quality 容器测试 412 通过、2 跳过，类型、lint、格式检查通过。自动周期索引、运行中详情、证据网关、归档重试和控制台仍待后续节点，不能用本次读接口验证代替真实 Git 双项目同步。

后台现按项目每五分钟同步索引，暂停项目仍可更新读模型；单项目同步失败保存该项目错误并继续其他项目。已完成但归档 failed/partial 的队列项在退避后按原项目及固定任务快照重试，暂停不阻止归档，重试结果只更新原队列记录；同一轮中 A 失败仍会处理 B，跨项目队列 ID 无法改写。完整 quality 容器测试 413 通过、2 跳过，类型、lint、格式检查通过。真实 Git 同步与 OSS/GitHub 归档失败恢复仍需联合验收，运行中详情、证据网关、控制台和正式启动切换也尚未完成。

项目 Run 读取现补充活动 Run、运行中详情、完成及中断历史，当前 Run 查询只返回 URL 所属项目。证据网关要求认证、Run 归属与 Run 已登记的精确 object ID/key 对应；新对象还核对键中的 projectId/runId，已迁移历史 Run 的旧 OSS 键保留可读。响应禁缓存和 MIME 嗅探。合成 HTTP/调度测试覆盖 A 运行时 B 不可读、活动与完成证据、匿名/跨项目/未登记对象拒绝以及旧证据键；完整 quality 容器测试 414 通过、2 跳过，类型、lint、格式检查通过。真实 OSS 读取和进程重启后的活动状态仍待联合验收。控制台和正式启动切换尚未完成。

多项目控制台首个页面切片已接入 `/api/mode` 识别入口：新 App 可登录、连接和切换项目，编辑项目与部署设置、更新凭据，查看就绪/索引/队列/Run 概况，显式准备镜像、同步仓库并提交普通 Run。项目深链接刷新后保持选择；切换项目会中止旧项目的读取，迟到的异步写入结果也不再更新已卸载视图。就绪检查失败不会遮住项目资料和修复入口。合成浏览器冒烟覆盖快速切换、深链接及检查失败；quality 容器完整回归 414 通过、2 跳过，类型、lint、格式、构建和新浏览器冒烟通过。`main.ts` 仍启动旧 App，本页尚未在正式服务出现；全局执行项目展示、完整配置字段与状态操作、真实双项目浏览器验收留待后续节点。

正式运行命令和 runtime Dockerfile 命令现转向多项目启动入口：启动只接受带唯一离线切换标记的完整新 schema，不自动升级旧库；新 App 托管构建后的控制台静态资源，深链接回退到页面入口，旧无项目业务 API 保持关闭。数据库离线命令改为执行已编译 JS，供只包含 `dist` 的 runtime 镜像使用。合成文件库测试覆盖缺库、未升级旧库、空实例离线升级后的启动、页面/深链接和 API；quality 容器完整回归 415 通过、2 跳过，类型、lint、格式、三条浏览器 E2E 及编译后空库升级命令链通过。真实持久实例未执行升级，runtime 镜像尚未构建验收。项目 Docker Engine 接入、完整人类配置页、真实双项目 Run 和部署形态验收仍未完成，不能据此发布 v0.6.1。

Docker 部署节点将 runtime 镜像加入 Docker CLI，Compose 只把 Engine socket 授给罗网服务容器，并提供 socket GID 配置；项目 Run 容器不挂载 socket。Run 的固定提交加场景 patch 源码从服务容器经受控 `docker cp` 送入已创建的项目容器，不再把服务容器内部 `/data` 路径交给宿主 Engine 当 bind mount。真实本机 Docker smoke 验证容器读取到 patch 后场景、镜像固定 ID、失败清理和执行后容器删除。runtime 镜像构建和完整质量回归通过（415 通过、2 跳过，三条浏览器 E2E）；首次镜像准备前新增 Engine 检查，无法连接时按部署级故障返回，不记成项目 Dockerfile 构建失败。独立测试数据卷使用编译后命令完成空实例备份与升级，Compose 服务以非 root 用户连接 Linux Engine `28.3.3` 并达到 healthy；HTTP 核对健康、多项目模式、控制台、管理员登录和零项目列表，旧 `/api/config` 为 404。测试容器、网络和数据卷已清理。仍缺不同工具链的真实双项目 Run、重启孤儿容器回收与镜像清理策略；不能以本节点代替最终联合验收。

重启恢复节点在调度器恢复队列前先回收 Docker 资源：新项目镜像与 Run 容器都标记稳定数据库实例 ID；只对本实例、数据库内项目、合法 Run ID 和精确容器名吻合的遗留容器执行强制删除，核验失败则停止恢复，避免与新 Run 并行。镜像只在同实例、同项目、精确构建 tag 且没有 ready 状态或 Run 镜像记录引用时尝试按不可变 ID 删除；Docker 拒绝删除时保留，旧无实例标签资源和无标签缓存留给运维核对。合成测试覆盖正常删除、保留引用/派生/占用镜像及归属不符拒绝；真实 Docker smoke 在临时项目镜像和遗留容器上验证回收及资源清理。当前源码在 Linux quality 环境完整回归 417 通过、2 跳过；类型检查通过。不同工具链的真实双项目 Run、升级/失联恢复及发布验收仍未完成。

双工具链本地节点用两个独立临时 Git 仓库和同名场景 ID 实测 Node 与 Python：分别从固定提交构建项目镜像，第二次准备精确复用同一 digest；两个 Run 容器各自读取 patch 后场景并执行本语言命令，关闭后无遗留容器；Node 项目提交变化后得到新镜像 digest，后续故意破坏其 Dockerfile 只让本项目构建失败，Python 镜像仍可复用。本轮三个实际镜像 ID 依次为 Node `sha256:bb2da196a394b37fddb482a2a2ba129901bb05a7f46b07a2f9bf08b1e77c3492`、Python `sha256:1d7e1380b1eabf885cb9cf8222812cec38c8ea0f2e44ab5a8836867625f9ac37`、Node 新提交 `sha256:d9cc80657cd7bd7e9091f12ebe28353c62a3b74c37ecb07285a236622248b882`。第一次真实构建暴露上一节点实例标签缺少 `--label` 的接线错误，已同时修正镜像构建和容器创建参数，并加入参数对回归断言。合成本地仓库与镜像在演练后清理，测试脚本保存于 `tests/e2e/multi-project-two-toolchain-smoke.mjs`。修正后 Linux quality 容器完整回归 417 通过、2 跳过；类型、lint、格式、构建和三条浏览器 E2E 均通过。这证明两种工具链的受控容器路径可用，不代表已完成两个外部目标、真实模型/浏览器/OSS/归档联合验收。

## 阶段 2：绑定项目的服务与副作用

- [x] 先完成执行镜像可行性切片：明确镜像构建上下文与 Run 工作场景 patch 的交付方式，证明容器内代码/依赖与固定提交一致；保持现有命令允许列表、超时、输出限额和证据捕获语义。
- [x] 建立唯一的受控 Docker 执行服务，限制镜像构建、容器创建/销毁和命令入口；Docker 不可用作为部署级就绪失败，项目构建失败作为项目级阻塞，不允许 Web 路由或 Agent 直接调用 Docker API。
- [x] 按项目保存构建配置、构建提交、不可变镜像 digest 和状态；接入时准备镜像，目标提交变化时重建或精确复用，构建失败只阻塞所属项目。禁止 Run 中途切换 digest 或回退到罗网服务容器执行。
- [x] 从已准备项目镜像启动执行容器，完成最小环境、目录挂载、退出清理和重启回收；不挂载其他项目、主密钥、SQLite 或 Docker socket。容器镜像复用，避免每个 Run 重建一次性镜像。
- [x] 逐条改造 Repository Service、Indexer、Orchestrator、Run Store、Archiver、Operations 与 Connectivity 的调用链，使用明确项目上下文，不引入全局 selectedProject。
- [x] 隔离 Git clone/internal refs、Run 目录、浏览器状态、OSS 前缀及 HTTP 清理对象；继承 v0.6.0 读取回执并绑定 projectId。
- [x] 所有报告/证据网关、历史读取、配置导出、Issue/PR 和重试入口核验项目归属。
- [x] 加入配置修订与任务快照；按 spec 的任务存续条件拒绝改变环境、账号和场景语义配置，支持同 scope 访问凭据轮换。

完成证明：AC-MP-02/03/04/07/09/15。核心负例是 A 的 Run ID 配 B 的项目路由、A 的密文放 B 的 scope、A 的旧任务误取 B 配置、相同场景 ID/文件名覆盖、容器错用其他项目镜像或旧提交，以及镜像不可用时回退到服务容器。

## 阶段 3：调度、暂停和恢复

- [x] 改造 `automation/queue.ts`、state、scheduler、service、poller、recovery，按项目处理队列和推进。
- [x] 全局原子认领一个 Run、项目内 FIFO、项目间持久轮转；自动请求仅同项目同语义合并。
- [x] 处理 paused、queued、准备中、running、waiting_archive 的转换与竞争；同项目等待归档阻止推进，其他项目可继续。
- [x] 镜像准备/重建进入本项目准备状态；记录构建输入提交和 digest，失败退避不占全局执行名额，恢复时只复用经核验的镜像。活动任务期间的构建配置修改按语义配置冲突处理。
- [x] 按项目捕获超时/失败和退避；验证公共依赖失败仍按公共影响显示。
- [x] 通过真实本地 Git 和进程恢复测试覆盖 prepared/resolved、中断、归档重试和幂等，不借助额外模型调用制造确定性故障。

完成证明：AC-MP-06/07/08。风险是给每项目都起一个独立运行器从而突破全局单 Run，或单项目等待归档卡住全局调度。

## 阶段 4：API 与控制台

- [x] 将业务路由迁至显式 projectId 命名空间；身份和部署配置入口保持独立，不保留默认选中项目兼容逻辑。
- [x] 账号 API 只允许已登录管理员读取/更新显示名称；密码修改和退出沿用现有认证入口与会话规则。
- [x] 增加项目列表、创建/切换/暂停/恢复、项目配置与凭据页面；显示各项目就绪和同步状态。
- [x] 将账号、部署设置和项目设置分开；账号页沿用单管理员认证，提供显示名称、密码修改与退出，复核改密码后的会话失效。
- [x] 做可中断的项目接入流程：仓库身份校验后创建 paused 项目，逐步配置环境/凭据/清理/触发及执行镜像构建说明；显示镜像构建/重建状态、固定提交和 digest，复用项目设置的服务端校验，最后由管理员主动启用。
- [x] 项目概览显示就绪清单、检查时间、失败原因和下一步操作；区分“保存成功”和“连通性通过”，将 YAML 导入导出留在高级设置且不导出明文 Secret。
- [x] 页面路由、轮询缓存、查询和异步写操作绑定 projectId，处理上一项目迟到响应；明确暂停不会取消已有运行。
- [x] 展示全局当前执行项目及其他项目的排队原因，保证深链接与刷新保持项目选择。

完成证明：AC-MP-01/04/05/07/13/14/15；API 集成测试与浏览器 E2E 覆盖空项目首次接入、镜像准备失败/重建、未就绪暂停、凭据修复后主动启用、两个同名场景项目的快速切换、旧请求返回及重试操作。

2026-09-25 清单回查：阶段 1–4 的上述产品与服务实现已落在当前分支，原勾选状态停留在早期切片而未随下方逐节点实现记录更新。本次按现有迁移/Secret/项目路由/调度/管理员/API 测试、两个真实项目 Run 和浏览器快速切换 smoke 将实现项勾选。浏览器 E2E 当前只直接覆盖项目切换及旧响应迟到，其他接入与恢复路径主要由 API、状态机和本机 Docker 测试证明；完成证明中的整段浏览器 E2E 覆盖尚未达到，发布候选前需补相应 UI 验证，不能因勾选实现项而声称它已通过。

2026-09-26 控制台浏览器补验：`multi-project-ui-smoke` 在原有双项目快速切换、旧响应迟到和深链接刷新外，增加空列表创建项目到再次暂停的状态化浏览器路径。模拟 API 按真实路由接受仓库绑定，首次启用返回未就绪、镜像首次构建失败、重试后就绪；浏览器断言 Run 按 paused/active 状态禁用或启用、配置与凭据保存落在当前项目、活动请求期间修改环境返回 409 且旧配置保持不变。它验证了页面交互与错误呈现，不把模拟 API 算作真实 GitHub/模型/镜像联合验收；真实后端隔离仍由 API、Docker 与上方 live Run 证明。异步写操作跨项目切换和完整服务器负载仍待发布前复核。

2026-09-26 异步写入切换补验：浏览器先从项目 A 发出配置 PUT 和镜像准备 POST，分别把模拟服务响应延后，切到项目 B 后再释放 A 的响应。请求 URL 与提交内容均保持 A 的项目归属；B 的配置字段、镜像摘要和操作完成提示未被 A 的晚到结果覆盖。该对照补齐了控制台对异步写操作的页面边界，不证明服务端实际写入归属；后者仍由项目 API/存储测试和真实 Run 验证。正式服务器完整模型/浏览器负载、真实旧实例迁移条件及候选资源收尾仍单独待完成。

## 阶段 5：迁移演练与双项目联合验收

- [x] 在隔离副本完整演练 v0.6.0 → v0.6.1 升级、恢复和回退；首个旧项目的历史工件/证据地址不改写。
- [x] 以 v0.6.0 的深读样本验证项目 A/B 不共享理解、回执或计划，保持原有角色和场景行为。
- [x] 确认两个获授权非生产 GitHub 目标、合成账号、清理条件及模型调用预算；未具备资源时保留 live 未运行，不自行建仓库或扩大外部权限。
- [x] 交替运行两项目，核对同场景 ID、各自 fixed target、真实 DeepSeek/浏览器/OSS、清理、Issue/PR 和正式归档；加入一方依赖受阻而另一方完成的对照。
- [x] 使用两种不同工具链验证各自镜像的构建、复用、提交变化后重建、命令执行证据及失败隔离；记录实际镜像 digest，不能只验证容器能启动。
- [x] 留下两项目的提交、Run/队列 ID、模型成本、归档目的地及清理证明；验证结束清理临时容器和网络，保留远端报告、受控离线备份及原始数据卷供回退。

完成证明：AC-MP-09/10/11 及 AC-MP-12 的深读回归部分。上一版单项目 live 不能替代本阶段，两个页面截图也不能证明后台任务隔离。

阶段 5 隔离演练：在合成 v0.6.0 文件库中建立旧 Run、场景、报告、进度、Secret、仓库及报告目录，先制作并核验一致备份，再升级为唯一 paused 旧项目，接入第二项目。数据库断言旧 Run 的固定提交、工件、报告路径及旧格式 OSS 证据地址保持原样；新 App 认证 API 可从原项目读取旧 Run，从第二项目读取返回 404。随后整体恢复数据库、仓库和报告目录，核对旧库摘要与 Secret，再重复升级并检查外键。此项只证明隔离合成副本的升级/回退路径，不代表真实持久实例已迁移。

深读隔离回归使用 v0.6.0 验收集的 `refactor` 和 `bug-fix` 合成代码，两项目读取同一路径 `src/orders.mjs`，分别写入项目 Run 的回执和 Main 计划。测试核对 Run/仓库标识、目录及计划引用各自独立，B 引用 A 的回执会拒绝且不会留下计划，查询也只返回本 Run 的回执。这是确定性的归属与串用防护证明；尚未运行两项目的真实模型深读质量对比，因此深读验收项仍未勾选。

负责人已授权沿用两个非生产目标：`cynos-ai/cynos-website` 和 `cynos-ai/luowang-closure7-fixture`。2026-09-24 只读查询到前者 `main` 为 `2defdbf9b811d055aa397f29460c8e9ce8f22850`、`scenario-testing` 为 `f4800046e7797109527371504d97f778926ca957`；后者 `main` 为 `ef468e7c94d023d36da1e88254af90cdcc934b21`、`scenario-testing` 为 `7062f9a65651eeef7abe9f6a79ed4dc4c5f583d9`。这些只是查询时的分支头，不能作为后续 Run 的固定 target。当前尚无运行中的罗网联合验收服务，也未确认两个环境的合成账号、清理条件和受控 Secret Store，因此外部双项目 live 项保持未完成。

2026-09-24 的 live 资源预检：GitHub API 用已有受控凭据核对两仓库的稳定 ID 分别为 `1350942277`、`1381180501`；在独立本地目录克隆并检出上述两个 `main` 提交，检出工作树均干净。现有 DeepSeek 凭据访问 `/models` 返回 HTTP 200，但列表没有列出当前配置的两个模型名；一次限制为 4 个输出 token 的 `deepseek-v4-flash` 请求返回 HTTP 200、计费 37 token，未取得可用于判定回答质量的文本。OSS 临时小对象完成写入、回读与删除。此预检只证明凭据和部分依赖当前可达，不算模型、浏览器或 OSS 的联合 Run。

此前尚缺的本机候选实例和非生产应用已在 2026-09-24 建立；官网固定提交没有原生 Run 清理接口，验收环境使用未修改目标仓库的临时清理 sidecar。它只访问独立测试卷、要求独立 Token，并按完整 Run ID 标记查删。使用合成账号实测清理前 1、删除后 0、再次查询 0，匿名请求返回 401。两个目标应用固定 `main` 提交分别为 `2defdbf9b811d055aa397f29460c8e9ce8f22850` 和 `ef468e7c94d023d36da1e88254af90cdcc934b21`；官网原 Dockerfile 的 `npm ci` 曾因 `ECONNRESET` 失败，改用仅替换下载源的本地临时 Node 基础镜像后，两个应用镜像成功构建且容器健康。此下载源调整没有写入目标仓库。两个目标仍都是 Node 工具链，不能凭这两个真实目标证明“两种不同工具链”；此前异构工具链证明仍限于本地合成演练。

2026-09-24 双项目 live 接入节点：独立罗网候选数据卷完成 `db:migrate → backup → upgrade-empty → verify`，Docker 服务容器健康；用正式管理员 API 创建两个 paused 项目并写入各自配置和受控 Secret。首次创建时 GitHub 请求恰逢 10 秒超时返回 500；容器内带已有凭据的只读核验随后返回 200，重试创建成功。两项目 readiness 的仓库、凭据、模型/浏览器/OSS、环境、镜像五项均为 `ok`，随后主动启用。此连通性检查不证明模型生成质量或完整 Run 成功。

| 项目 | 项目 ID | 固定场景 target | 罗网构建的项目执行镜像 ID | 首次 live 队列 / Run |
| --- | --- | --- | --- | --- |
| `cynos-website` | `f4d56bc5-a7a7-40ab-afb5-4d098550945c` | `f4800046e7797109527371504d97f778926ca957` | `sha256:5712eff4ef452acaf149d44a4d3acb7b81a6e9f4ed8d9c87a2e23f11eabf90d6` | `1` / `01M39TJ9VY1JRQ3P659WJP97XN` |
| `luowang-closure7-fixture` | `4b1cb89c-539c-4b1d-a197-688389e808c8` | `7062f9a65651eeef7abe9f6a79ed4dc4c5f583d9` | `sha256:b44a477cd91d16b0b3655043b3a7861028043e60eeb74d5c7e4f73c633fb268d` | `2` / `01M39TJ9WJV7X45GS15QXAMVC7` |

镜像定义均为内置 `@builtin/node-24.14.1-v1`，两次 `image/prepare` 返回 `reused=false`；后续 readiness 对实际镜像 ID 和各自目标提交重新核验通过。实际 Run 的队列固定 target 与镜像准备 target 一致，两个项目队列身份未串用。

本轮**没有通过双项目联合 Run**，失败记录保留在隔离候选卷：官网队列 `1` 在 Git fetch 阶段失败，错误为“Git fetch 操作失败”；容器内后续对同一公开仓库执行只读 `ls-remote`、两仓库 `fetch` 均成功。官网重试队列 `3` / Run `01M39TYP1ZC5JZWAFNTHBN87VY` 固定同一 target，Main 已写 `plan.md`，但在生成最终报告前以通用执行错误失败。fixture 队列 `2` 固定 target 后，Main 写入 `plan.md`、`source-reads.json` 和场景 patch，随后也以通用执行错误失败；patch 按罗网实际使用的 `git apply --check --recount --whitespace=nowarn` 参数验证可应用，不能把不带 `--recount` 的检查失败当成根因。三个失败均未产生正式报告、归档提交或可声称通过的浏览器/OSS 联合证据。失败 Run 在队列中有 ID 和错误，但 `/runs` 列表未给出对应可查询详情；下一节点须定位未分类异常及失败详情保留问题，修复后重跑，并对清理结果、模型成本、归档与跨项目隔离逐项核验。临时应用、候选实例及独立卷暂保留用于诊断；不得把其中的测试数据或临时 Token 提交到 Git。

2026-09-24 后续根因与重跑：内置项目镜像准备时以 `@builtin/node-24.14.1-v1` 记录，Run 容器成功启动后镜像绑定表却用项目配置的空 Dockerfile 路径查询，导致“Run 镜像与已准备项目镜像不一致”，在 Runner 执行前失败。修正绑定键后，专门回归测试及相邻服务/归档测试在固定 Linux quality 容器通过。保留的队列 `2/4/5/6/7` 均未被改写；其中 `6` 是独立的临时 Git fetch 失败。新的 fixture 队列 `8` / Run `01M39Z2H59PP6TWS8D9JHAB0RM` 和官网队列 `9` / Run `01M39Z7CNP5RHXCWKM3JZ0BRCR` 依次固定各自原 target，均完成 Main、Runner、Reviewer、最终 Main、本地报告及 Harness 清理，没有跨项目并行或上下文串用。

fixture Run `8` 有 109 项证据：`AUTH-LOGIN-001` passed；`AUTH-REGISTRATION-001` blocked，因为“数据库不保存明文密码”这一明列期望缺少持久层观察，Reviewer 没有把响应体不回显密码冒充数据库证明。独立清理对两个 Run 标记账户均核验 `absent=true`。官网 Run `9` 有 104 项证据，两个场景均 blocked；浏览器操作证据捕获发生失败，两份页面快照上传失败，因此不能把缺口当作通过。两个报告均已在各自项目的隔离 completed 目录和数据库留存，但 `reportStatus=failed`、`archiveStatus=partial`，**没有发布到目标仓库**，blocked Run 也没有推进测试基线。本轮没有确认产品 Bug 或创建 Issue/PR，模型成本仍未形成可核验汇总。

共同归档失败现已定位到 Git 推送返回 403：原项目 Token 可读取两个仓库，GitHub API 返回账号 `push=true`，但该标志不证明 Token 的 Contents 写入能力。归档先前用“正式报告尚未发布”覆盖具体失败原因；现已保留经脱敏的受控原因，fixture 重试明确得到“报告推送认证或权限被拒绝”，官网仍为 partial。检查到本机 GitHub CLI 的另一枚凭据带 `repo` scope 且与项目 Token 不同，但自动审批审查拒绝将它写入两项目的持久 Secret Store，理由是会扩大外部仓库写入能力且缺少针对该凭据的明确授权；没有绕过或执行轮换。后续须由负责人明确授权该轮换，或提供仅对两个测试仓库具 Contents 写权限的凭据，再从保留的 completed 工件幂等重试归档。随后还须解决官网证据上传失败、fixture 持久层验证缺口、失败 Run 详情不可查与模型成本记录，重跑完整双项目验收；当前不能合并或发布 v0.6.1。

2026-09-25 授权后的接续：负责人明确允许将本机已登录 GitHub CLI 的 `repo` 凭据写入两个隔离项目的受控 Secret Store。轮换后，保留的 fixture Run `01M39Z2H59PP6TWS8D9JHAB0RM` 在其目标仓库发布报告提交 `c0bb63e5ad3f87dfeb3872b919ec3aef41c47430`；官网 Run `01M39Z7CNP5RHXCWKM3JZ0BRCR` 发布报告提交 `a6a0021f2d0ca77d388f3d872712445e1ad61765`。两者归档均为 completed，结果仍为 blocked，历史缺口不因发布而改判。Secret 值未进入代码、日志或报告。

项目 `/runs` 现从同项目队列保留记录补出未归档的失败 Run，并提供项目受限详情；既有 completed 与 interrupted 记录优先，空工件不伪造执行证据。候选实例重启后原有官网 2 条、fixture 5 条失败记录均可见且不跨项目；相关 API 回归通过。官网 Run `10` / `01M3AB3GBZQ063V06NBZMN1SXD` 固定 `a6a0021f2d0ca77d388f3d872712445e1ad61765`，95 项证据均已上传、无快照捕获/上传失败，报告提交 `27cf72f4daf7af797e44b9da87a80afb1daf9262`；两场景仍 blocked。对照发现隔离官网应用原本由较旧的 `main` 提交 `2defdbf9b811d055aa397f29460c8e9ce8f22850` 构建，而 Run 的场景分支源码已包含“删除测试账号”控件，运行页面没有，属于测试环境与目标代码不一致。已把隔离官网应用重建为场景分支固定提交 `27cf72f4daf7af797e44b9da87a80afb1daf9262`，保留原数据卷，并将项目环境说明改为当前场景分支固定提交。

更新应用后的官网 Run `11` / `01M3ABXC0X7RN3K6VSP529WF4D` 固定该 `27cf72f` 提交，登录场景 passed，注册场景仍因无受控持久层观察 blocked；105 项证据已上传，真实页面和网络记录确认删除账号后旧 Cookie 与原凭据均失效。该 Run 没有图片证据，Harness 正确保留 UI 截图缺口，因此尚不能称完整 UI 验收。场景 patch 首次归档遇到远端并发更新，后台幂等重试后场景及报告均成功发布，报告提交 `151e0036063546739dcad3d77f6b070184b9b578`，未 force-push。Runner 内置指令现明确要求浏览器场景在相关真实页面状态至少保存一张截图；该指令尚待下一次真实 Run 验证。快照采集失败只记录预定的安全类别，原始失败快照仍丢弃；旧 Run 的两份原始失败快照不可逆，不能追溯其具体解析根因。fixture 的持久层期望、模型成本汇总及完整双项目验收仍未闭合，不能合并发布 v0.6.1。

继续验证截图指令的官网队列 `12` / Run `01M3ACRFBSJWBBHH3D47EX1CBM` 固定 `0341e87346e6b601b91818e54b7c077a4e64d5c5`；已核对该提交与当前隔离应用镜像的产品源码、依赖和 Dockerfile 无差异。Runner 在两个 UI 场景实际保存 4 张截图，均进入 OSS 和正式报告，标签分别反映有无可见表单值；总证据 111 项，无截图缺口。登录场景 passed；注册场景仍因无受控数据库观察 blocked。报告已发布为 `fcf92273e091cd6e0dfa287370c78e81ce815b35`，归档 completed。Reviewer 读受控操作证据时发生 10 次约 15 秒的 OSS timeout，Harness 保留两条读取失败阻塞项；事后经同项目证据 API 只读复查 `operation-7.json` 返回 200，只能证明至少该对象后来可读，不能追认当时 Reviewer 的审核。完整验收仍需查明/处理临时读超时，补 fixture 的持久层验证通道及模型成本记录后再重跑。固定 Linux quality 容器的 typecheck、lint、format 与完整测试通过：420 passed、2 skipped。

2026-09-25 证据读取节点：Reviewer 对本 Run 已上传对象的 OSS 读取现在仅对明确的 timeout/connection 最多尝试三次，间隔 200/400 毫秒；认证、对象不存在、内容校验失败仍立即阻塞。最终读取失败继续保留诊断及失败计数，暂态失败后读到对象则不伪造失败。此修复不改旧 Run 结论，也尚未在 live 候选实例重跑。固定 Linux quality 容器的 typecheck、lint、完整测试通过（424 passed、2 skipped）；格式由相同 Prettier 版本在工作树检查通过。下一节点需更新隔离候选并真实重跑两项目，同时补受控持久层观察和可核验的模型用量口径。

2026-09-25 模型用量节点：每个 Pi Session 结束时从 SDK 的完整 Session 统计提取 input/output/cache token，在本 Run 本地受控目录的 `agent-usage.json` 逐 Session 累积并给出总量；失败 Run 保留已有 Session 的部分统计，人工审核的特殊完成路径也保留文件。该文件不进入模型可读工件、目标仓库报告或 OSS，且不保存消息正文。SDK 目录价格为正时只标为估值，价格为零或未知时费用记为 `null`，不把零当作免费或供应商账单。旧 Run 没有可追溯的同类统计，不能补造历史成本。此节点仍需在下一次真实 DeepSeek Run 核验 token 返回和估值口径，不能据本地模拟协议推断实际账单。

2026-09-25 持久层观察通道节点：Runner 新增仅在项目配置了受控 HTTP 清理适配器时出现的 `inspect_test_account_storage`；只有当前 Run 已登记 `website-accounts` 账号才可调用。适配器使用项目级清理 Secret 和固定非生产地址的 `/<runId>/storage` 只读端点，不接受模型指定 URL、账号或 SQL；响应仅允许当前 Run 的账号总数、Argon2id 数和其他格式数，校验计数后由 Harness 保存为本 Run 的 `operation-*.json` 证据，Reviewer 可独立读取。Runner 指令要求在删除账号前观察，且缺口不能由源码或单元测试代替。此节点只完成罗网侧工具和模拟端点回归；两个外部非生产应用尚未提供该端点，真实持久层期望仍 blocked，不据此改判旧 Run。下一节点需为两个测试应用增加受限聚合端点、构建与固定目标一致的应用，再真实复跑。

2026-09-25 两目标持久层端点已分别经 [fixture PR #7](https://github.com/cynos-ai/luowang-closure7-fixture/pull/7) 和 [官网 PR #13](https://github.com/cynos-ai/cynos-website/pull/13) 合入各自 `scenario-testing`；对应固定提交为 `751b75095fd2faf9f37136f35eaaacda368770f9`、`fed06e9e581b759985c9b66348e663ea3ca9814d`。隔离应用按这两个提交重建，旧容器保留回退；罗网新 runtime 使用原候选数据卷，重启后两项目旧失败 Run 和已发布报告仍可分别查询。两项目各自重新准备执行镜像，ID 分别为 `sha256:a18bd2e2eb615837e2bc19ec72f6de2b227890c63b1e6ffe933140d767def2ec`、`sha256:b5e5861a4b97412cd62c8435302796ffb344e035f327ef16c9fd8aed2b560ca3`，均 `reused=false` 且 readiness 通过。

首轮官网队列 `13` 在固定目标前以 Git 操作错误失败；fixture 队列 `14` / Run `01M3B7DDACNN7MHZ3CP99QEJNV` 固定上述 fixture 提交，Runner 完成两场景并生成截图、操作证据和 `execution.md`，但 Reviewer Session 以模型错误终止，没有审核结论、正式报告或归档。Runner 调用持久层工具时，先前登记的账号缺少显式 `cleanupScope: website-accounts`，工具拒绝观察；收尾亦将两条登记记为未绑定资源域，不能称为 Harness 清理通过。隔离应用随后对该 Run 的只读聚合查询为剩余账号 0，只证明当前无残留。该失败 Run 的 SDK Session 统计为 input 178541、output 35350、cacheRead 2364288 token，SDK 目录估值约 0.0415 美元；不是供应商账单。已在 Runner 内置指令及登记工具说明中明确账号必须绑定该域，其他资源不得绑定；固定 Linux quality 容器类型、lint、格式及完整测试通过（430 passed、2 skipped）。

修正后官网队列 `15` / Run `01M3B89TRX832Y6CDSVF48PHQM` 和 fixture 队列 `16` / Run `01M3B89TSDKTT2X7RFVFSEVE79` 都固定各自新目标，但均在 Main Session 以模型错误终止。用同一受控 DeepSeek 凭据发最小文本请求返回 HTTP 402，当前模型服务不可用，不能继续消耗队列把它当作产品问题或声称双项目 Run 通过；所有失败记录原样保留。为独立核验新端点，在两个实际运行的非生产应用中分别创建一个 Run 前缀合成账号，注册返回 201，存储聚合均为 `accounts=1、argon2id=1、other=0`；调用固定域 DELETE 后独立 GET 均为剩余 0。这个端点 smoke 不包含 Agent、Reviewer、OSS 或归档，不替代联合验收。恢复模型访问后须在当前修正 runtime 重跑两项目，确认 Runner 带域登记、`operation-*.json` 生成与 Reviewer 读取、截图/OSS、清理、报告归档及真实 Session 用量，再决定是否提交发布审核。

2026-09-25 DeepSeek 最小文本请求恢复 HTTP 200 后，同一隔离候选依次执行官网队列 `17` / Run `01M3B9TQ14F0Z0NV668DHSRX71` 与 fixture 队列 `18` / Run `01M3B9TQ1D6MKEJ0Z96QXBRPAE`。二者分别固定目标 `fed06e9e581b759985c9b66348e663ea3ca9814d`、`751b75095fd2faf9f37136f35eaaacda368770f9`，各自两个同 ID 场景均经 Runner、独立 Reviewer、最终 Main 判为 passed，`blockingReasons=[]`，自动归档 completed；先前 blocked/failed Run 仍按原结果保存。官网正式报告提交为 `b5afe7cf25768179e19fe0589c02e9fb21ae5d7b`，fixture 为 `4f870803f4a741af2966f43c7a4b30bda9e6790d`；两目标远端 `scenario-testing` 均已独立核验包含对应 `report.md` 与 `review.md`，官网另发布两份场景 patch，未改产品源码。项目间 Run 详情交叉查询均返回 404，本项目查询返回 200。

官网 Run 有 108 项证据、6 张截图，fixture 有 102 项证据、9 张截图；两者证据读取警告均为 0，并从各自项目 API 对一张已上传截图实际取回 HTTP 200。存储观察分别落在 `operation-67.json`、`operation-60.json`，均记录本 Run `accounts=1、argon2id=1、other=0`；Reviewer 的 `review.md` 明确引用对应受控观察。两份报告的 Harness 收尾均记录 2 项登记账号经固定清理适配器独立查询 `absent=true`，且没有改变功能结论。真实深读回执分别有 21、34 条，每条绑定本项目 Run、仓库身份及各自固定提交；Main 计划引用分别为 21、33 条，未发现跨项目引用。两份 `agent-usage.json` 均含四个 DeepSeek Session；官网累计 input 262031、output 52769、cacheRead 4119680 token，SDK 目录估值约 0.0630 美元；fixture 累计 input 276312、output 54493、cacheRead 3769344 token，估值约 0.0645 美元。该费用不是供应商账单。

本轮证明两个当前 Node 目标的完整路径、项目隔离和归档，但仍不能把它写成“两种不同工具链”的真实验证，也没有完成一方依赖受阻而另一方完成的受控对照。正式服务器的 Docker Engine 权限和容量尚未验证，隔离候选资源暂留用于后续检查。因此阶段 5 的异构镜像、失败隔离、最终资源清理及阶段 6 的发布审核仍未勾选；v0.6.1 尚未合并或发布。

2026-09-25 节点 1 故障隔离复核：`multi-project-dispatcher.test.ts` 的受控服务故障覆盖 A 的镜像不可用、A 归档失败或恢复失败时 B 仍可完成，归档重试保持原项目快照且暂停项目不改投；队列测试覆盖 A 等待归档时 B 继续运行和跨重启轮转。本机真实 Docker 双工具链 smoke 增加更强对照：Node 项目在新提交的无效 Dockerfile 上构建失败后，Python 项目的已准备镜像仍精确复用，且新的 Python Run 容器实际执行命令并读到本 Run 的场景 patch。Node、Python 与 Node 新提交镜像 ID 分别为 `sha256:28f3768f1b878f2d2d6f4c41c58107bf2108791fa778db1d1ff2aa60f1809fb6`、`sha256:bbe5e8fc73bc7c0cac07f2b7bdf961963143a1f73d19a5dcffa434b7e6c0ee8f`、`sha256:5bbce6a2025e4f644f21a47141c66fb19eeb065887ee21e05fd80bdafb7cf941`；两项目首次构建 `reused=false`、第二次精确复用，Node 提交变化后重建。演练容器、镜像和临时 Git 目录由测试清理。固定 Linux quality 容器类型、lint、格式、完整单测（430 passed、2 skipped）和三条浏览器 E2E 均通过。该对照使用隔离本地项目及确定性故障，证明执行服务和调度边界，不冒充新增外部目标的真实联合 Run。负责人现已授权后续在 `cynos-ai` 下建立独立的异构非生产项目，阶段 5 的外部异构项待该项目真实接入后再勾选。

2026-09-25 节点 2 外部异构项目：按负责人授权建立公开非生产仓库 [`cynos-ai/luowang-mp-python-fixture`](https://github.com/cynos-ai/luowang-mp-python-fixture)，GitHub 仓库 ID `1386819736`，罗网 projectId `daf7e42d-20d7-453a-a26d-d2bab1c1f478`。它使用 Python 3.13、Flask 3.1.1、SQLite、Argon2id，与已有两个 Node 项目构成真实异构目标；应用容器与罗网项目执行镜像分别由 `Dockerfile`、`Dockerfile.luowang` 构建。仓库通过 PR #1、#2 建立预置合成账号并同步 `scenario-testing`，初始固定提交 `a46a66e0ced2ff7100de8d16fe4605827adc8880`。项目以 paused 接入，配置项目级 GitHub/账号/清理 Secret，五项 readiness 均 `ok` 后由管理员主动启用。独立应用容器在隔离网络和 `/data` tmpfs 运行；真实 HTTP smoke 验证预置账号登录、Run 前缀账号 `accounts=1、argon2id=1、other=0`、DELETE 后独立 GET 余量 0、其他 Run 与预置账号仍有效。上述 smoke 不算 Agent Run。

首次初始化队列 `19` / Run `01M3BHGCK740Z3Z2NH1FE89616` 固定 `a46a66e`，Main 深读 12 个受控文件，Runner 在真实浏览器发现页面英文欢迎语，并执行 Python 单测；因 `review-all` 需场景审核，结论按规则为 `blocked`。罗网自动生成的 [场景 PR #3](https://github.com/cynos-ai/luowang-mp-python-fixture/pull/3) 经人工审阅和 CI 后合入 `scenario-testing`，得到固定提交 `499b00378dec10c2d32dfec2354b144a1731b757`。13 个 approved 场景中 `AUTH-REGISTRATION-001` 与另两个目标使用同一 ID，但文件、Run 与报告均留在各自仓库。初始执行镜像 `sha256:83e2c065b8d6dbb8e3ff2df55e883b378794c54517f39f4e8eaf5bd5917a35cc`；场景合入后重建为 `sha256:a1d8d49eec1e356d2a92eb5f36977cf7bb88c7e7d70795b059628106e853e674`，均 `reused=false`。

全场景队列 `20` / Run `01M3BHYQCY8D4P6WKD01RAPH0E` 固定 `499b003`，Runner 完成 13 个场景窗口，Reviewer 独立读证后判 **2 passed、1 failed、10 blocked**；聚合仍为 `blocked`，不可因确认了产品缺陷而改写总结果。`AUTH-REGISTRATION-001` 的页面截图和快照证明英文 `Welcome, <昵称>.` 违反中文契约，罗网归档器创建 [Issue #4](https://github.com/cynos-ai/luowang-mp-python-fixture/issues/4)，带 Run、Bug key、target 和场景 marker。正式报告已自动归档在该仓库 `docs/scenario-testing/reports/01M3BHYQCY8D4P6WKD01RAPH0E/`；5 项登记账号均由固定清理适配器独立核验 `absent=true`。10 项 blocked 的共同限制是现有受控 Runner 无法对部署应用发送任意 POST 或带自定义 Authorization 头的 HTTP 请求，页面又无登录表单；不能把浏览器 GET 405、无 Token 401 或单测替代这些真实期望。命令证据同时记录在项目镜像中运行的 `python -m unittest discover -s tests -v`、`python -m flask --version`（Python 3.13.15、Flask 3.1.1）；尝试 `curl`、解释器内联代码等被允许列表拒绝，属受控能力边界。该 Run 的其他 10 项结论保留，后续需补受限 HTTP 验证能力或调整场景验证前置，不能暗中改判。

通过 [修复 PR #5](https://github.com/cynos-ai/luowang-mp-python-fixture/pull/5) 将欢迎语改为 `你好，<昵称>。`，Python CI 通过后合入 `main`（`47328c32606c7446101f8e1cbf09c17f7c6f817b`），再经 [同步 PR #6](https://github.com/cynos-ai/luowang-mp-python-fixture/pull/6) 和 CI 合入 `scenario-testing`（`c3600561fb3a0b65bcd1c13a4fb35be049b34539`）。应用和执行镜像按修复提交重建；执行镜像为 `sha256:5e713a42431cec7ea4b31b759b7cae1c5a939f908f1d252283108f8a83325770`，`reused=false`。定向队列 `21` / Run `01M3BK39NM6M44Q0VD1QBAPR8Q` 仅复测受影响的 `AUTH-REGISTRATION-001`，固定 `c360056`，Reviewer 判 `passed`，报告归档 `abf6c24b388bd662ea25b05614871a8c4fbdd5d1`，Issue #4 随修复 PR 关闭；旧失败/blocked 报告均保留。修复 Run 有 21 项证据，其中一张截图从 OSS 实际回读 HTTP 200、24964 字节、SHA-256 与登记值一致；Harness 独立核验 1 项 Run 账号清理 `absent=true`。补充真实 HTTP smoke 逐字确认 `/api/auth/status` 的 `displayName` 与注册昵称相同，该补充不冒充 Reviewer 在脱敏记录中未读到的字段原文。此 Run 在本项目 API 返回 200，在官网和 closure fixture 项目 API 均返回 404。

Python 项目三个 Run 的 DeepSeek SDK Session 目录估值依次为约 `0.0357`、`0.1325`、`0.0188` 美元，input/output/cacheRead token 分别为 `96568/59438/1977856`、`480917/86412/14620032`、`80515/20177/683008`；这些是 SDK 估值而非供应商账单。修复 Run 含 Main 规划、Runner、视觉 Reviewer、最终 Main 四个 Session。报告归档后移动中的场景分支再次改变为 `abf6c24`，镜像随固定提交重建为 `sha256:a9f44c1ced7ae757950c955bea4dd415099dbb15dfd03501d136e92b81118d9f`；同一提交再准备返回该精确 image ID 且 `reused=true`。本节点证明了外部 Python 目标的真实构建、运行、修复复测、OSS、Issue/PR、清理和项目归属，但全场景 Run 的 10 个 blocked 以及正式服务器资源检查仍限制 v0.6.1 发布；隔离候选资源暂留用于补齐验证能力，不能将阶段 5/6 整体勾选。

2026-09-25 节点 3 受控 HTTP 验证：针对上述真实 blocked 根因，Runner 增加 `request_test_http` 和 `probe_run_cleanup`，规则固定在同目录 Spec §4.4。前者仅向任务固定 `baseUrl` 的同源路径发有界 GET/POST/DELETE，拒绝自选域名、查询、重定向跟随和任意请求头；命名客户端的 Cookie 各自隔离，仅返回 Cookie 名称。JSON 口令只允许受控占位符，服务端按项目 Secret 或本 Session 合成值替换，并拒绝工具参数中直接出现已知 Secret。后者只访问项目固定清理地址的当前 Run 或固定非法 ID，Token 在服务端注入；DELETE 仅限当前 Run，最终 Harness 收尾仍独立核验。两者的状态、脱敏响应和场景归属写入 Reviewer 可读的 `operation-*.json`，证据保存失败不算已验证；不会开放 curl、任意内联脚本或其他 Run 的读取。Main/Runner 内置角色资源同步说明 HTTP 观察不能代替页面与浏览器 Cookie 证据。

干净 Linux quality 镜像完成类型、lint、格式和完整单测（433 passed、2 skipped），三条浏览器 E2E 通过；本地验收 `local=passed`，其通用 live/release 输入清单未注入该容器，故聚合仍为 `live=blocked、release=blocked`，不与下面独立候选 Run 混同。宿主机的旧 `better-sqlite3` 二进制与当前 Node ABI 不匹配导致两项旧测试无法在 Windows 直接运行，容器内对应完整单测已通过。隔离候选 runtime 在原数据卷上替换启动，旧容器保留回退；旧 Python passed Run、报告提交和归档状态重启后仍可读。

真实复核队列 `22` / Run `01M3BX7A6SQQK8MVW6KZ5S4256` 固定 Python 目标 `abf6c24b388bd662ea25b05614871a8c4fbdd5d1`。Runner 执行 13 个 approved 场景，独立 Reviewer 判 **12 passed、1 blocked、0 failed**，正式报告自动归档在该仓库 `docs/scenario-testing/reports/01M3BX7A6SQQK8MVW6KZ5S4256/`，报告提交 `6d3f87c2f36544eddcf1b78569a454be5cb644c0`。先前因 POST/鉴权请求缺口而 blocked 的注册、登录、删号、存储和清理场景在本轮凭原始 HTTP 与浏览器证据通过；`CLEANUP-SCOPE-001` 记录当前 Run 余量 `6 → DELETE deleted=6、remaining=0 → 独立 GET 0`，非法 ID 返回 400，旧凭据返回 401。唯一 `CLEANUP-SEED-001` 保留 blocked：预置账号在本 Run 清理后仍可登录已证明，但场景还要求比较另一个合法 Run 的余量；当前工具有意不读取其他 Run，不能把固定非法 ID 或预置账号观察冒充这一期望。该阻塞是验证权限边界，不是已确认产品 Bug，原始失败/blocked Run 不改判；`CLEANUP-CONFIG-001` 仍为 draft，未进入本批。

本 Run 有 149 项证据，其中 43 条普通受控 HTTP、25 条当前 Run 清理 HTTP 操作；仅输出计数的模式扫描未发现原始 Bearer Token、`sid` 值或明文 password 字段。OSS 截图实际回读 HTTP 200、20789 字节且 SHA-256 与登记值一致；Harness 在最终 Main 后独立核验 6 项登记账号 `absent=true`。本 Run 在 Python 项目 API 返回 200，另外两个项目均返回 404。四个真实 DeepSeek Session 使用文本 `deepseek-v4-flash` 和视觉 `deepseek-v4-flash-vision-exp`，合计 input/output/cacheRead 为 `327126/71439/6496384` token，SDK 目录估值约 `0.0840` 美元，并非供应商账单。实测 Run 使用本节点最后一项明文参数拒绝加固之前的 runtime；加固后的最终工作树再次在干净 Linux quality 镜像通过类型、lint、格式和完整单测（433 passed、2 skipped），最终 runtime 也已在同一数据卷上替换并健康运行、历史 Run 可读，但没有把旧 Run 记作在最终镜像重跑。下一个节点需决定如何在不读取任意历史 Run 的前提下验证跨 Run 清理不干扰，并补服务器环境检查；在此之前阶段 5/6 仍不整体勾选。

2026-09-25 跨 Run 对照节点：按 Spec §4.4 的“单独受控演练”在现有本机非生产 Python 应用容器执行 `tests/e2e/python-fixture-cross-run-smoke.py`，不扩大 Runner 的其他 Run 读取权限。脚本生成两个互异的合法合成 Run ID，分别通过真实注册接口建号，再用部署级 Token 读实际清理端点：清理前 current/control 余量均为 `1`；只对 current 执行 `DELETE`，返回 `deleted=1、remaining=0`；独立重读为 `current=0、control=1`；最后清理 control 并核验两者余量均为 `0`。本次输出 `passed=true`，current `017QGHP57D21WNDDYQKM8A1HQC`、control `016C6VTNKDVDD5VNRT3JWD46R8`，被测应用镜像 `sha256:0cdaaa527431724d4c5c9d2f1426d897c3d292de9dad566f30e67919170065b1`。脚本只输出 Run ID 和计数，不输出 Token、密码或 Cookie。此证据证明该部署的清理接口没有误删另一个合成 Run；它发生在罗网 Runner/Reviewer 之外，**不能追认或改判**上一轮 `CLEANUP-SEED-001` 的 blocked。后续若要该场景通过，须先确定受控的场景内对照观察方式并重新执行、审核，仍不得开放任意历史 Run 数据。

2026-09-25 场景内对照节点：新增 `verify_run_cleanup_scope`，仅用于应用与清理端点同源、支持固定注册接口的非生产目标。工具自行创建随机合法对照 Run 账号，在同一次调用内比较 `current/control` 清理前后的真实余量，并在 `finally` 中删除对照、独立确认余量 0；模型不能指定任意历史 Run、地址或 Token。缺少当前账号、响应不符、对照清理失败或证据保存失败均不返回 passed，并保留对照 ID 供受控排障。Runner 指令要求本 Run 账号先登记，预置账号在清理后另行登录验证。定向单测覆盖成功、对照收尾及证据失败路径；干净 Linux quality 镜像类型、lint、格式、完整测试 **435 passed / 2 skipped**、三条浏览器 E2E 全通过。`test:acceptance:local` 为 `local=passed`；该容器未注入通用 live/release 输入，聚合显示 `live=blocked、release=blocked`，不替代下面的独立真实 Run。

同一数据卷上的候选 runtime 已替换为本节点镜像并健康运行，旧容器保留回退。Python 定向队列 `23` / Run `01M3C0QRAV0Q3P6QYCBBBX4GX4` 固定目标 `6d3f87c2f36544eddcf1b78569a454be5cb644c0`，只执行 `CLEANUP-SEED-001`。Reviewer 独立读取本 Run 10 项原始操作记录后判 **passed**、无 blocking reason：临时对照 Run `01E5P39W1902R2FHXJAFZVNS99` 与当前 Run 清理前均为 1，当前 Run 清理后为 0、对照仍为 1；工具最后将对照清理并核验为 0；预置账号在此后独立登录 201、会话状态 authenticated。Harness 收尾独立核验 1 项登记账号不存在，报告自动归档至该项目 `scenario-testing` 的提交 `08d5d82a358c507ba29a32646e01674991e1be93`。同项目 Run 详情 200，另外两个项目均 404；旧 blocked 报告不改写。Reviewer 如实保留一项证据强度限制：对照前后两次 GET 的读数保存在单条复合操作记录内，没有两份分立 HTTP 工件；本次 Reviewer 认为该具体且非零的对照足以支持期望。其余 12 个 approved 场景沿用上一轮记录，draft `CLEANUP-CONFIG-001` 未执行。本机 Python 目标的唯一已知 blocked 场景由这次定向复测闭合；正式服务器验收与发布审核仍未完成。

2026-09-25 交替真实 Run 与单项目故障对照：同一本机候选先执行 Node fixture 队列 `24`，再执行 Python 全量队列 `25`、官网队列 `26`；随后执行 Python 定向队列 `27`。三个外部目标分别固定本项目 `scenario-testing` 提交，同名 `AUTH-LOGIN-001`、`AUTH-REGISTRATION-001` 在两个 Node 项目独立判 passed。真实 DeepSeek、浏览器和 OSS 均经正式 Run 链路；官网、fixture 各抽取一张截图以及 Python 全量抽取一张截图，经受认证的项目证据 API 返回 200，字节非空且 SHA-256 与登记值一致。fixture Run 从其他两个项目读取为 404，Python 定向 Run 从其他两个项目读取亦为 404。

| 项目 / 队列 | Run / fixed target | 审核、证据与 Harness 清理 | 归档提交 | SDK 估算成本 USD |
| --- | --- | --- | --- | ---: |
| `luowang-closure7-fixture` / `24` | `01M3C8S9ZFZ6YGRGGVGRH2XRRQ` / `4f870803f4a741af2966f43c7a4b30bda9e6790d` | 2 passed；113 项证据、8 张截图；3 项登记数据独立核验 `absent=true` | `0defd30be3761c7ad8ba66bfd96d65737f54245b` | 0.0656004272 |
| `luowang-mp-python-fixture` / `25` | `01M3C8SY94SMQPT6AY19J1XSS1` / `08d5d82a358c507ba29a32646e01674991e1be93` | 12 passed、`CLEANUP-SEED-001` blocked；148 项证据、4 张截图；7 项登记数据独立核验 `absent=true` | `749c308754d8ede852ed008475e1457a5b781669` | 0.0802254376 |
| `cynos-website` / `26` | `01M3C8YK56YBYMM74RCCDN2MZE` / `b5afe7cf25768179e19fe0589c02e9fb21ae5d7b` | 2 passed；107 项证据、8 张截图；2 项登记数据独立核验 `absent=true` | `c091dab3ab147df3444afba09ef7073796bd961f` | 0.0603360240 |
| `luowang-mp-python-fixture` / `27` | `01M3C9M9WCK4BQ813DQ6MD0VYV` / `749c308754d8ede852ed008475e1457a5b781669` | 仅 `CLEANUP-SEED-001` passed；10 项证据；1 项登记数据独立核验 `absent=true` | `9c864dff252814432d4e1ec7776a60c04eac32ae` | 0.0190577016 |

队列 `25` 的 blocked 记录不改写：该次请求沿用旧跨 Run 观察方式，Reviewer 确认另一合法 Run 的清理余量无法读取，故期望 B 未验证。队列 `27` 使用新增的受控 `verify_run_cleanup_scope` 定向复测并通过；Reviewer 仍标注两次余量读取归并在一条操作记录、缺少两份分立 HTTP 工件的证据粒度限制。四次正式报告均自动发布到各自目标仓库的 `docs/scenario-testing/reports/<run-id>/`，未发现已确认产品 Bug，本轮没有新建 Issue/PR。以上成本合计 USD `0.2252195904`，仅为 SDK catalog 估值，不是供应商账单。

单项目故障对照在 Python 队列 `27` 运行期间，短暂停止隔离的官网非生产应用容器；官网 readiness 的 `environment=failed`，Python Run 仍 completed、passed 且归档。停机时排入官网队列 `28` / Run `01M3C9W5HWF3P7STWB06DR36YX`，固定 target `c091dab3ab147df3444afba09ef7073796bd961f`：两个 UI 场景均 blocked，11 项证据；Reviewer 核对到 5 次浏览器导航报错，原始回执不含具体错误码，也没有可审核截图，因此不从这次 Run 推断产品行为。正式 blocked 报告仍归档至 `5d6542365629c9fa878243a5ec91f4be1df21e0d`；SDK 估算 USD `0.0220389624`。它是受控停机，不是产品 Bug，报告和队列记录均保留。恢复官网容器后健康检查通过；官网、fixture 和 Python 重新准备各自最新报告提交的镜像，五项 readiness 均为 `ok`。本轮所有 Run 标记账号均经 Harness 清理；故障 Run 未创建登记账号。候选容器与隔离数据卷暂留作发布审核和后续复核，故阶段 5 的最终临时资源收尾项暂不勾选；长期 unhealthy 的旧官网清理 sidecar 并非当前项目配置的清理 URL，未把它的状态冒充当前 Run 结果。服务器完整模型/浏览器负载与真实持久旧实例迁移仍未验收。

## 阶段 6：质量检查、文档与发布

- [x] 干净 quality 容器执行完整本地质量与验收，runtime 验证生产原生 MCP 和资源包，禁止依赖宿主机 Node/浏览器差异判定发布质量。
- [x] 在负责人指定的测试服务器以隔离 Compose 部署验证服务到 Docker Engine 的权限、容量、实例标记镜像/容器回收和失联恢复；确认合成项目容器不能获得 Docker API 或罗网主密钥。该机器的资源快照只限定其自身测试范围，不是产品最低配置。
- [x] 更新单仓库限制、配置/API 文档、PROJECT.md 与工作入口，说明 v0.6.1 虽采用负责人指定版本号，但包含接口和数据变化及离线升级要求。
- [x] 文档明确项目镜像解决语言/依赖环境差异，不等于恶意代码安全沙箱；说明项目构建说明、镜像重建/缓存、资源占用和诊断，不把被测应用部署纳入罗网。
- [ ] 汇总迁移、双项目真实验收和残余限制供负责人审核；按 develop → main PR 发布并打 v0.6.1 annotated tag，复核 fixed main/tag 和发布后报告。

完成证明：AC-MP-12；不能修改 v0.6.0 tag 或用新结果改写历史 Run。

2026-09-25 发布审核快照：功能分支 `feat/multi-project` 基于当前 `develop`，远端 `develop` 没有领先提交；上方阶段 5 的交替真实 Run、跨项目 404、受控故障隔离、正式报告及 SDK 成本可以交给 Reviewer 核对。最近一次代码切片在干净 Linux quality 镜像通过 typecheck、lint、format、435 passed / 2 skipped、三条浏览器 E2E 和 `test:acceptance:local`；之后只提交了服务器验收及本轮 live 验收文档，文档再经 Prettier 检查。外部三个目标的 `scenario-testing` 远端 HEAD 分别核验为 `0defd30be3761c7ad8ba66bfd96d65737f54245b`、`9c864dff252814432d4e1ec7776a60c04eac32ae`、`5d6542365629c9fa878243a5ec91f4be1df21e0d`，与本轮最后归档一致。

此快照仍是 **draft review**，不宣称 AC-MP-12 或 v0.6.1 发布通过。通用 `test:acceptance:live` 继续要求首次初始化、两个已确认 Bug/Issue 的 failed Run、blocked Run 等完整 Closure 7 输入；本轮真实多项目 Run 没有确认产品 Bug，不能用正常通过或受控停机报告冒充这些事实，也不能为过门禁制造产品缺陷。`test:acceptance:release` 还需要正式发布后的 `main` 与不可变 tag。测试服务器只有约 4 GiB 总内存且有既有服务，完整模型/浏览器负载尚未在那里运行；真实持久 v0.6.0 实例迁移无现成生产数据源可演练，现有证明是隔离旧库副本。阶段 5 候选实例及卷保留了全部失败/blocked 历史，须在导出或保留策略确定后再清理。下一步先进行 draft PR 审核，并分别补足可执行的 live gate 输入、资源足够的部署验收与候选收尾；上述条件满足后才合入 `develop`，再走 `develop → main` 发布 PR、tag 和发布后核对。

2026-09-25 draft PR 审核中发现并修复报告索引身份冲突：fixture 仓库带有从官网目标复制的历史报告，两个外部仓库共有 **17 个相同的历史报告 Run ID**；罗网自身生成的新 Run ID 仍全局唯一，但旧报告索引把外部仓库的 ID 也当作全局主键，导致 fixture 同步返回 500、归档成功的新报告在索引 API 返回 404。索引主键现改为 `(projectId, runId)`，同项目路径仍唯一，报告读取继续要求明确项目；新增离线 `0017` 迁移和已切换实例专用的 `upgrade-index <新备份目录>`，不改写任何目标 Git 报告或旧 Run 工件。Linux quality 镜像通过格式、lint、类型、构建、**438 passed / 2 skipped** 与三条浏览器 E2E；两个仓库相同历史 ID 的回归及离线备份/幂等回归均通过。

本机隔离候选三项目队列排空后停机，使用新 runtime 的 `upgrade-index` 先将 SQLite 备份到候选数据卷的 `upgrade-backup/report-index-v061-20260925`，再事务性改索引；迁移前 40 份索引报告均保留，`verify` 返回 3 个项目。原 runtime 容器已停止并改名保留，原数据卷和全部历史 Run/失败记录未删除。新 runtime 在同一端口和数据卷健康启动，fixture 首次启动时的一次同步返回临时 502，重试后成功同步 **28 份**报告且 0 索引错误；总索引报告现为 68 份（官网 34、Python 6、fixture 28），外键错误为 0。`01M1GVQWWX89MQZWJW27AGBCDV` 在官网和 fixture 的报告 API 均独立返回 200；fixture 本轮正式 Run `01M3C8S9ZFZ6YGRGGVGRH2XRRQ` 的索引报告也返回 200。此节点没有重跑模型 Run，原审核结论和远端报告均不改判。通用 Closure 7 live/release 门禁、服务器完整负载、正式旧实例迁移及候选资源最终收尾仍待后续。

2026-09-26 多项目 live 门禁节点：新增 `test:acceptance:multi-project-live`，使用受控本地清单只读检查本机候选的三个项目、五个历史 Run。队列固定 target、Run/索引场景结果、自动归档提交均与清单一致；20 张截图经项目 Evidence Gateway 回读，字节数和 SHA-256 与登记值一致；13 项 Harness 清理回执为 `absent=true`。五份报告在各自 GitHub 仓库的发布提交中存在，正文与项目索引完全相同；每个 Run 在另外两个项目的详情和报告路由均为 404。官网队列 28 和 Python 队列 25 仍按原样 blocked，Python 队列 27 的定向复测 passed；受控官网停机不计为产品 Bug。此脚本没有生成新 Run 或改写历史，只证明列出的多项目历史事实；通用 Closure 7 live/release、正式旧实例迁移、服务器完整模型/浏览器负载和候选资源收尾仍未完成。

阶段 6 文档节点：README 的当前操作说明已与项目 App、离线升级 CLI 和 Compose 对齐，区分已发布 v0.6.0 与开发中的 v0.6.1，列出部署/项目 API 归属、paused 接入、镜像准备、固定提交重建、容量及清理要求。PROJECT.md、默认布局和 AGENTS.md 同步注明多项目 Spec 覆盖历史单仓库基线；历史需求和旧 Run 记录不改写。此节点只完成文档项，不代表生产 Docker Engine 权限或真实双项目验收已通过。

本机 Docker Desktop 28.3.3 的真实 smoke 已验证两项项目镜像构建和固定提交 Run 命令；新增检查直接读取实际容器配置，确认无挂载、无 Docker socket/罗网数据库、非 privileged，且服务进程中的合成主密钥没有进入项目容器。模拟 Engine 地址失联后，受控入口拒绝创建新 Run 容器，不回退到宿主机命令；恢复连接后按 Run 标签查询无遗留容器。`docker system df` 的只读快照显示本机镜像总量 166.6 GB、构建缓存 19.22 GB，说明正式部署须预留容量并按归属清理，未对共享 Engine 执行全局 prune。这是本机开发环境的真实 Docker 证明；尚未验证服务器 Compose 的 socket 权限、容量策略及实际进程重启清理，因此正式部署形态验收项仍未勾选。

同一工作树构建的干净 Linux quality 镜像通过类型、lint、格式检查、419 项测试（Docker 专项 2 项默认跳过）、三个 UI E2E 和 `test:acceptance:local`；聚合结果为 `local=passed`、`live=blocked`、`release=blocked`，外部双项目输入仍未配齐。真实 Docker 专项另在本机 Engine 显式开启并通过。2026-09-24 使用构建参数 `DEBIAN_MIRROR=http://mirrors.ustc.edu.cn/debian`、`DEBIAN_SECURITY_MIRROR=http://mirrors.ustc.edu.cn/debian-security` 成功构建生产 runtime 镜像 `sha256:2ef6d228df5f2027ef20386faf38ad1e1d7da908579088fb911af3b7ebedc61c`；Debian 包仍由 apt 校验签名。最终镜像以 `node` 用户运行，包含 Docker CLI、编译后的服务和内置角色资源；角色加载器成功读取 Main 规划、Runner、Reviewer、Main 收尾及初始化所需资源并生成哈希。按 `scripts/run-browser-sandbox.sh` 的只读、非 root、tmpfs 等约束运行零模型原生 MCP 预检，结果 `status=passed`、`modelRequests=0`，覆盖工具边界、本地导航、快照、截图及 Session 释放。这完成了本地质量与 runtime 预检项；服务器 Compose 权限和真实双项目 live 验收仍未完成。

本机 Compose 部署演练使用上述 runtime 镜像、独立 Compose 项目和临时数据卷：按文档完成空库备份、离线升级与 `verify`，服务健康接口返回 200。服务进程为 `uid=1000(node)`，通过附加 `gid=0` 访问权限为 `660` 的 Docker socket，能连接 Docker Desktop Engine 28.3.3。通过服务容器的 Docker CLI 创建两只带不同实例标签的合成运行容器；重启后本实例容器被清理，另一实例容器保留。被测容器无挂载，环境中没有罗网主密钥、管理员密码或 Docker endpoint。再构建一张本实例标签的未引用空镜像，重启后回收日志记录 `removedImages=1`；模拟 Engine 地址失联时受控适配器返回失败，恢复原 socket 后可再次连接。只读容量快照显示镜像 173.7 GB、卷 49.42 GB、构建缓存 21.47 GB；未对共享 Engine 执行全局 prune。演练结束已删除临时容器、Compose 卷与网络及测试密钥。此证明限于本机 Docker Desktop；服务器 socket 组、磁盘配额和实际部署回收仍需在目标环境复核，因此正式部署形态验收项继续保留未完成。

2026-09-25 服务器部署形态节点：使用负责人提供的测试机资料，以 `sj` 账号和单独固定的当前 SSH 主机密钥连接；本机旧 `known_hosts` 未改，口令未写入仓库、命令参数或报告。服务器为 Linux 6.8、Docker Engine 29.5.3 / Compose 5.1.4；`sj` 属于 `docker` 组，socket 权限 `660 root:docker`。服务器原有 3 个 `agentteams` 容器保持运行，未停止或改动。初始 Docker 所在分区约 16.3 GiB 可用，运行内存约 1.1–1.5 GiB 可用；由于同机服务占用和总内存仅约 4 GiB，本节点只做部署形态和确定性回收验收，**未在服务器执行完整模型/浏览器联合负载**，也不把本机真实 Run 记为服务器 Run。

已在本机通过质量检查的 runtime 镜像以流式传输加载到服务器，不在服务器构建依赖镜像；加载后分区约 13.9 GiB 可用。独立 Compose 项目 `lw-v061-51eede` 使用随机临时管理员/主密钥、独立数据卷、只监听 `127.0.0.1:47823` 的端口与本机 Docker socket：按文档完成基础迁移、空库备份、`upgrade-empty` 和 `verify`，服务健康且 HTTP `/health` 返回 200。服务以 `node` 用户运行，通过 socket 组在容器内读取同一 Engine 版本。合成 paused 项目绑定该隔离数据库后，创建本实例和另一实例标记的两个容器及本实例未引用的空镜像；重启服务后，本实例容器和空镜像被回收，另一实例容器保留。项目容器检查为 `mounts=0`、`privileged=false`，无 Docker endpoint、罗网主密钥或管理员密码。把单次 Docker 命令的 Engine 地址指向不存在的 socket 时明确失败，恢复原地址后再次连通。上述检查不依赖模型调用或被测应用，不证明完整 live 联合负载。

验收结束按项目名精确停止并删除该 Compose 项目及独立卷、临时 Secret 文件、合成项目容器和传入的 runtime 镜像；未运行全局 prune，未触碰原有 `agentteams` 容器。清理后仅原 3 个服务仍运行，磁盘可用量回到约 16.3 GiB。服务器部署形态项据此完成；阶段 5 的完整交替真实联合验收、真实旧实例迁移和阶段 6 的合并发布仍保留未完成。

2026-09-26 验收环境说明（覆盖上方历史快照中“服务器完整负载是发布前提”的表述）：负责人明确这台服务器只用于测试，其配置不代表罗网支持的服务器规格。只读复查时，该机 3911 MiB 总内存、1573 MiB 可用内存、2696 MiB 空闲 swap、Docker 分区约 17.2 GiB 可用，另有 3 个既存 `agentteams` 容器；无罗网容器运行。此前在此机完成的是隔离 Compose、Docker 权限、容量观察与资源回收，未运行完整模型/浏览器 Run。完整多项目 DeepSeek、浏览器、OSS、清理和归档联合路径已经在本机隔离候选上执行，并由独立只读多项目 live 门禁复核；CI 另验证生产 runtime 镜像与零模型原生浏览器 MCP。发布审核应逐项检查这些已取得的事实和未闭合的通用 live/release 条件，不再要求把同一负载重复放到这台受现有服务挤占的测试机上才能合并。未来部署的 CPU、内存和磁盘需求需按实际项目镜像、浏览器并发、构建缓存及其他同机服务测量，不从这台机器的一次余量反推固定最低值。测试机上的完整负载仍是未运行，不写成通过。

2026-09-26 本机候选收尾：再次运行 `test:acceptance:multi-project-live` 的受控 launcher，三项目、五个代表 Run、20 张截图 SHA-256、13 项清理回执、各项目远端报告正文及跨项目 404 均通过；三个项目队列无 queued/running/waiting_archive 项，历史失败和 blocked 项保持原样。停止 `luowang-mp-harness-4d420840` 后，将其专属 `luowang-mp-live-data-4d420840` 卷只读打包到 Git 忽略的本机 `.cynos/multi-project-live/backups/candidate-20260926/luowang-mp-live-data.tar`。备份大小 26,920,960 字节，SHA-256 为 `9a8e7488ff31fdb692c8a98a543d4b6c4e62208f5ce635167a417530c4c89666`；重新计算哈希，并在临时目录完整解包且确认有文件。该备份含受控实例数据和 Secret，只留本机，不提交仓库或公开分发。

已按精确名称移除本轮隔离候选的 15 个 Harness/目标应用容器，包括此前 unhealthy、已不在当前配置中使用的旧官网清理 sidecar；移除仅属于本轮候选的 `luowang-mp-live-4d420840` 网络。原始 `luowang-mp-live-data-4d420840` 和官网合成测试数据卷 `luowang-mp-site-data-4d420840` 仍保留，候选镜像也未删除，以便发布审核期间回退或重查；因此“临时容器/网络收尾完成”不等于所有本地镜像和卷已删除。未执行全局 Docker prune，未触碰其他工作负载，外部三个目标仓库的正式报告和所有失败/blocked 历史也未改写。此节点不新增模型 Run，不改变通用 Closure 7 live/release、真实持久旧实例迁移及最终发布审核仍待闭合的状态。

## 提交与范围控制

实现分支从 v0.6.0 发布后的最新 develop 创建 `feat/multi-project`。各阶段通过对应检查后提交并 push，跨层改造未通过整体检查前不合入 develop。数据库、服务、调度和 UI 可以分提交 review，但不能以部分页面可用宣称多项目已完成。

外部异构非生产测试仓库已按负责人后续授权建立；隔离候选仍不直接迁移真实持久实例。每个代码切片按质量检查结果独立 push，正式发布仍需处理上文 blocked 场景与服务器验收。
