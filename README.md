# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。当前仓库已完成 Phase 0–9 的主要模块和 v0.7 生产闭环：除了安全配置控制台、唯一 GitHub 目标仓库索引、Main → Runner → Reviewer → Main 的本地 Run、受控 Playwright MCP UI 执行、S3-compatible OSS 证据 Gateway、幂等归档和持久 FIFO 自动化队列，还支持长期场景生命周期、三种场景维护模式、陌生项目初始化，以及完整运维控制台。当前生产闭环版本为 v0.3.0；v0.1.0、v0.2.0 与 v0.2.1 均保持既有不可变指向。

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

打开 <http://127.0.0.1:3000/> 后使用管理员密码登录。配置页按模型服务、Agent、Playwright MCP、S3-compatible OSS、GitHub 仓库、测试环境和自动触发分区；每个外部依赖都能在所属区域保存并检查。模型服务支持覆盖已知 Provider 的 Base URL，模型选择器只列出当前 Provider 的模型并标注视觉/推理能力；Reviewer 明确要求视觉模型以审核截图。Provider Key、Git Token、测试账号和 OSS Access Key 等 Secret 只能覆盖或显式删除，页面仅显示固定掩码。控制台同时提供 GitHub 仓库读取、场景测试分支写入、PR/Issue 权限检查、场景/报告同步、场景 patch 校验、三种场景维护模式、直接/PR 发布、陌生项目初始化、归档和自动化队列接口，并注册 Provider、Playwright MCP 与 OSS 的独立连通性检查。启用 MCP 后，Runner 使用 headless、isolated 浏览器上下文和 accessibility snapshot/ref；截图等证据上传到 OSS，私有 bucket 使用登录后的 `/api/evidence/<id>` 稳定地址。后台默认每 60 秒轮询 Git、每 10 秒扫描归档、每 5 分钟兜底索引和保留清理；队列、调度游标和恢复状态保存在 SQLite。

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

## 安全边界

罗网会逐步获得读取目标仓库、执行测试命令和访问测试环境的高权限。当前单容器不是恶意代码沙箱，只应连接操作者信任的仓库和非生产环境；不要挂载 Docker socket、生产数据或无关宿主目录。密码、Token 和其他 Secret 不应写入 Git、日志或报告；本地 `.env` 仅作为被 `.gitignore` 忽略的开发/Compose 输入，正式部署应通过 Secret Store 或 Docker Secret 提供。正式部署还应由可信反向代理提供 TLS，并限制网络暴露范围。

## 许可证

本项目使用 GNU Affero General Public License v3.0-only（AGPL-3.0-only）。它允许个人和商业使用、修改、分发和收费，但分发衍生作品以及通过网络向用户提供修改版时，必须按 AGPL 提供完整对应源码并保留版权与许可证声明。详见根目录 [`LICENSE`](./LICENSE)。
