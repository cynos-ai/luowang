# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。当前仓库处于 Phase 0 基础设施阶段：已经提供可测试、可构建、可通过 Docker 启动的应用骨架，业务测试闭环会按 `docs/changes/luowang-harness-mvp/plan.md` 的阶段继续实现。

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
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
docker compose down
```

Compose 将数据保存到 `luowang-data` 卷，并把宿主机端口绑定到 `127.0.0.1`。

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
