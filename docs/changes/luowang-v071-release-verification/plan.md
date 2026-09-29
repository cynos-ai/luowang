# v0.7.1 发布复核小修复 Plan

- 状态：实施中；未发布
- [Intent](./intent.md) · [Spec](./spec.md)
- 分支：`fix/v071-release-verification`，从最新 `origin/develop`（`4668ff112ac3cf01ad89ea47e3ee014d2f09662c`）创建
- 目标：一次小修复，不改生产 API/数据库/Run 行为，不升级依赖

## 阶段 1：确定范围与文档

- [x] 核对 #100–102、检查器、项目 Run HTTP 路由与现有测试。
- [x] 确认 v0.7.0 GitHub Release 已发布；不继续沿用 README 的旧候选说法。
- [x] 创建本目录 intent/spec/plan。
- [x] 延后复杂工作：[#103](https://github.com/cynos-ai/luowang/issues/103)、[#104](https://github.com/cynos-ai/luowang/issues/104)，复用已有 [#94](https://github.com/cynos-ai/luowang/issues/94)。

## 阶段 2：检查器小修复

- [x] 在 `tests/acceptance/live-contract.ts` 增加被消费响应字段的运行时校验，供 `closure.ts` 使用；保持合法可选字段与无关扩展字段。
- [x] 提取普通正式报告请求集合，验证 published/completed；保留特殊 Run 两文件契约与普通报告缺失失败。
- [x] 复用认证、项目归属、readiness 判定与列表读取逻辑，增加 preflight CLI 与 npm 命令；预检仅读 `/readiness/status`，正式 live 保留实时探测，不触发真实 Run 或自动修复。
- [x] 输出目录在运行前独占创建，防止覆盖旧核验记录。
- [x] 在现有项目 HTTP 测试与验收测试中补生产响应契约、失败反例及预检请求范围检查。

证明：AC-V071-01/02/03/04。主要风险是误拒合法历史条目、把普通报告缺失当不适用、预检被误认为 live 通过；分别用合法缺失/反例、报告请求失败测试和独立预检 schema 验证。

## 阶段 3：使用文档

- [x] 重组 `README.md`，移除重复段落，保持命令与升级/安全警告。
- [x] 编写 `docs/release-verification.md`，记录预检、正式复核、版本差异审核与不改历史规则。
- [x] 完成文档自查（非独立 Agent 审核）：空实例如何启动、旧实例如何升级、预检通过代表什么、只修检查器是否需要模型 Run 重跑、谁能批准放宽断言。

证明：AC-V071-04/05。不提前 bump 包版本或标记发布完成；版本号在实际发布准备时统一修改。

## 阶段 4：验证与交付

- [x] 定向测试（检查器、生产项目 HTTP 路由、预检）：3 文件、27 测试通过。
- [x] 已有固定 quality 容器内 format:check、lint、typecheck、npm test、build、test:acceptance:local；输入和限制见执行记录。
- [x] 同一 quality 容器内浏览器 E2E。
- [ ] 新 quality/runtime 镜像构建：quality 在 npm 原生依赖头文件下载阶段受阻，runtime 未执行；不能将旧镜像回归写成新镜像构建成功。
- [x] `git diff --check`、新增行高置信凭据模式扫描和 Markdown 本地链接检查通过。
- [x] 更新本 Plan 为实际检查结果；未执行、失败、受阻单独记录。
- [ ] 提交 fix PR 到 develop；不直接提交 develop/main，不自动打 tag。

证明：AC-V071-06。测试使用本地合成数据，不在罗网自身创建 scenario-testing 或测试资产。

## 0.7.1 正式发布前

以上工程完成不代表 release 完成。负责人确认候选版本/镜像、检查器版本、资源和差异适用性后，按既有 local/live/release 入口验证；旧证据只能说明被核验候选，不凭本 Plan 的勾选赋予新候选通过状态。发布仍走 develop → main PR、人工授权 tag 和发布后 tag 核验。

## 执行记录

### 实施与本地证明

- 已读取生产路由与检查器。进一步追踪 readiness owner 后确认：GET `/readiness` 会调用模型并上传/删除 OSS 临时对象；因此预检使用已有 `/readiness/status`，成功报告带原检查时间，不声称当前依赖可用。正式 live 行为不放宽；这个限制已同步到 Spec 和使用文档。
- 测试文件：`tests/acceptance-preflight.test.ts`、`tests/closure6-acceptance-layering.test.ts`、`tests/multi-project-app.test.ts`。实际生产 HTTP 序列化验证嵌套归档与特殊 Run，单测覆盖错误类型、错误推进、未发布报告、404、空历史、无缓存、非零退出和拒绝覆盖。
- 容器：`luowang:v070-fix3-quality`，image ID `sha256:9c5197fe83568443afd2560a41e1e95dddfce07477ec131c631b8769d04273f3`。以只读挂载注入当前 tests/docs/README/package.json，不注入 live Secret；本轮生产代码、角色资源、脚本与 lockfile 未变。对工作树和镜像的 `src/resources/scripts` 目录及 `package-lock.json` 逐文件有序哈希，两者均为 `9140d152116b4f2e7662b7629a8cbd77ac71b9656a50655549b17096591f76d4`，说明复用的工程依赖与生产输入一致，不代表新 runtime 已构建。
- 完整 local 报告：`.cynos/acceptance/v071-engineering-20260929/local/report.json`、`report.md`；容器内路径 `/proof/local/` 映射到该目录。`local=passed`、`live=blocked`、`release=blocked`。
- local 内公共质量、类型检查、构建、浏览器 E2E 全部通过；全量测试 97 文件通过、1 文件跳过，475 项通过、2 项跳过。Phase 9 的 34 个本地 AC 与 Closure/SDQ 本地证明通过；这些均不是外部联合事实。
- 文档本地链接、`git diff --check`、新增行的私钥/GitHub Token/API Key 高置信模式扫描通过。扫描只证明这些模式没有命中，不能替代 live Secret 值扫描。

### 失败、受阻与未运行

- 新 `docker build --target quality --tag luowang:v071-quality .` 首次失败：`better-sqlite3` 回退 node-gyp 时，Node 24.14.1 headers 下载连接中断（`Error: aborted`）。一次重试仍停留于 npm 安装阶段，超过 6 分钟后由操作者工具终止，没有进一步重试或修改 Dockerfile 绕过；首次失败与重试日志分别保存为同目录 `build-quality-failed.log`、`build-quality-retry-stopped.log`。
- 新 runtime 构建未运行，等待上述依赖下载问题解除或 CI 提供独立构建证明。前述旧 quality 内的构建/测试通过不抵消该缺口。
- 没有读取候选 Secret 或运行真实 preflight/live/release；不把 v0.7.0 的旧证据记为 0.7.1 通过。本轮无新版本号/tag/Release，包版本保持 0.7.0，正式发布准备时统一更新。
- v0.7.0 的历史 Run、核验产物和 tag 不修改。
