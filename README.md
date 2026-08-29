# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。当前仓库处于 Phase 2：除了安全配置控制台，还可以连接唯一 GitHub 目标仓库、准备 `scenario-testing` 分支、同步场景/报告 Markdown 索引并在网站中读取事实。后续业务测试闭环会按 `docs/changes/luowang-harness-mvp/plan.md` 的阶段继续实现。

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

Compose 将数据保存到 `luowang-data` 卷，并把宿主机端口绑定到 `127.0.0.1`。管理员密码只在空数据库首次启动时读取；主密钥只用于进程内派生 Secret Store 密钥，二者都不会写入 SQLite。

打开 <http://127.0.0.1:3000/> 后使用管理员密码登录。登录后可以维护 Harness、仓库/测试环境、MCP 和 S3-compatible OSS 的普通配置；Provider Key、Git Token、测试账号和 OSS Access Key 等 Secret 只能覆盖或显式删除，页面只显示“已配置”和固定掩码。Phase 2 提供 GitHub 仓库读取、场景测试分支写入、PR/Issue 权限检查（无法无副作用确认的项目显示 `unknown`），以及场景/报告同步和只读索引页面。模型、MCP 和 OSS 的正式检查会在后续 adapter 阶段提供。

配置 GitHub 仓库后，先在“仓库事实与场景”区域准备 `scenario-testing` 分支，再点击“同步索引”。Git Token 只由 Repository Service 使用，不会写入 Git URL、命令参数、子进程环境、日志或测试 Agent。

真实 GitHub smoke 需要操作者临时通过环境变量提供独立测试仓库和最小权限 Token；命令不会把 Token 写入文件或提交：

```bash
LUOWANG_SMOKE_REPOSITORY=https://github.com/cynos-ai/cynos-website \
LUOWANG_SMOKE_GITHUB_TOKEN='<temporary-token>' \
npm run test:e2e:github
```

Docker Secret 文件也可以通过 `LUOWANG_ADMIN_PASSWORD_FILE` 和 `LUOWANG_MASTER_KEY_FILE` 提供；直接环境变量优先。生产环境应使用 HTTPS 或可信反向代理，并设置 `LUOWANG_ALLOWED_ORIGIN`。

如果 Docker Hub 访问较慢，可以在构建时切换基础镜像源：

```bash
docker build \
  --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.1-bookworm-slim \
  --tag luowang:local .
```

阿里云镜像地址需要替换为你在容器镜像服务控制台获得的加速地址。

## 安全边界

罗网会逐步获得读取目标仓库、执行测试命令和访问测试环境的高权限。当前单容器不是恶意代码沙箱，只应连接操作者信任的仓库和非生产环境；不要挂载 Docker socket、生产数据或无关宿主目录。密码、Token 和其他 Secret 不应写入 Git、日志、报告或 `.env` 文件。正式部署应由可信反向代理提供 TLS，并限制网络暴露范围。

## 许可证

本项目使用 GNU Affero General Public License v3.0-only（AGPL-3.0-only）。它允许个人和商业使用、修改、分发和收费，但分发衍生作品以及通过网络向用户提供修改版时，必须按 AGPL 提供完整对应源码并保留版权与许可证声明。详见根目录 [`LICENSE`](./LICENSE)。
