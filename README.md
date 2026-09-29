# LuoWang

罗网（LuoWang）是一个独立部署的 AI 场景测试 Harness。它读取目标项目的需求、代码变化和已有场景，规划测试、执行浏览器或命令操作，由独立 Reviewer 审核证据，再把正式场景、报告与确认的 Bug 归档到 GitHub。

一个管理员可以管理多个项目；同一部署一次只执行一个 Run。只连接可信仓库和非生产环境，不用于生产数据测试，也不自动修复目标项目代码。

正式版本：[v0.7.0](https://github.com/cynos-ai/luowang/releases/tag/v0.7.0)。0.7.1 发布复核小修复正在开发，尚未发布。

- [项目如何工作](#项目如何工作)
- [部署与启动](#部署与启动)
- [第一次使用](#第一次使用)
- [旧实例升级](#旧实例升级)
- [开发与验收](#开发与验收)
- [运维与安全](#运维与安全)
- [版本迭代](#版本迭代)
- [许可证](#许可证)

## 项目如何工作

正常 Run 使用 Main、Runner、Reviewer 三组 Agent 配置，创建四个隔离 Session：Main · 规划 → Runner → Reviewer → Main · 最终汇总。阶段默认 thinking 为 low、off、low、off。角色只通过受控工件交接，Runner 的自述不能代替执行证据。

- 每个 Run 固定不可变的 `target_commit`，测试代码必须先进入目标仓库的 `scenario-testing` 分支。
- Main 可以维护场景，但不能改产品代码；需审核的场景变更通过 PR 处理。
- 场景与正式报告保存在目标仓库 `docs/scenario-testing/`；详细 Run 记录由罗网保存，截图等证据存入对象存储。
- 配置和凭据按部署/项目划分。模型、浏览器、OSS 属于全局设置；仓库 Token、测试账号和清理配置属于项目。
- 项目执行镜像按固定提交准备，Run 记录不可变镜像 ID。镜像隔离项目工具链，不会自动部署被测应用，也不是恶意代码安全沙箱。内置基础镜像只承诺 Node 环境，其他语言和依赖由目标提交中的 Dockerfile 提供。

## 部署与启动

优先使用 Docker Compose。服务通过 Docker socket 调用 Engine，具有宿主机高权限；只应部署在可信环境，并限制服务及 socket 的访问范围。正式部署使用 HTTPS 或可信反向代理，并设置 `LUOWANG_ALLOWED_ORIGIN`。

### 新的空实例

**以下命令只用于初始化新的空数据卷。已有历史数据的实例先看[旧实例升级](#旧实例升级)，不要用空实例命令处理旧库。** 启动入口不会自动创建空库或迁移旧实例。

```bash
# 替换示例值；不要将真实密码或主密钥提交到 Git。
export LUOWANG_ADMIN_PASSWORD='replace-with-a-long-random-password'
export LUOWANG_MASTER_KEY='replace-with-a-long-random-master-key'
# Linux 主机若 Docker socket 不属于 root 组，设置 LUOWANG_DOCKER_GID：
# stat -c '%g' /var/run/docker.sock

docker compose build
docker compose run --rm --no-deps luowang npm run db:migrate
docker compose run --rm --no-deps luowang npm run db:multi-project -- backup /data/upgrade-backup
docker compose run --rm --no-deps luowang npm run db:multi-project -- upgrade-empty /data/upgrade-backup
docker compose run --rm --no-deps luowang npm run db:multi-project -- verify
docker compose up -d --build
curl --fail http://127.0.0.1:3000/health
```

控制台位于 <http://127.0.0.1:3000/>。Compose 只将宿主端口绑定到 `127.0.0.1`，数据保存在 `luowang-data` 卷；`docker compose down` 停止服务，不删除该卷。

管理员密码仅用于空库初始化，不覆盖已有密码哈希。主密钥用于派生 Secret Store 密钥，两者的明文不会写入 SQLite。也可通过 `LUOWANG_ADMIN_PASSWORD_FILE` 和 `LUOWANG_MASTER_KEY_FILE` 使用 Docker Secret 文件；直接环境变量优先。妥善保留主密钥，恢复备份时需要同一密钥材料。

### 原生开发

需要 Node.js 24 和 npm。`better-sqlite3` 没有匹配预编译包时，还需要 `python3`、`make` 和 `g++`。以下启动命令要求数据库已按上面的流程初始化或完成离线升级：

```bash
npm ci
npm run doctor
npm run build
npm start
```

默认监听 `127.0.0.1:3000`，数据目录为 `/data`；本地可将 `LUOWANG_DATA_DIR` 设置为可写目录。`npm run dev` 同时启动 Vite 和开发服务器。`doctor` 核对 Node 版本和原生数据库依赖；不匹配时重新执行 `npm ci`，或改用 quality 容器。

## 第一次使用

1. 登录后，在“全局设置”配置 Provider 与 Main、Runner、Reviewer 模型，确认 Reviewer 支持图像输入；分别保存浏览器和对象存储配置，到“系统状态”检查连接。
2. 在“项目”连接可信 GitHub 仓库。私有仓库须提供能读取仓库身份的 Token；新项目保持暂停。
3. 在项目设置填写非生产 URL，按需指定仓库内的执行 Dockerfile。测试账号与密码、清理 URL 与清理 Token 分别成对配置。
4. 点击“准备或重建镜像”，查看五项就绪原因；全部通过后点击“检查并启用”。保存配置或构建镜像不会自动启用项目，目标提交变化后需重新准备适用镜像。
5. 场景分支不存在时，在“测试”页填写可信来源分支、tag 或提交，明确确认后提交来源并测试。分支已存在时可以纳入新变化，或提交普通 Run。
6. 在“测试”页跟踪执行，在“测试记录”查看结论、报告、证据与归档状态。

排查先看“运行准备”；共享依赖故障看“系统状态”，镜像失败查看 Dockerfile、Engine 和构建日志，队列失败查看错误及固定目标提交。普通 Run 不能替代首次建分支初始化。每个项目单独保存配置，Token 不回显，页面切换不会改变已排队请求的项目或目标。

HTTP API 要求管理员会话：账号位于 `/api/account`，部署配置及 Secret 位于 `/api/deployment`、`/api/deployment/secrets/:key`，项目功能位于 `/api/projects/:projectId/...`。场景、报告、队列、Run 和证据请求必须带项目 ID；旧版无项目 ID 的业务 API 不兼容。Secret API 仅返回配置状态及掩码。

## 旧实例升级

从 v0.6.0 单项目实例升级时，必须先停服务，备份数据库、repo、report 和主密钥材料，并人工核对历史仓库归属。先在隔离副本验证升级和回退，再处理需要保留的持久实例。

顺序为 `npm run db:multi-project -- inspect` → `backup <新目录>` → `upgrade-project <备份目录> <已审 fingerprint>` → `verify`；只有空实例才用 `upgrade-empty`。升级命令不会创建缺失数据库，也不会代替人工归属核对。恢复旧版本必须一起恢复数据库、repo、report 与对应主密钥，不能只回退数据库。

使用过早期 v0.6.1 开发版多项目切换的实例，还需停服务执行 `npm run db:multi-project -- upgrade-index <新的备份目录>`，再 `verify` 后重启。命令先备份 SQLite，仅修复报告索引的项目内唯一键，不改写 Git 报告、Run 或 OSS 证据；首次从 v0.6.0 升级已包含此步骤。备份目录必须不存在；已完成时返回 `already_complete`。

完整步骤、风险与历史证明见[多项目升级计划](docs/changes/luowang-multi-project/plan.md)。

## 开发与验收

### 固定构建环境

Dockerfile 的 `quality`/`runtime` targets 固定 Node 镜像 digest 与 lockfile 对应的 Playwright Chromium。CI 与生产使用同一份浏览器，不依赖宿主机预装 Chromium。

```bash
docker build --target quality --tag luowang:quality .
docker run --rm --init --ipc=host luowang:quality npm run test:e2e
docker build --target runtime --tag luowang:runtime .
```

默认 Node、npm、Playwright 与 Debian 镜像源可通过 `NODE_IMAGE`、`NPM_REGISTRY`、`PLAYWRIGHT_DOWNLOAD_HOST`、`DEBIAN_MIRROR`、`DEBIAN_SECURITY_MIRROR` 构建参数覆盖，具体默认值见 [`Dockerfile`](./Dockerfile)。Compose 也支持其声明的镜像源变量；本地 `.env` 不得提交。不要另装宿主机 Chromium 代替镜像构建。

### 检查命令与结论

```bash
npm run test:acceptance:preflight # 开发中的准备检查，不调用模型，不代表验收通过
npm run test:acceptance:local     # 无外部凭据，真实 Pi SDK + 本地可控服务
npm run test:acceptance:live      # 实时连通性检查 + 已完成真实 Run 的事实复核
npm run test:acceptance:release   # 公共质量 + local + live
```

`local` 使用临时 Git、SQLite、浏览器和模型协议服务，真实经过生产 Pi Session；本地 test double 只能证明 `local.status=passed`。`live` 缺少必需输入时为 blocked 并非零退出；live 未通过时 `release.status` 保持 blocked/failed。`npm run test:acceptance` 只是 local 的兼容别名，CI 不读取 live Secret。

结果默认保存到 `.cynos/acceptance/<timestamp>-<mode>/`。预检仅读已有就绪结果并记录检查时间，不实时探测依赖，使用独立报告且不产生 AC 通过结论。正式 live 保留模型探测与 OSS 临时对象检查，但不重新执行已有 Run。每次检查使用新目录，旧失败记录不覆盖。已发布版本的验收也不能代替新部署的就绪检查。

输入、复核与重跑规则、多项目历史核验、独立 GitHub smoke 和浏览器预检见[发布复核操作说明](docs/release-verification.md)。0.7.1 的实施结果以[本版计划](docs/changes/luowang-v071-release-verification/plan.md)为准，未运行的 live/release 不算通过。

## 运维与安全

- 测试仅使用非生产环境、合成数据和专用账号。Secret 不进入 Git、日志或报告；正式部署使用 Secret Store 或 Docker Secret。
- 项目 Run 容器只接收当前源码副本，不挂载 Docker socket、罗网数据库、主密钥、其他项目目录，也不接收测试账号与清理 Token。
- 启动时按数据库 `instance_id` 标签清理本实例遗留 Run 容器，再恢复队列。只尝试删除同实例、同项目、构建标签及目标标签一致且没有 ready/Run 引用的镜像；Docker 拒绝删除时保留。
- 无标签的旧资源和构建缓存需人工确认归属。不要在共享 Engine 上执行全局 `docker image prune`。
- 容量须按实际项目、构建和浏览器任务测量。历史约 4 GiB 测试机只验证隔离部署与回收，不代表支持配置，也没有在该机完成模型/浏览器联合 Run。

`npm run ops:inventory` 只读查看本实例容器、镜像引用及候选容量。备份恢复、资源盘点及演练见[运维说明](docs/operations.md)。

## 版本迭代

正式发布内容以 [GitHub Releases](https://github.com/cynos-ai/luowang/releases) 为准。

| 版本                                                             | 主要变化                                                                                           | 说明                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0.7.1（开发中）                                                  | 发布检查器回归、廉价预检、只读复核规则与文档整理                                                   | [实施计划](docs/changes/luowang-v071-release-verification/plan.md)，尚未发布                            |
| [0.7.0](https://github.com/cynos-ai/luowang/releases/tag/v0.7.0) | 重构控制台：异常优先工作台、独立项目配置/准备/测试/记录/场景页面，系统状态与全局设置保持部署作用域 | 保持多项目归属与执行隔离，生产页面读取真实 API                                                          |
| 0.6.2                                                            | 首次接入、运行环境诊断、Docker 资源盘点、冻结模型评测复核                                          | 改善部署与排障                                                                                          |
| 0.6.1                                                            | 同一管理员管理多个项目、项目执行镜像与离线升级                                                     | 虽使用补丁版本号，仍有数据库/API 不兼容变化，必须离线升级                                               |
| 0.6.0                                                            | 内置代码深读方法、固定版本读取回执与计划引用                                                       | 回执只证明材料返回过，不证明模型理解正确；[实施与验收](docs/changes/luowang-code-understanding/plan.md) |

## 许可证

GNU Affero General Public License v3.0-only（AGPL-3.0-only）。允许个人和商业使用、修改、分发和收费；分发衍生作品或通过网络向用户提供修改版时，须按 AGPL 提供完整对应源码并保留版权及许可证声明。详见 [`LICENSE`](./LICENSE)。
