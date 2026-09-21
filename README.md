# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。当前仓库已实现 Phase 0–9 的主要模块：安全配置控制台、唯一 GitHub 目标仓库索引、Main → Runner → Reviewer → Main 的 Run、受控 Playwright MCP UI 执行、S3-compatible OSS 证据 Gateway、幂等归档、持久 FIFO 自动化队列、长期场景生命周期、三种场景维护模式、陌生项目初始化和运维控制台。当前已发布版本为 v0.4.0；v0.1.0、v0.2.0、v0.2.1 与 v0.3.1 均保持既有不可变指向。

## 本地启动

优先使用下文的 Docker Compose 或固定 quality/runtime 镜像复现。原生运行需要 Node.js 24 和 npm；当 `better-sqlite3` 没有匹配的预编译包时，还需要 `python3`、`make` 和 `g++`。生产模式：

```bash
npm ci
npm run build
npm start
```

默认只监听 `127.0.0.1:3000`。打开 <http://127.0.0.1:3000/> 可查看控制台壳，健康检查地址为 <http://127.0.0.1:3000/health>。数据默认保存在 `/data`；本地开发可以设置 `LUOWANG_DATA_DIR` 到可写目录。执行 `npm run dev` 可以同时启动 Vite 和开发服务器。

也可以使用 Docker Compose：

```bash
# 首次启动空数据卷前必须设置这两个值；不要把真实值提交到 Git。
export LUOWANG_ADMIN_PASSWORD='replace-with-a-long-random-password'
export LUOWANG_MASTER_KEY='replace-with-a-long-random-master-key'
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
docker compose down
```

Compose 将数据保存到 `luowang-data` 卷，并把宿主机端口绑定到 `127.0.0.1`。管理员密码只在空数据库首次启动时读取；主密钥只用于进程内派生 Secret Store 密钥，二者都不会写入 SQLite。

## 验收状态

截至 2026-09-20，修复分支工程检查已通过（37 个测试文件 / 268 项测试），但整体 live/release 仍 blocked，独立人工评分未完成。正常重放、注入缺陷识别和证据受阻已有不同候选版本上的证明；最新候选只完成了受阻样本，不能将这些结果合并为最新版本全部通过。仍需验证多场景进度、模型省略公开单测口令、截图被拒后的处理，以及当前候选正常重放。逐项依据和执行顺序见 [当前验收结论与剩余工作](docs/changes/luowang-run-evidence-followup/plan.md#当前验收结论与剩余工作2026-09-20)。

以下按发生顺序保留验证过程，其中“待完成”描述当时状态。

统一定向流程已通过五例离线检查。Reviewer 曾漏写审核，随后成功交付但仍把缺少原 Session 请求关联的场景判 passed。修正后的负例用 5/30 次请求正确判 blocked。2026-09-21 补齐删除证据的正向对照用 8/30 次请求通过：同一 Reviewer 指令保留了合成功能通过的结论，同时指出进度补报与错误归属，未外推为官网通过。披露声明对照随后用 5/30 次请求通过，Reviewer 正确指出单文件公开常量扫描不能证明全部凭据及截图安全；报告仍有一处无依据的问题标题，单列质量瑕疵。首次正向对照因材料缺口仍保留无结论；Runner 随后用 13/30 次请求通过公开常量省略及两条合成命令时序验证，写入前后均未复述常量；截图稳定状态案例随后用 21/30 次请求完成：最终图片的输入框为空，但 execution 又复述两个合成字段值并声称未记录，独立评估判失败；后续案例停止。真实浏览器多场景、截图处理与披露仍未整体验收，整体状态保持 blocked。

截图需求已调整为保持取证现场：禁止为截图清空/覆盖表单或隐去待验证内容。新 [截图采集完整性计划](docs/changes/luowang-screenshot-capture-integrity/plan.md) 已将旧拒绝补丁替换为正常采集加检测标签，标签与图片哈希绑定，贯通证据工具、控制台和最终报告；保留自动归档、人工事后审核，不新增发布门禁。字段检测失败标为 unknown，实际截图错误仍保留。不做旧补丁兼容，须从干净依赖构建。填写前登记及脱敏填写记录已接入两种 MCP 入口；导航快照已关联实际操作并在上传前登记、脱敏，证据类别预检及运行时检查也已接入；模型记录精度指令已修订，六个正反案例已有设计，输入冻结及模型复验仍待完成，旧样本及失败结论保留。

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

# 先执行公共质量与 local，再执行 live；live blocked/failed 时非零退出。
npm run test:acceptance:release
```

`local` 使用临时 Git bare 仓库、样例应用、SQLite、队列、归档、headless Chromium 和本地可控模型协议服务；Agent 流程真实调用生产 `createAgentSession()`，但本地 test double 只能证明 `local.status=passed`。报告保存在 `.cynos/acceptance/<timestamp>-<mode>/`，分别记录 `local.status`、`live.status`、`release.status`、资源检查、逐 AC 证据和命令。CI 只运行 local，并明确不读取 live Secret。

`test:acceptance:live` 在 38 项安全/授权输入齐全后，连接候选实例（默认 `http://127.0.0.1:3000`，可用 `LUOWANG_LIVE_HARNESS_URL` 覆盖）并只读复核已经完成的真实验收事实：首次分支创建的 prepared/resolved 与唯一 Run、带截图和独立清理确认的 passed Run、双 Bug/Issue failed Run、不推进的 blocked Run、场景 PR、当前 HEAD 重测、Indexer 回读、实时活动、私有 Evidence Gateway、GitHub PR/Issues 及 Secret 值扫描。任何事实缺失或资源检查失败都会令 `live.status` 为 failed；live 未通过时 `release.status` 必须保持 blocked/failed。它不会用输入齐全或有限 smoke 冒充通过。

可选的 GitHub smoke 仍只用于单独诊断仓库读取路径，不属于 live 或 release 证明。它不会默认执行；如需运行，必须显式提供 `LUOWANG_ACCEPTANCE_LIVE=1`、`LUOWANG_SMOKE_REPOSITORY=https://github.com/cynos-ai/cynos-website` 和临时 `LUOWANG_SMOKE_GITHUB_TOKEN`。

打开 <http://127.0.0.1:3000/> 后使用管理员密码登录。配置页按配置文件、模型服务、Agent、Playwright MCP、S3-compatible OSS、GitHub 仓库、测试环境和自动触发分区；每个外部依赖都能在所属区域保存并检查。模型服务支持覆盖已知 Provider 的 Base URL，模型选择器只列出当前 Provider 的模型并标注视觉/推理能力；Reviewer 明确要求视觉模型以审核截图。Provider Key、Git Token、测试账号和 OSS Access Key 等 Secret 只能覆盖或显式删除，页面仅显示固定掩码。普通配置可以导出为版本化 YAML 并原子导入，Secret 始终排除且不会被导入覆盖。GitHub 区域通过一个按钮执行仓库读取、分支写入前提、PR 和 Issue 四项无副作用检查；底部总览也可一次测试全部已保存配置，并逐项显示问题原因。启用 MCP 后，Runner 使用 headless、isolated 浏览器上下文和 accessibility snapshot/ref，并可受控读取/恢复 Cookie 以验证退出后原 Session 是否被拒绝（仅 Cookie 读取/恢复，不含任意脚本执行、状态文件导出/导入或 local/session storage 变更）；截图等证据上传到 OSS，私有 bucket 使用登录后的 `/api/evidence/<id>` 稳定地址。自动测试默认关闭；启用新 commit 自动测试后，默认每 5 分钟检查一次是否存在可测试提交，只有发现变化才进入队列，不会每 5 分钟无条件执行测试。Cron 留空时同样不启用。归档每 10 秒扫描，索引和保留清理每 5 分钟执行；队列、调度游标和恢复状态保存在 SQLite。

Agent 仍只有 Main、Runner、Reviewer 三组，出厂 thinking 为 low/off/low。运行时由产品按阶段覆盖有效思考策略为 **策划低—Runner关—Reviewer低—最终汇总关**（low/off/low/off），不是评测驱动覆盖；模型选择沿用三组配置。已有实例保存的 thinking 不迁移、不覆盖，但实际 Session 使用上述阶段策略，详见 [生产配置就绪 Spec](docs/changes/luowang-production-config-readiness/spec.md)。官网 HTTP 清理只处理显式登记 `cleanupScope: website-accounts` 的本 Run 沙箱账号及关联会话；未绑定或不支持的数据保留人工处理告警，不能把账号查询为空当作容器/文件已清理。

配置 GitHub 仓库后，先在“仓库事实与场景”区域准备 `scenario-testing` 分支，再点击“同步索引”。Git Token 只由 Repository Service 使用，不会写入 Git URL、命令参数、子进程环境、日志或测试 Agent。

真实 GitHub smoke 需要操作者临时通过环境变量提供独立测试仓库和最小权限 Token；命令不会把 Token 写入文件或提交：

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

罗网会逐步获得读取目标仓库、执行测试命令和访问测试环境的高权限。当前单容器不是恶意代码沙箱，只应连接操作者信任的仓库和非生产环境；不要挂载 Docker socket、生产数据或无关宿主目录。密码、Token 和其他 Secret 不应写入 Git、日志或报告；本地 `.env` 仅作为被 `.gitignore` 忽略的开发/Compose 输入，正式部署应通过 Secret Store 或 Docker Secret 提供。正式部署还应由可信反向代理提供 TLS，并限制网络暴露范围。

## 许可证

本项目使用 GNU Affero General Public License v3.0-only（AGPL-3.0-only）。它允许个人和商业使用、修改、分发和收费，但分发衍生作品以及通过网络向用户提供修改版时，必须按 AGPL 提供完整对应源码并保留版权与许可证声明。详见根目录 [`LICENSE`](./LICENSE)。
