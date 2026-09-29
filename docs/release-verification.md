# 发布复核操作说明

本文件说明维护者如何准备与复核发布证据。产品验收条件仍以对应 change 的 Spec 为准；这里不提供跳过 AC 或跨环境沿用证据的授权。

## 1. 准备条件

使用独立、可信的非生产候选和目标仓库。确认候选 commit/镜像、项目 ID、固定 target、账号、费用与外部写入范围；不把罗网自身作为测试目标。生产代码不得增加只为测试存在的假实现或跳过开关。

Closure live 入口继续要求 39 项安全/授权输入，名称及校验见 `tests/acceptance/closure.ts` 的 `LIVE_INPUT_NAMES`；资源含义见 [Closure Spec §9](changes/luowang-v07-production-closure/spec.md)。Secret 通过受控进程环境或 Secret Store 提供，不粘贴到 Git、PR、Issue 或报告。报告只保存脱敏事实。

- `LUOWANG_LIVE_PROJECT_ID`：承载本次联合事实的项目。
- `LUOWANG_LIVE_REPOSITORY`：该项目绑定的 GitHub 目标。
- `LUOWANG_LIVE_HARNESS_URL`：默认 `http://127.0.0.1:3000`；远程必须使用已授权的 HTTPS origin。
- `LUOWANG_ACCEPTANCE_ARTIFACT_DIR`：可选的新输出目录，必须尚不存在。不指定时自动按时间戳创建；包括失败/blocked 在内的旧报告不得覆盖。

候选实例重建后重新检查执行镜像和项目就绪状态。需要首次建分支的用例，开始前必须证明 `scenario-testing` 不存在；不能删除已有分支或报告来伪造首次创建。

## 2. 廉价预检（0.7.1 开发中）

```bash
npm run test:acceptance:preflight
```

预检复用正式 live 的输入、认证、项目归属、五项 readiness 判定和 queue/runs 响应解析，但只读取 `/readiness/status` 的已有结果。可以建立管理员会话，其余为读取；不会入队、创建 Run、调用模型、构建镜像、修改配置或写入 GitHub/OSS。空 Run 历史可以通过准备检查；就绪记录缺失或需要重检时不能通过。

预检保存独立 `luowang.acceptance-preflight.v1` JSON 报告，成功时记录 `readinessCheckedAt`。缺输入为 blocked，读取/就绪/格式错误为 failed，两者均非零退出。成功只说明已有就绪记录与响应满足要求，不证明当前外部环境仍可用、首次分支前置条件、浏览器执行、联合事实或任何 AC，通过后仍需正式验收。

镜像未准备时由操作者确认目标提交并使用既有准备入口处理，再执行新的预检。预检不自动恢复环境，以免撤销受控故障或改变被测候选。

## 3. 三层验收

```bash
npm run test:acceptance:local
npm run test:acceptance:live
npm run test:acceptance:release
```

- local：运行公共工程检查及本地生产路径集成，外部系统可用本地 test double；真实经过 Pi SDK 不等于真实模型联合通过。
- live：复核已经完成的真实联合事实，不自动生成所需模型 Run。按项目读取首次分支 prepared/resolved、正常与特殊 Run、归档、截图、清理、PR/Issue、Indexer、实时活动和 Secret 扫描。与预检不同，既有 `/readiness` 实时检查会发起模型探测、临时 OSS 对象上传/读取/删除，并更新就绪记录；“只读复核已有 Run”不代表完全没有外部调用或临时副作用。
- release：先执行公共质量与 local，再复核 live；任何必需层 failed/blocked 都非零退出。

正式结果保存 JSON 与 Markdown，区分 `local.status`、`live.status`、`release.status`，并列出资源、AC 与命令。特殊场景 PR Run 按设计不发布正式报告，不请求其 Indexer 报告；普通已发布 Run 的报告读不到仍是失败，不能统一忽略 404。

当前检查器仍从指定项目历史选择事实，尚未实现候选指纹或批次 manifest。操作者必须在本轮 Plan/PR 核对选中的 Run、target、候选与预期范围；旧事实不能自动证明新版本。后续改进见 [#103](https://github.com/cynos-ai/luowang/issues/103)。

## 4. 检查器修复后怎么办

只修改检查器、测试或文档时，先检查 Git 差异和构建内容，确认没有改变生产行为、角色资源、依赖或配置。补上错误复现及反例后，可重新运行 live 复核同一批原始证据，不需要仅为检查器修复重新执行模型 Run；既有连通性探测仍会调用模型并操作 OSS 临时对象。

在现有 change Plan 或 PR 中记录：

- 被测候选 commit/镜像 ID，与检查器 commit；有未提交修改则注明。
- 项目、Run/target 引用，以及选择这批事实的理由。
- 原失败报告、新核验报告位置和修复说明。
- 本次实际执行、未执行或受阻的检查。

这份说明不能替代实际证据。新结果不会改写原 Run 或原失败核验；“检查器有错”也不等于产品 passed。无法核对证据时仍不能发布。

生产代码、角色指令、运行依赖或配置变化后，需要重做受影响的真实用例，再执行完整 release 复核。换靶场、实例或不能证明适用性时，按现有规则补事实；本版没有通用证据携带机制。

检查器 PR 至少解释：原要求是什么，哪份事实说明旧断言不正确，修复后哪种错误仍会被拒绝。以下变动须负责人确认：减少断言、必需证据改为可选、改变工件适用规则、扩大证据沿用范围。不能为得到绿灯同时修改被测事实与检查器。

## 5. 发布与发布后核对

工程检查通过后仍需负责人确认实际候选和完整发布证明。实现通过 fix/feat PR 合入 develop，正式发布通过 develop → main PR。负责人明确指定版本并授权本次发布后，AI 可协助合并发布 PR、为合并后的 main 发布提交创建新的 SemVer tag 和 GitHub Release；未经授权不得执行，也不得覆盖、移动已有 tag。执行前核对 PR 检查、目标提交及 tag 不存在；发布后另存一轮 tag/main 与旧 tag 核验，失败不能改写历史。

发布后通过 `LUOWANG_LIVE_RELEASE_TAG` 指定新 SemVer，复核 tag 与 main 发布提交一致并检查历史 tag。既有发布 AC 在 tag 未核验前仍未完成，不能用发布前的 release 汇总状态冒充发布后证明。不得重写历史 tag 或历史报告。

## 6. 其他诊断入口

### 多项目历史事实

`npm run test:acceptance:multi-project-live` 使用 `LUOWANG_MP_LIVE_MANIFEST`、`LUOWANG_MP_LIVE_HARNESS_URL` 和 `LUOWANG_ADMIN_PASSWORD`。清单至少列两个项目，每个项目提供 `projectId`、公开仓库 `repository`（`owner/name`）和 `runs`；Run 包括 `queueId`、`runId`、`targetCommit`、`reportCommit`、预期 `result`、`scenarios`、`minScreenshots`、`minCleanup`。

入口只读核对队列/Run/提交、归档、同名场景、截图原件哈希、Harness 清理回执、GitHub 报告和跨项目 404；缺输入返回 blocked。清单保存在操作者受控目录，输出只含项目、Run、提交与计数。它只证明列出的历史事实，不代替 Closure Bug/Issue 条件、发布 tag、旧实例迁移或服务器完整负载证明。

### GitHub smoke

`npm run test:e2e:github` 需要临时的 `LUOWANG_SMOKE_REPOSITORY` 和 `LUOWANG_SMOKE_GITHUB_TOKEN`，只诊断仓库读取，不属于 live/release。历史 acceptance 中的可选 smoke 还需显式设置 `LUOWANG_ACCEPTANCE_LIVE=1`，默认不执行。固定官网测试目标为 `https://github.com/cynos-ai/cynos-website`；更换目标须获得授权。不要在命令历史中直接填写真实 Token。

### 原生浏览器零模型预检

```bash
bash scripts/run-browser-sandbox.sh --network none --entrypoint node luowang:runtime dist/server/browser/preflight-cli.js
```

使用已构建 runtime 镜像。脚本为隔离容器挂载 Pi 状态、临时目录、npm 与 Chromium 配置/缓存 tmpfs，保留非 root 和只读根目录。实际验证目录写读、文件系统余量、生产 Pi factory/MCP、导航、snapshot、PNG 和释放，失败非零；不调用模型、不操作日常实例，也不证明业务通过。

真实验收前在同一候选容器、相同挂载下完成适用的浏览器预检并检查目标页面；另一个容器的成功不能代替本次检查。
