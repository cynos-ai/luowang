# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。当前仓库已完成 Phase 8，并提供 Phase 9 本地验收入口：除了安全配置控制台、唯一 GitHub 目标仓库索引、Main → Runner → Reviewer → Main 的本地 Run、受控 Playwright MCP UI 执行、S3-compatible OSS 证据 Gateway、幂等归档和持久 FIFO 自动化队列，还支持长期场景生命周期、三种场景维护模式、陌生项目初始化，以及展示 Git 树标记、场景历史、Run 工件/证据/归档、当前执行、队列、后台任务、依赖健康和陈旧缓存恢复的完整运维控制台。Phase 9 的本地验收会创建隔离的样例仓库和样例 Web 应用，并在结束后清理临时资源。

## 本地启动

需要 Node.js 24 和 npm。生产模式：

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

执行 Phase 9 本地验收：

```bash
npm run test:acceptance
```

该命令会在隔离环境中运行公共质量命令，使用临时 Git bare 仓库、Cynos 官网登录/注册样例应用、SQLite、队列、归档和 headless Chromium 验证 34 个 AC，并在 `.cynos/acceptance/<timestamp>/` 保存不含凭据的 JSON/Markdown 报告。真实 GitHub、DeepSeek、OSS 和非生产测试环境 smoke 不会默认执行；如需运行已存在的 GitHub 只读 smoke，必须显式提供 `LUOWANG_ACCEPTANCE_LIVE=1`、`LUOWANG_SMOKE_REPOSITORY=https://github.com/cynos-ai/cynos-website` 和临时 `LUOWANG_SMOKE_GITHUB_TOKEN`。

Compose 将数据保存到 `luowang-data` 卷，并把宿主机端口绑定到 `127.0.0.1`。管理员密码只在空数据库首次启动时读取；主密钥只用于进程内派生 Secret Store 密钥，二者都不会写入 SQLite。

打开 <http://127.0.0.1:3000/> 后使用管理员密码登录。登录后可以维护 Harness、仓库/测试环境、MCP 和 S3-compatible OSS 的普通配置；Provider Key、Git Token、测试账号和 OSS Access Key 等 Secret 只能覆盖或显式删除，页面只显示“已配置”和固定掩码。当前版本提供 GitHub 仓库读取、场景测试分支写入、PR/Issue 权限检查、场景/报告同步、场景 patch 校验、三种场景维护模式、直接/PR 发布、陌生项目初始化、归档和自动化队列接口，并注册 Provider、Playwright MCP 与 OSS 的独立连通性检查。启用 MCP 后，Runner 使用 headless、isolated 浏览器上下文和 accessibility snapshot/ref；截图等证据上传到 OSS，私有 bucket 使用登录后的 `/api/evidence/<id>` 稳定地址。后台默认每 60 秒轮询 Git、每 10 秒扫描归档、每 5 分钟兜底索引和保留清理；队列、调度游标和恢复状态保存在 SQLite。

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
