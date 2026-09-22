# 代码深读与测试判断 Plan

- 目标版本：v0.6.0；依据 [spec](spec.md)。
- 状态：阶段 1 已实现并通过对应工程检查；阶段 2–5 尚未开始。2026-09-23 从最新 develop `c51e5c1` 创建 `feat/code-understanding` 并带入已确认规格，保留 #74 发布后独立审核记录。
- 顺序：本版本单独实现、验收和发布，之后才启动 v0.6.1 多项目实现。

## 阶段 1：内置方法与资源加载

- [x] 新增 code-understanding 方法资源，按 engineer onboard 的阅读方法改写为测试用途；核对规格与实现冲突、未知及测试能力描述。
- [x] 扩展 `src/server/runs/role-instructions.ts`、资源复制脚本及对应角色指令；现有类型可直接保存新增资源 ID，复用版本/哈希和构建路径，不启用 Pi Skill 发现。
- [x] 检查普通及初始化两个 Main 的资源集合、其余角色隔离、缺失/错误资源和干净镜像打包。

完成证明：AC-CU-01；资源加载测试、角色工具断言及 quality/runtime 资源核对。风险是把新方法误装入最终 Main，或新增资源没有进入生产镜像。

2026-09-23 阶段证明：

- 新方法只加入 `main-planning` 资源集合，覆盖普通规划、初始化静态及候选 Main；Runner、Reviewer 和最终 Main 不加载该方法。Reviewer 仅补充来源与范围审核要求，未增加工具。`RoleInstructionVersion` 现有字段和加载器推导类型可直接使用，无需另建类型或配置。
- 干净 Git 源码叠加本次变更构建 `luowang:code-understanding-stage1-quality`，容器内 `format:check`、`lint`、`typecheck`、`build` 通过；`closure1-role-instructions`、`phase3`、`closure6-production-pi`、`closure6-acceptance-layering` 四个测试文件共 71 项通过。包括缺失/空白/错误标记/symlink/不可读资源拒绝，方法缺失时零 Session 启动，原文完整加载及版本哈希变化，四/六/三 Session 交接。
- 同一源码构建 `luowang:code-understanding-stage1-runtime`；quality 编译产物与 runtime 均通过默认加载路径核对，普通/初始化的四类角色共八种组合正确。方法 SHA-256 为 `6cbcf8dba753fdb01b6b44fd4d937c6e0f678e0ca4f4f7693c28772b5c83ac40`，与源码一致。
- 本机日志保存在被忽略的 `.cynos/code-understanding-stage1/`。测试容器关闭外部网络，生产 Pi 使用本地协议样例，外部模型请求为零。未运行完整 local/live/release 验收、模型效果对照或人工评分；以上结果只证明阶段 1 的工程行为，不证明理解质量已经改善。

## 阶段 2：固定版本读取回执

- [ ] 沿 `orchestrator.ts:targetToolOptions`、`agent-session.ts` 和 `change-evidence.ts` 的既有入口记录真实回执，统一正文与分页读的对象身份和返回范围。
- [ ] 搜索/目录/变化清单明确其内容类别与不完整原因；统计返回给模型的内容，不把内部扫描当成已读正文。
- [ ] 复用 Run/Session 本地记录，添加受控 query_source_reads；权限按当前 Run/阶段绑定，查询分页与数据脱敏统一处理。
- [ ] 验证空文件、缺页、重复页、乱序页、UTF-8 边界、rename、无 base、游标混用、受限文件、回执写入失败。

完成证明：AC-CU-02、03 及查询权限部分的 AC-CU-06。风险是截断/脱敏前后坐标不同；回执必须明确对应实际返回文本，必要的内容身份另存哈希，不将两种坐标混用。

## 阶段 3：计划引用和角色交接

- [ ] 为 write_plan 增加 sourceReferences，先校验再原子交付 plan 与引用集合；沿用既有有界重试。
- [ ] 初始化静态理解、侦察、候选综合保留阶段归属；把必要风险和缺口放进现有 plan 及安全审核摘要。
- [ ] Reviewer 读取被引用回执并独立核对来源、期望和范围；最终 Main 仍只读 plan/review。
- [ ] 真正通过生产 Pi Session 验证工具可见性、假引用拒绝、旧有效计划保留、特殊两工件及最终修订未经执行仍 blocked。

完成证明：AC-CU-04、05、06。风险是新增引用字段成为模型猜 schema 的负担；工具描述提供完整最小输入，并接受诚实空引用与缺口，不能要求为通过校验编造依据。

## 阶段 4：冻结模型对照并验证效果

- [ ] 复用 `tests/acceptance/` 中现有模型与工件驱动模式，准备八类固定样本；输入、关键风险、允许维护决定和禁止期望在执行前冻结并记录哈希。
- [ ] 先做无模型预检，再用两个代表样本检验工具协议；试运行不替代正式八类对照。
- [ ] 基线 v0.5.0 与候选使用隔离副本；每类三次配对，共 48 个案例运行。一次案例可能含多个 Session，实际成本按 Session 和请求统计。
- [ ] 每批开始前记录沿用的资源授权、模型配置、请求上限与停止规则；预计超出已有明确预算时先取得扩额，不以无限重试补分。本次文档工作不调用模型或申请新预算。
- [ ] 分别输出工程验证、模型配对评分、人工评分状态与成本；传输失败保留失败尝试并按事先规则报告未完成，不能换样本或偷改期望。

完成证明：AC-CU-07。判分依据见 spec 第 6 节；候选关键错误、关键遗漏退化或未证实改善均必须调查。修订后建立新候选轮，旧轮永久保留。

## 阶段 5：联合验收与 v0.6.0 发布

- [ ] 在干净 Git 源码的 quality 容器运行格式、lint、类型检查、完整单测、构建、E2E 和 local 验收；不把本机 .cynos 辅助脚本混入源码。
- [ ] 在获授权非生产目标执行初始化和维护代表 Run，验证真实 DeepSeek、浏览器、OSS、GitHub、独立审核、自动归档及清理；保留 normal/defect/blocked 差异。
- [ ] 首次创建场景分支等一次性验收条件使用新的隔离验收条件或明确的已有样本，不删除已有 scenario-testing 或伪装为首次运行。新增目标需要先明确授权。
- [ ] 更新 README、PROJECT.md、布局约定与 AGENTS.md 的相应能力说明，实际完成后才写已实现；旧 Run 结论不变。
- [ ] 负责人审阅最终报告后，按短期分支 → develop PR → main 发布 PR 执行，版本文件与 annotated tag 使用 v0.6.0；核验 main/tag、CI 与发布后验收。

完成证明：AC-CU-08、09；保存固定候选提交、CI 链接、各层报告、资源版本、模型用量与未完成项。人工未评分时如实保留，不因 AI 审核记录清除 humanScoring。

## 提交与执行边界

各阶段做到对应测试通过后形成可 push 的提交节点；实施分支从最新 develop 创建 `feat/code-understanding`。规格编写节点只提交 intent/spec/plan 及工作入口说明；后续按负责人“继续”授权分阶段实施，未到发布阶段不升级 package 版本、不发布。模型效果评测按阶段 4 执行。

v0.6.1 不作为本版本完成条件。深读记录先使用现有仓库身份和固定提交，后续多项目版本在其外层增加项目归属，不提前引入多项目架构。
