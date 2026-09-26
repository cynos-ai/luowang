# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。v0.6.1 支持同一管理员管理多个 GitHub 项目，项目数据、凭据、任务、证据和执行镜像分别归属。两个 Node 目标及一个 Python 目标已完成交替真实 Run 和故障隔离，历史持久测试实例副本已完成升级与回退验收。正式版本见 [GitHub Releases](https://github.com/cynos-ai/luowang/releases)。

v0.6.0 加入随版本维护的代码深读方法：Main 追踪业务规则与相关调用，并在计划中引用固定版本的读取回执；Reviewer 可以核对引用来源和阅读范围。回执只说明材料返回过，模型是否理解正确仍需单独评测。[实施与验收记录](docs/changes/luowang-code-understanding/plan.md)保留完整过程；多项目的功能边界与验收结果见[多项目计划](docs/changes/luowang-multi-project/plan.md)。

v0.6.1 虽使用补丁版本号，仍包含数据库与 HTTP 接口变化；部署前必须完成离线升级，旧的无项目 ID 业务 API 不继续兼容。这个编号不表示向后兼容。

## 本地启动

优先使用下文的 Docker Compose 或固定 quality/runtime 镜像复现。原生运行需要 Node.js 24 和 npm；当 `better-sqlite3` 没有匹配的预编译包时，还需要 `python3`、`make` 和 `g++`。v0.6.1 的启动入口只接受已完成离线升级的数据库，不会自动迁移旧实例或创建空库。以下命令仅用于开发或已升级的隔离实例；真实旧实例应使用正式发布版本，按[多项目升级计划](docs/changes/luowang-multi-project/plan.md)执行备份、归属核对与离线升级。

```bash
npm ci
npm run build
npm start
```

默认只监听 `127.0.0.1:3000`。打开 <http://127.0.0.1:3000/> 可查看控制台，健康检查地址为 <http://127.0.0.1:3000/health>。数据默认保存在 `/data`；本地开发可以设置 `LUOWANG_DATA_DIR` 到可写目录。执行 `npm run dev` 可以同时启动 Vite 和开发服务器。

也可以使用 Docker Compose：

```bash
# 首次准备测试数据卷前必须设置这两个值；不要把真实值提交到 Git。
export LUOWANG_ADMIN_PASSWORD='replace-with-a-long-random-password'
export LUOWANG_MASTER_KEY='replace-with-a-long-random-master-key'
# Linux 主机若 Docker socket 不属于 root 组，设置 LUOWANG_DOCKER_GID 为 stat -c '%g' /var/run/docker.sock 的结果。
docker compose build
docker compose run --rm --no-deps luowang npm run db:migrate
docker compose run --rm --no-deps luowang npm run db:multi-project -- backup /data/upgrade-backup
docker compose run --rm --no-deps luowang npm run db:multi-project -- upgrade-empty /data/upgrade-backup
docker compose run --rm --no-deps luowang npm run db:multi-project -- verify
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
docker compose down
```

Compose 将数据保存到 `luowang-data` 卷，并把宿主机端口绑定到 `127.0.0.1`。管理员密码只在空数据库首次启动时读取；主密钥只用于进程内派生 Secret Store 密钥，二者都不会写入 SQLite。

## 验收状态

截至 2026-09-22，修复候选 `0c696f0` 已完成 normal、defect、blocked 三例复验，结果分别为 `passed`、`failed`、`blocked`；归档、清理、截图读取和远端工件核对均完成。负责人随后批准在测试项目中补齐第二条 Issue。双缺陷 Run `01M342XE5V39VTB8AQSSARMMFC` 使用四个隔离 Session 和 80 次模型请求，确认退出未撤销 Session 与删除接口虚假成功两项独立问题；Archiver 成功关联既有 Issue [#5](https://github.com/cynos-ai/cynos-website/issues/5)，并创建新 Issue [#12](https://github.com/cynos-ai/cynos-website/issues/12)。报告提交 `f4800046e7797109527371504d97f778926ca957` 只新增该 Run 的 report/review，本地与 Git blob 一致；4 张截图保持页面现场，清理后 users=0、sessions=0。这个 Run 已补齐“双 Bug、双 Issue”的单项事实。

正式 Closure 7 已切换到独立公开仓库 [`cynos-ai/luowang-closure7-fixture`](https://github.com/cynos-ai/luowang-closure7-fixture)，并在同一个持久候选实例完成首次 initialization。队列从 `main@6405a45b6889ad92cf7cfbce12d8ec22b5040f23` 以 `manual-merge-source + initialization=true` 创建原先不存在的 `scenario-testing`，prepared、resolved 和 target commit 均固定为该提交。Run `01M348D1DVD9S0J9YTJ6Y8JTSB` 按 Main · 规划 → Runner → Main · 规划 → Runner → Reviewer → Main · 最终汇总创建六个隔离 Session，结果为 `passed`，场景进度为 `1/1`。

本轮共使用 152/180 次模型请求，其中 `deepseek-v4-flash` 137 次、`deepseek-v4-flash-vision-exp` 15 次；全部取得 HTTP 200 且响应流完整。Reviewer 实际读取 9 张截图，表单保留合成邮箱，密码保持掩码，没有为截图清空、覆盖或遮挡字段。测试数据独立查询为 remaining=0，目标数据库停止前 users=0、sessions=0。归档提交 [`2c4684c`](https://github.com/cynos-ai/luowang-closure7-fixture/commit/2c4684c50a58cf7728041b4cba50ca46b54d6723) 的父提交是固定 source，只新增该 Run 的 report/review，两份远端文件与本地工件逐字节一致。

同一实例随后完成普通 existing-branch merge-source Run `01M34GE6SGXEQZYHN3Y4HMW4BX`。目标仓库 `main` 只澄清“刷新继续使用原 Session，恢复资料与登录响应一致”，队列生成 merge commit `6a07377`，其两个父提交分别为上一归档 HEAD `2c4684c` 和 source `ef468e7`。Run 使用 Main · 规划、Runner、Reviewer、Main · 最终汇总四个隔离 Session，结果为 `passed`，进度为 `1/1`；110/180 次模型请求全部 HTTP 200 且响应流完整。

Reviewer 读取 7 张截图和原始浏览器证据，确认登录与刷新使用同一 Session、退出后旧 Session 返回 401、删除后旧 Session 和原凭据均失效。逐图核对确认表单现场保留，最后一张含合成邮箱和掩码密码。测试数据独立查询为 remaining=0，目标数据库停止前 users=0、sessions=0。归档提交 [`e09b0f3`](https://github.com/cynos-ai/luowang-closure7-fixture/commit/e09b0f377d1414fa3da2c65bcbbc2406421dec4d) 只新增该 Run 的 report/review，两份远端文件与本地工件逐字节一致。

同一实例的双缺陷 Run `01M34KTXNGH0M305H03PBYHMPB` 随后以 `failed` 完成。Reviewer 独立确认退出不撤销服务端 Session、删除接口返回成功但账号与 Session 仍可用；Archiver 在 fixture 仓库创建 Issue [#1](https://github.com/cynos-ai/luowang-closure7-fixture/issues/1) 和 [#2](https://github.com/cynos-ai/luowang-closure7-fixture/issues/2)。89/300 次模型请求全部 HTTP 200 且响应流完整；4 张截图、清理和远端归档均已核对。归档提交 [`ca5839b`](https://github.com/cynos-ai/luowang-closure7-fixture/commit/ca5839b97713aba1fb556c17a0ce458414d21001) 只新增当前 Run 的 report/review。

该轮驱动的最后一道内存断言误读了已落入 SQLite 的 Bug/Issue 字段，因此退出码为 1，原 `valid=false` 记录保留。独立数据库核对确认两个不同 bug key、两个 `succeeded` Issue 动作、四 Session、归档和清理全部成立，没有重跑或改写原 Run。Closure 7 的 initialization、普通 passed 和双缺陷 failed 已留在同一持久实例；整体 live/release 仍为 blocked，剩余 blocked Run、三 Session 场景审核 PR、PR 合并后的 `manual-current-head` passed 重测及最终检查。完整记录见 [证据完整性计划](docs/changes/luowang-evidence-completeness/plan.md#closure-7-双缺陷-failed-run2026-09-22)。

同一实例的受控依赖 Run `01M34MZ8NNP1CJTAHZAF5XN0PQ` 已以 `blocked` 完成。Reviewer 对 8 份 operation 证据的读取均遇到受控依赖停止，只保留页面能够直接支持的 A、B 两项；需要关联原 Cookie、请求头和响应的 C、D 两项保持 blocked。Run 没有 confirmed Bug，也没有创建或关联 Issue，队列归档完成且 `progressed=false`。79/180 次模型请求全部 HTTP 200、响应流完整；清理后 remaining=0，目标数据库 users=0、sessions=0。

归档提交 [`3d32c2a`](https://github.com/cynos-ai/luowang-closure7-fixture/commit/3d32c2a72f79f35c29bc7e51b8c8c6df87254e1a) 只新增该 Run 的 report/review，两份远端文件与本地工件逐字节一致。最终截图保留合成邮箱和掩码密码，登录被拒状态清楚可见。驱动最后用 `runs.get()` 上未暴露的 `scenarioResults` 做断言，因此原验证文件仍为 `valid=false`；SQLite 权威记录含一条 `AUTH-LOGIN-001=blocked`，独立核对通过，没有重跑或改写历史 Run。Closure 7 现在还缺三 Session 场景审核 PR、合并后的 current-head passed 重测和最终 live/release 检查。

后续工作仍复用同一数据库。三 Session Run `01M34P70YXB7VR1R5K94Z4CBJS` 以 `blocked` 结束，只交付 `scenario-changes.patch` 和 Harness `report.md`；场景 PR [#3](https://github.com/cynos-ai/luowang-closure7-fixture/pull/3) 通过 CI 后合并为 `f287add3d4054491f2ed5714cbb044a38a133f50`，新增的 `AUTH-ORIGIN-001` 保持 draft。最终 current-head Run `01M34RAG4DRS860QH6S9BHR95W` 固定该 merge commit，使用 Main、Runner、Reviewer、Main 四个隔离 Session，88/180 次模型请求全部成功，`AUTH-LOGIN-001` 为 passed。7 张截图已逐张检查；三张填写态保留合成邮箱和掩码密码，刷新、退出、删除和旧凭据拒绝状态与报告一致。清理后 remaining=0、users=0、sessions=0，归档提交为 [`ab3d738`](https://github.com/cynos-ai/luowang-closure7-fixture/commit/ab3d738a5af8fe59e1bf9ba3094c2896f0d10174)。

正式验收恢复生产服务时，数据库中两个曾被外部披露扫描拦下、但仍处于待归档状态的 passed 队列被正常续跑，生成 `626e608` 和 `fa350375`。其中一个旧 `review.md` 含已删除合成账号的邮箱；修正 PR [#4](https://github.com/cynos-ai/luowang-closure7-fixture/pull/4) 只把这一处替换为 `[REDACTED]`，CI 通过后以 `fa6242b3105f1c01d7b82f363d145aca7e25ba16` 合并。最终正式报告在该 HEAD 上得到 `local=passed`、`live=passed`、`release=passed`，42 条命令零失败；Provider、Playwright MCP、私有 OSS、GitHub 和非生产应用连接均为 ok，Indexer 与 GitHub HEAD 一致，Secret 值扫描无命中。`AC-CLOSURE-RELEASE-01` 仍为 blocked，因为本轮没有发布新的 SemVer tag；这不影响发布前验收链已经通过。

以下按发生顺序保留验证过程，其中“待完成”描述当时状态。

统一定向流程已通过五例离线检查。Reviewer 曾漏写审核，随后成功交付但仍把缺少原 Session 请求关联的场景判 passed。修正后的负例用 5/30 次请求正确判 blocked。2026-09-21 补齐删除证据的正向对照用 8/30 次请求通过：同一 Reviewer 指令保留了合成功能通过的结论，同时指出进度补报与错误归属，未外推为官网通过。披露声明对照随后用 5/30 次请求通过，Reviewer 正确指出单文件公开常量扫描不能证明全部凭据及截图安全；报告仍有一处无依据的问题标题，单列质量瑕疵。首次正向对照因材料缺口仍保留无结论；Runner 随后用 13/30 次请求通过公开常量省略及两条合成命令时序验证，写入前后均未复述常量；截图稳定状态案例随后用 21/30 次请求完成：最终图片的输入框为空，但 execution 又复述两个合成字段值并声称未记录，独立评估判失败；后续案例停止。真实浏览器多场景、截图处理与披露仍未整体验收，整体状态保持 blocked。

截图需求已调整为保持取证现场：禁止为截图清空/覆盖表单或隐去待验证内容。新 [截图采集完整性计划](docs/changes/luowang-screenshot-capture-integrity/plan.md) 已将旧拒绝补丁替换为正常采集加检测标签，标签与图片哈希绑定，贯通证据工具、控制台和最终报告；保留自动归档、人工事后审核，不新增发布门禁。字段检测失败标为 unknown，实际截图错误仍保留。不做旧补丁兼容，须从干净依赖构建。填写前登记及脱敏填写记录已接入两种 MCP 入口；导航快照已关联实际操作并在上传前登记、脱敏，证据类别预检及运行时检查也已接入。模型记录精度指令已修订，[六例输入及驱动](docs/changes/luowang-evidence-completeness/plan.md) 已冻结并通过零模型预检；第二轮来源正反例通过，但时间正例出现给 Runner 补写判定的问题；第三轮首例又发现 Reviewer 漏读 execution.md 仍能提交审核，已在 7/120 次请求后停止。现已补上提交前成功读取执行工件的检查。第四轮 SOURCE-P 通过，SOURCE-N 的 Reviewer 也正确区分了 Runner 与自身观察，但最终 Main 把 Reviewer 已作出的适用性判断改归自己，本轮在 16/120 次请求后按约定停止；其余时间与计数案例未运行。现已收紧最终汇总的来源保留规则，各轮原始输出和失败结论保留。第五轮 SOURCE-P 的来源归属正确，但最终 Main 同时列出唯一浏览器证据并声称证据列表为空，本轮在 9/120 次请求后停止；其余五例未运行。现已补充证据清单数量、类别与操作归属分开表达的规则。第六轮和第七轮都在首个 Reviewer 请求取得 HTTP 状态前失败，各使用 1/120 次后停止，没有模型交付或语义结果；第七轮证明最早的传输停止原因不会再被覆盖。第八轮 SOURCE-P、SOURCE-N、TIME-P 均通过，证明来源、证据清单和合成时间换算修订已在这三个案例中生效；TIME-N 的首个 Reviewer 请求在建立上游连接时失败，驱动准确记录 `failureCategory=upstream-connect`，整轮按约定在 30/120 次停止，COUNT-P/N 未运行。第九轮复用逐字节相同的候选与案例，首个 SOURCE-P Reviewer 请求再次记录 `upstream-connect`，在 1/120 次后停止，没有工具调用、review/report 或语义结果，其余五例未运行。连接阶段分类已连续获得实证，但六例语义验收仍未完成，humanScoring=not_run，整体 live/release 继续 blocked。

第九轮后的无凭据容器诊断确认：`api.deepseek.com` 的 DNS 和 TCP 443 正常，TLS 因当前开发机的本地 HTTPS 拦截返回 `SELF_SIGNED_CERT_IN_CHAIN`；容器没有代理、额外 CA 或关闭证书校验的配置。这是本地评估环境阻塞，不是罗网或服务器部署缺陷。评估驱动现将 DNS、TLS、超时和普通连接失败分开记录为固定类别，不保存错误消息、证书或请求内容。定向 19 项测试及完整本地验收通过；生产代码和服务器部署继续执行标准 TLS 校验，不为 DeepSeek 域名增加跳过校验或额外信任。后续模型复验应换到没有本地 HTTPS 拦截的服务器或干净网络环境，并单独批准新轮预算。

负责人随后批准第十轮并要求先用本机继续；同一容器路径已恢复为 TLS `authorized=true`，无鉴权请求返回 401。新轮 SOURCE-P、SOURCE-N 通过；TIME-P 的 Reviewer 正确换算合成时间并保留服务器时钟未校准的限制，但最终 Main 把“不代表真实产品执行”误写为“为代表真实产品执行”，本轮在 29/120 次后按规则停止，TIME-N 与 COUNT-P/N 未运行。现已要求最终汇总在落盘前保留范围否定和限定关系，并检查报告内部矛盾；定向 40 项及完整 40 文件 / 309 项本地测试通过，修订后的模型复验尚未运行。

第十一轮在同一标准 TLS 路径完成六例复验，12 个隔离 Session 共使用 50/120 次请求，SOURCE-P、SOURCE-N、TIME-P、TIME-N、COUNT-P、COUNT-N 全部通过独立工件核对。TIME-P 正确保留 `2026-09-21T00:00:01.250Z` 的合成时钟依据及“不代表官网执行、不证明真实服务器时钟”的限制；COUNT 两例都保留一个场景内的 3 项 confirmed + 1 项 unverified，负例还指出 Runner 摘要与明细冲突。Writer 原始输入与落盘工件哈希一致，score 绑定 result、sessions 和工件哈希。该六例模型语义验证已完成；`humanScoring=not_run`，完整外部联合验收与正式发布状态仍为 blocked。

内联快照现会把明确的文本字段值登记到本 Run 脱敏集合，返回文本、受控快照正文和后续 execution 复用同一保护；只有时序的回执明确标示不含页面正文。格式或登记失败不回传原始结果。两个真实 MCP 入口及完整本地验收通过（37 文件 / 273 测试）；保护限于已解析字段，模型复验尚未运行，原失败记录和 blocked 状态保留。

v0.4.0 的固定提交 Quality CI 已通过，真实非生产样本已检出注入的会话缺陷；该发布轮的正常样本仍因重放证据不可供独立审核而 blocked（[#68](https://github.com/cynos-ai/luowang/issues/68)）。场景进度时序（[#64](https://github.com/cynos-ai/luowang/issues/64)）和执行记录披露（[#65](https://github.com/cynos-ai/luowang/issues/65)）也仍有待复验，独立人工质量评分未完成。这些结果不表示全站、当前部署或总体模型质量已验收。后续修复与实际验证结果见 [实施计划](docs/changes/luowang-run-evidence-followup/plan.md)；代码修复不会改写旧 Run 的结论。

2026-09-19 修复候选的正常样本已通过：Reviewer 独立读取了原 Cookie 与实际请求头的关联证据，四个隔离 Session 完成，操作与场景进度顺序可核对。本轮在 155/400 次模型请求时因 GitHub 归档推送 403 停止；缺陷样本中断，证据受阻样本未运行，整体 live/release 仍 blocked。测试数据已清空、临时环境已撤销；截图仍有合成账号标识，披露要求尚未全部满足。

后续已使用现有 GitHub CLI 登录凭据完成正常 Run 的幂等归档，报告提交为 [`5c0b294`](https://github.com/cynos-ai/cynos-website/commit/5c0b294d88726ee35f4ed2abb1be45f90f5c54f8)，仅新增本 Run 两份报告，内容与本地一致，没有新增模型请求。项目 `.env` Token 的写入权限仍未修复；缺陷与证据受阻验收仍待完成。

第二轮已实际使用 `deepseek-v4-flash`，共 81/300 次请求：缺陷样本检出问题，但因浏览器操作证据缺失最终 blocked，报告已归档；证据受阻样本在模型调用前失败，未形成业务结论。随后修复了 `mcp__playwright` 入口漏记证据的问题，quality 容器 254 项测试及格式、lint、类型检查、构建通过；尚未用模型复验该修复。两套沙箱已清空并撤销，截图披露、受阻样本与整体 live/release 验收仍未完成。

2026-09-20 后续样本已通过启动准备，但规划未启用执行所需 MCP，未实际验证登录场景；Reviewer 判为 blocked，最终 Main 未生成报告，Run 为 failed。39/300 次模型请求后按约定停止，受阻样本未启动，环境已清理。已补充规划工具能力说明及 blocked 报告交付要求，定向验证结果见下文；不据此宣称真实验收通过。

随后两项定向模型验证使用 14/40 次请求通过：Main 正确声明 MCP 需要并保留页面观察，最终 Main 成功写出可解析的 blocked 报告。验证仅使用独立 Session 和工件副本，未执行完整场景或修复原 Run；完整四 Session 的缺陷与证据受阻验收仍待完成。

第五轮已将新角色指令固化进已验证 runtime，启动预检通过；实际在 Main 规划阶段因缺少 plan.md 停止。代理记录 16/300 次请求尝试，前 4 次 HTTP 200，后 12 次未取得上游响应状态，具体传输原因未保存，不能直接归因为模型漏写。Runner 和受阻样本均未启动，无报告归档；两套测试库清空、环境撤销。已用零模型故障测试验证独立传输诊断 helper，尚待接入新驱动；整体验收仍 blocked。

后续已将传输失败停止机制接入新验收驱动，并让生产适配器区分 Pi 异常结束与正常结束后漏写工件。真实 SDK 的本地失败回归及 quality 容器 258 项测试、格式、lint、类型检查和构建通过，没有新增外部模型请求。一次无认证 HEAD 确认容器到模型源站可达，不代表推理验证通过；新的完整业务验收尚未启动。

第六轮使用新 runtime，80/300 次请求后停止：缺陷样例完成四个 Session，捕获 44 条浏览器操作，Reviewer 独立确认非生产沙箱中注入的退出会话缺陷，最终报告成功交付。证据读取曾失败 8 次，随后成功读取的 61 次哈希核验一致，历史失败仍令整体 blocked。execution.md 和原截图仍含合成账号，Git 归档被拦住，受阻样本未启动；测试数据及环境已清理。后续零模型读取 47 份命令对象全部成功，只证明当前可读，不改变原 Run 结论。

后续工程修复已为命令/浏览器记录读取失败增加受控文件名、耗时和固定错误类别，并在 execution.md 写入前复用已知 Secret 与运行时敏感值脱敏；脱敏不可用时拒绝落盘。quality 容器 267 项测试及格式、lint、类型检查、构建通过，无新增模型请求。截图和任意敏感片段仍有缺口，历史证据与整体验收状态不变。

截图工具现会在生成图片前拒绝含可见非空文本字段的页面，不自动清空表单或修改原图。真实 MCP 的本地合成页面回归及 quality 容器 268 项测试、格式、lint、类型检查、构建通过，无新增模型请求。检查较保守，普通正文中的账号和动态页面变化仍需审核；历史截图及整体 blocked 状态不变。

随后单次证据受阻样例使用 78/150 次请求完成四个 Session：Reviewer 实际遇到 20 次注入的读取失败，最终报告保持 blocked，无 confirmed Bug、不推进目标。已知凭据/账号的 Markdown 精确扫描无命中，报告已归档至 [`71007f3`](https://github.com/cynos-ai/cynos-website/commit/71007f3e97c25b5dad2b43e47d496630eab106e9)，远端字节一致、重复归档幂等；测试数据和环境已清理。本轮没有 PNG，不能据此证明真实模型截图安全；整体发布验收及人工评分仍未完成。

验收命令按证明范围严格分层：

```bash
# 无外部凭据；真实经过 Pi SDK Session 和本地模型协议服务。兼容别名 npm run test:acceptance 也只指向 local。
npm run test:acceptance:local

# 真实外部联合验收；缺少任一必需输入时列出 missing 名称并非零退出。
npm run test:acceptance:live

# v0.6.1 多项目历史 live 事实复核；需设置下面三个环境变量。
npm run test:acceptance:multi-project-live

# 先执行公共质量与 local，再执行 live；live blocked/failed 时非零退出。
npm run test:acceptance:release
```

`local` 使用临时 Git bare 仓库、样例应用、SQLite、队列、归档、headless Chromium 和本地可控模型协议服务；Agent 流程真实调用生产 `createAgentSession()`，但本地 test double 只能证明 `local.status=passed`。报告保存在 `.cynos/acceptance/<timestamp>-<mode>/`，分别记录 `local.status`、`live.status`、`release.status`、资源检查、逐 AC 证据和命令。CI 只运行 local，并明确不读取 live Secret。

`test:acceptance:live` 在 39 项安全/授权输入齐全后，连接候选实例（默认 `http://127.0.0.1:3000`，可用 `LUOWANG_LIVE_HARNESS_URL` 覆盖）。其中 `LUOWANG_LIVE_PROJECT_ID` 必须是承载这组 Closure 7 事实的项目 ID；脚本先核对该项目绑定的 `LUOWANG_LIVE_REPOSITORY`，再只读复核已经完成的真实验收事实：首次分支创建的 prepared/resolved 与唯一 Run、带截图和独立清理确认的 passed Run、双 Bug/Issue failed Run、不推进的 blocked Run、场景 PR、当前 HEAD 重测、Indexer 回读、实时活动、私有 Evidence Gateway、GitHub PR/Issues 及 Secret 值扫描。项目就绪、队列、Run、证据、场景和报告均通过项目 API 查询；任何事实缺失或资源检查失败都会令 `live.status` 为 failed，live 未通过时 `release.status` 必须保持 blocked/failed。它不会用输入齐全或有限 smoke 冒充通过。

开发中的多项目门禁 `test:acceptance:multi-project-live` 读取 `LUOWANG_MP_LIVE_MANIFEST` 指向的本地 JSON 清单、`LUOWANG_MP_LIVE_HARNESS_URL` 和 `LUOWANG_ADMIN_PASSWORD`。清单至少列两个不同项目，各项目提供 `projectId`、公开 GitHub `repository`（`owner/name`）及 `runs`；每个 Run 提供 `queueId`、`runId`、`targetCommit`、`reportCommit`、预期 `result`、`scenarios` 结果、`minScreenshots` 和 `minCleanup`。它只读核对队列与 Run 的固定提交、归档状态、同名场景、截图原件哈希、Harness 清理回执、GitHub 报告正文和其他项目的 404；缺少输入时返回 blocked。清单与密码由操作者保存在受控目录，脚本只输出项目、Run、提交和计数摘要。该入口只证明列出的多项目历史事实，不替代旧 Closure 7 门禁的 Bug/Issue 条件，也不证明发布后的 release/tag、正式旧实例迁移或测试服务器完整负载。

可选的 GitHub smoke 仍只用于单独诊断仓库读取路径，不属于 live 或 release 证明。它不会默认执行；如需运行，必须显式提供 `LUOWANG_ACCEPTANCE_LIVE=1`、`LUOWANG_SMOKE_REPOSITORY=https://github.com/cynos-ai/cynos-website` 和临时 `LUOWANG_SMOKE_GITHUB_TOKEN`。

当前多项目控制台将账号、部署设置和项目设置分开。登录后先创建项目；服务端验证 GitHub 仓库稳定身份并以 paused 状态保存。为项目设置非生产环境、Git Token、测试账号、清理配置及执行镜像构建说明，查看就绪结果并准备镜像，最后由管理员主动恢复项目。保存配置不等于依赖检查通过，也不会自动启用测试。项目镜像按固定提交构建或复用，Run 记录不可变镜像 ID；目标提交变化后需要重新准备适用镜像。内置基础镜像只承诺 Node 环境，其他语言和依赖由该项目固定提交中的 Dockerfile 提供。就绪页区分构建中、就绪、过期和失败，并显示固定提交、镜像 ID 及失败原因；Docker Engine 不可用属于部署故障，单项目构建失败只阻塞该项目。镜像用于隔离不同项目的工具链，不会自动部署被测应用，也不是恶意代码安全沙箱。

Agent 仍只有 Main、Runner、Reviewer 三组，正常 Run 的阶段策略为策划 low、Runner off、Reviewer low、最终汇总 off。项目配置与凭据在任务归属内使用；测试账号和清理 Token 不交给受控命令容器。模型、浏览器和 OSS 属于部署设置。

多项目 HTTP 入口均要求管理员会话。账号使用 `/api/account`，部署配置及 Provider/OSS Secret 使用 `/api/deployment` 和 `/api/deployment/secrets/:key`；项目列表与创建使用 `/api/projects`，详情、就绪、暂停、恢复、配置、项目 Secret 和镜像准备位于 `/api/projects/:projectId/...`。场景、报告、索引、队列、Run 和证据读取也必须带明确 `projectId`；旧版无项目 ID 的业务路由不再注册。项目 Secret 只接受 Git Token、测试账号和清理 Token；API 只返回配置状态和掩码，不返回明文。页面切换不会改变已有请求的归属或固定目标。一个部署同一时间最多执行一个 Run，但不同项目各有队列、进度与归档状态。

旧 v0.6.0 实例须停服务后离线升级：先运行 `npm run db:multi-project -- inspect` 记录预检和 fingerprint，再用 `backup <新目录>` 保存一致的数据库、repo 与 report 副本；逐条核对历史仓库归属后，有项目历史的实例使用 `upgrade-project <备份目录> <已审 fingerprint>`，空实例使用 `upgrade-empty <备份目录>`，最后运行 `verify`。升级命令不会创建缺失数据库，也不会代替人工历史归属核对。恢复旧版本时须同时恢复数据库、repo、report 和对应主密钥材料，不能只回退数据库；应先在隔离副本完成升级及回退验证，再切换需要保留的持久实例。具体风险和证明见[多项目计划](docs/changes/luowang-multi-project/plan.md)。

若已使用早期 v0.6.1 开发版完成多项目离线切换，升级到带项目报告索引修复的版本前也须停服务，运行 `npm run db:multi-project -- upgrade-index <新的备份目录>`，再运行 `verify` 后重启。命令先备份当前 SQLite，再将外部仓库历史报告的索引键改为项目内唯一；它不会改写目标仓库报告、Run 记录或 OSS 证据。备份目录必须不存在，失败时保留备份以供恢复；已完成时重复执行返回 `already_complete`。首次从 v0.6.0 切换的实例会在原升级事务中完成此项，不需要另跑 `upgrade-index`。

可选的真实 GitHub smoke 需要操作者临时提供独立测试仓库和最小权限 Token；它只诊断仓库读取路径，不属于 v0.6.1 双项目 live 证明：

```bash
LUOWANG_SMOKE_REPOSITORY=https://github.com/cynos-ai/cynos-website \
LUOWANG_SMOKE_GITHUB_TOKEN='<temporary-token>' \
npm run test:e2e:github
```

Docker Secret 文件也可以通过 `LUOWANG_ADMIN_PASSWORD_FILE` 和 `LUOWANG_MASTER_KEY_FILE` 提供；直接环境变量优先。生产环境应使用 HTTPS 或可信反向代理，并设置 `LUOWANG_ALLOWED_ORIGIN`。

Docker 构建默认使用固定 digest 的 DaoCloud Node 基础镜像、npmmirror 的 npm 源和 Playwright 浏览器源。浏览器会在镜像构建时按照 lockfile 中的 Playwright 版本安装，生产镜像和 CI 使用同一份浏览器文件，不依赖宿主机预装 Chromium；如需替换为公司内网、阿里云或其他可达镜像，可通过构建参数覆盖：

```bash
docker build \
  --target runtime \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright \
  --build-arg DEBIAN_MIRROR=http://mirrors.aliyun.com/debian \
  --build-arg DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security \
  --tag luowang:local .
```

要完整复现 CI 的质量环境，可以构建并运行带开发依赖和浏览器的 `quality` target：

```bash
docker build --target quality \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright \
  --build-arg DEBIAN_MIRROR=http://mirrors.aliyun.com/debian \
  --build-arg DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security \
  --tag luowang:quality .
docker run --rm --init --ipc=host luowang:quality npm run test:e2e
```

阿里云镜像地址需要替换为你在容器镜像服务控制台获得的加速地址。Compose 的 `NPM_REGISTRY`、`NODE_IMAGE` 和 `PLAYWRIGHT_DOWNLOAD_HOST` 默认使用上述镜像，也支持通过本地 `.env` 或命令行覆盖；本地 `.env` 必须保持未提交。不要在宿主机单独执行 Playwright 浏览器安装来代替镜像构建，避免再次出现 Node 包与 Chromium 不匹配。

原生浏览器零模型预检使用已构建的 runtime 镜像：

```bash
bash scripts/run-browser-sandbox.sh --network none --entrypoint node luowang:runtime dist/server/browser/preflight-cli.js
```

该脚本为独立验证容器挂载 Pi 状态、临时目录、npm 及 Chromium 配置/缓存 tmpfs，保留非 root、只读根目录。预检实际创建/写读目录，检查文件系统和余量，通过产品 Pi factory 绑定真实 MCP 并完成导航、snapshot、PNG 校验及释放；失败返回非零。没有模型 prompt，也不操作日常实例或表示业务场景通过。真实验收应在同一容器、相同挂载下调用预检，并核对目标页面就绪后才启动 Run；不能复用另一个容器的绿灯。

## 安全边界

罗网会逐步获得读取目标仓库、执行测试命令和访问测试环境的高权限。当前项目镜像不是恶意代码沙箱，只应连接操作者信任的仓库和非生产环境。v0.6.1 的 Compose 服务容器通过 Docker socket 调用 Engine；这项权限等同于宿主机高权限，必须限制谁能访问罗网服务、Compose 配置和该 socket。项目 Run 容器只接收当前 Run 的源码副本，不挂载 Docker socket、罗网数据库、主密钥、其他项目目录或无关宿主目录。Engine 应留足镜像与构建缓存容量；镜像保留和清理需按项目与固定提交核对，不能误删正在使用的镜像。密码、Token 和其他 Secret 不应写入 Git、日志或报告；本地 `.env` 仅作为被 `.gitignore` 忽略的开发/Compose 输入，正式部署应通过 Secret Store 或 Docker Secret 提供。正式部署还应由可信反向代理提供 TLS，并限制网络暴露范围。

部署资源按实际项目镜像、构建频率、浏览器任务和同机服务测量。本次 v0.6.1 指定的约 4 GiB 测试服务器只用于隔离 Compose、Docker 权限与回收验证；它的余量不代表罗网的最低或最高支持配置，也没有在该机完成模型/浏览器联合 Run。真实多项目联合 Run 在另一隔离候选完成，具体证据和限制见[多项目计划](docs/changes/luowang-multi-project/plan.md)。

服务启动时先按数据库 `instance_id` 标签核验并删除本实例遗留的 Run 容器，再恢复队列。镜像只在同实例、同项目、构建标签与 `luowang-project-<projectId>:<targetCommit>` 标签吻合，且未被 ready 镜像状态或任何 Run 镜像记录引用时尝试删除；Docker 拒绝删除的镜像会保留。旧版没有实例标签的资源以及无标签的构建缓存不会被自动清理，应在确认归属和容量后由运维人员手工处理，不要对共享 Engine 执行全局 `docker image prune`。

## 许可证

本项目使用 GNU Affero General Public License v3.0-only（AGPL-3.0-only）。它允许个人和商业使用、修改、分发和收费，但分发衍生作品以及通过网络向用户提供修改版时，必须按 AGPL 提供完整对应源码并保留版权与许可证声明。详见根目录 [`LICENSE`](./LICENSE)。
