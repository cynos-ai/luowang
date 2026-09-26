# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。v0.6.1 支持同一管理员管理多个 GitHub 项目，项目数据、凭据、任务、证据和执行镜像分别归属。两个 Node 目标及一个 Python 目标已完成交替真实 Run 和故障隔离，历史持久测试实例副本已完成升级与回退验收。正式版本见 [GitHub Releases](https://github.com/cynos-ai/luowang/releases)。

v0.6.0 加入随版本维护的代码深读方法：Main 追踪业务规则与相关调用，并在计划中引用固定版本的读取回执；Reviewer 可以核对引用来源和阅读范围。回执只说明材料返回过，模型是否理解正确仍需单独评测。[实施与验收记录](docs/changes/luowang-code-understanding/plan.md)保留完整过程；多项目的功能边界与验收结果见[多项目计划](docs/changes/luowang-multi-project/plan.md)。

v0.6.1 虽使用补丁版本号，仍包含数据库与 HTTP 接口变化；部署前必须完成离线升级，旧的无项目 ID 业务 API 不继续兼容。这个编号不表示向后兼容。

## 本地启动

优先使用下文的 Docker Compose 或固定 quality/runtime 镜像复现。原生运行需要 Node.js 24 和 npm；当 `better-sqlite3` 没有匹配的预编译包时，还需要 `python3`、`make` 和 `g++`。v0.6.1 的启动入口只接受已完成离线升级的数据库，不会自动迁移旧实例或创建空库。以下命令仅用于开发或已升级的隔离实例；真实旧实例应使用正式发布版本，按[多项目升级计划](docs/changes/luowang-multi-project/plan.md)执行备份、归属核对与离线升级。

```bash
npm ci
npm run doctor
npm run build
npm start
```

`npm run doctor` 会先核对 Node.js 24 和本机 `better-sqlite3` 是否能加载。若原生依赖与当前 Node 版本不匹配，先重跑 `npm ci`；本机没有所需编译工具时，可用仓库的 quality 容器运行检查。

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

## 第一次接入项目

1. 按上面的 Compose 命令初始化空数据卷，启动后打开控制台，用初始管理员密码登录。已有 v0.6.0 数据的实例先按[离线升级说明](docs/changes/luowang-multi-project/plan.md)处理，不能用空实例命令覆盖历史数据。
2. 在“部署设置”填写 Provider API Key 和 Main、Runner、Reviewer 模型，确认 Reviewer 支持图像输入；配置浏览器与对象存储并检查连接。
3. 在“项目”连接可信 GitHub 仓库。私有仓库须提供能读取仓库身份的 Token；新项目会保持暂停。在项目设置填写非生产 URL，按需指定仓库内的执行 Dockerfile。测试账号与密码、清理 URL 与清理 Token 分别成对配置。
4. 点击“准备或重建镜像”，再查看五项就绪检查。按每项的失败原因修正配置，全部通过后点击“检查并启用”。保存字段或构建镜像不会自动启用项目。
5. 如果场景分支尚不存在，在“测试与历史”填入可信的来源分支、tag 或提交，勾选“首次初始化”及确认框，提交来源并测试。已有场景分支时，可从来源纳入新变化，或直接提交普通 Run。请求进入队列，页面可查看 Run 和归档状态；测试只面向非生产环境。

排查顺序：先看项目页五项就绪原因；镜像失败检查项目 Dockerfile、Docker Engine 和构建日志；队列失败查看该请求的错误及固定目标提交。缺少场景分支时，普通 Run 无法替代首次初始化。部署配置与项目配置分开保存，项目 Token 不会回显。

## 验收状态

v0.6.1 已发布，发布后的 local、live、release 验收均通过。完整 Run、失败记录和资源收尾见[多项目实施计划](docs/changes/luowang-multi-project/plan.md)与[Production Closure 计划](docs/changes/luowang-v07-production-closure/plan.md)；这些记录不用于判断新部署是否就绪。日常检查使用下列命令。
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

多项目历史事实核验入口 `test:acceptance:multi-project-live` 读取 `LUOWANG_MP_LIVE_MANIFEST` 指向的本地 JSON 清单、`LUOWANG_MP_LIVE_HARNESS_URL` 和 `LUOWANG_ADMIN_PASSWORD`。清单至少列两个不同项目，各项目提供 `projectId`、公开 GitHub `repository`（`owner/name`）及 `runs`；每个 Run 提供 `queueId`、`runId`、`targetCommit`、`reportCommit`、预期 `result`、`scenarios` 结果、`minScreenshots` 和 `minCleanup`。它只读核对队列与 Run 的固定提交、归档状态、同名场景、截图原件哈希、Harness 清理回执、GitHub 报告正文和其他项目的 404；缺少输入时返回 blocked。清单与密码由操作者保存在受控目录，脚本只输出项目、Run、提交和计数摘要。该入口只证明列出的多项目历史事实，不替代旧 Closure 7 门禁的 Bug/Issue 条件，也不证明发布后的 release/tag、正式旧实例迁移或测试服务器完整负载。

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
