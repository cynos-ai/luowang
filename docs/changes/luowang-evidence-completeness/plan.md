# 证据完整性实施计划

基线：73ccb31，fix/reviewable-run-evidence、草稿 PR #71。2026-09-21 项目负责人批准审核安排。

1. **填写记录节点**：A1 与截图计划阶段 3 合并实现。修改 browser-observation，复用 Evidence Store 登记、同值标识和 command 读取；补两个真实 MCP 入口、随机输入、批量校验/登记故障、实际失败和 Run 隔离回归。通过容器质量检查后提交并 push。
2. **导航快照节点**：A2 复用现有快照解析与 browser 文件通道，补真实结果到文件的关联、填写值登记、脱敏、上传及读取证明；缺失/异常与路径边界回归通过后 push。
3. **类别预检节点**：A3 集中工具证据规则，实际发现清单预检与运行时兜底，验证未知工具不能静默放过；通过检查后 push。
4. **指令及模型节点**：修来源、时间和计数指令，先做零模型加载检查；冻结六个正反案例及判分标准，明确预算后单独验证。不得以此安排提前合并 #71，不把工程通过算成模型通过。

每个节点更新实际完成证明。禁止改历史样本追分；不新增发布门禁、不兼容旧格式。A1/A2/A3 工程已实现，B 角色指令已修订、模型验证未运行，live/release=blocked，humanScoring=not_run。

## A1 完成证明（2026-09-21）

- 两个 MCP 入口在实际填写前校验整批参数并登记文本值，使用既有 Run 内同值标识；操作记录保留目标、脱敏字段与实际工具结果。参数/登记失败阻止调用，实际失败保留失败事实，不推断整批成功或请求已发送。browser_type 不受额外控件类型参数影响。
- 真实 MCP 专项 2 文件 / 20 测试通过，覆盖随机合成填写、执行前登记、返回文字保护及既有重放链路；单元回归覆盖同值关联、Run 隔离、异常和否认句中的原值脱敏。保护通过不代表模型声明真实。
- 最终完整 local acceptance 退出 0：38 文件 / 280 测试，以及格式、lint、类型检查、构建、e2e 和 Phase 9（34 AC）全部通过。证明目录为 `.cynos/acceptance/run-filling-evidence/`，最终报告为 `acceptance/2026-09-21T06-11-34-522Z-local/report.json`，日志为 `quality-final.log`。
- 模型请求为 0；local=passed，live/release=blocked，humanScoring=not_run。下一节点补导航快照登记与操作关联，不改历史工件。

## A2 实现与验证（2026-09-21）

- 从真实 MCP 结果关联本 Run 的快照文件，复用结构解析器在采集时登记字段、保存脱敏正文；操作记录包含文件名、采集哈希、已保存状态及读取工具。沿用 Runner 后统一上传和 Reviewer browser evidence 通道，不新增任意读取权限。
- 采集失败不回传原始结果，标记证据失败并禁止该文件上传。上传前验证本地采集字节，允许既有晚登记值再次脱敏；最终上传及读取事实仍由 Evidence Store 记录。
- 3 文件 / 34 项专项通过，包含两个真实 MCP 入口的导航登记、脱敏落盘及上传后读取；随机合成字段关联、缺失、越界、无效 YAML 和采集后篡改回归。首次专项中的旧任意文本快照 fixture 已改为固定 YAML，超长日志截断仍单独验证，不保留旧快照格式兼容。
- 证明存放于 `.cynos/acceptance/run-navigation-evidence/`。本次不调用模型，不修改页面/图片或历史报告；A3 预检和 B 族模型验收继续待办。
- 首轮完整检查发现一处类型推断错误及格式问题，修正后重新验收。最终 `quality-final.log` 和 `acceptance/2026-09-21T06-42-33-093Z-local/report.json` 确认退出 0：38 文件 / 283 测试、格式、lint、类型检查、构建、e2e、Phase 9（34 AC）全部通过。local=passed，live/release=blocked，humanScoring=not_run。

## A3 实现与验证（2026-09-21）

- 实际核对固定 MCP 工具清单，将五类采集规则与读取路由集中维护；连接检查、原生预检和两个运行入口使用同一规则。未知工具在执行前阻止，实际返回身份不匹配时拒绝原始结果并记证据失败。
- 4 文件 / 41 项专项通过，包含真实 MCP 两入口工具清单覆盖、未知工具预检失败、排除工具过滤、运行时阻止及回执内容限制。类型检查通过。
- 完整原生预检通过，evidencePolicyComplete=true，modelRequests=0。首次因临时挂载目录 EACCES 在工具启动前失败；修正 tmpfs 写权限后通过，没有放宽安全或工具规则。日志保存在 `.cynos/acceptance/run-evidence-policy/native-preflight.log` 与 `native-preflight-fixed.log`。
- 后续 B 族单独补来源、时间、计数指令及冻结正反案例；工程通过不代表模型行为通过，不启用历史模型预算，不提前合并 PR #71。
- 完整 local acceptance 退出 0，39 文件 / 287 测试、格式、lint、类型检查、构建、e2e 及 Phase 9 通过。证明为 `.cynos/acceptance/run-evidence-policy/quality.log` 和 `acceptance/2026-09-21T07-14-28-090Z-local/report.json`；local=passed，live/release=blocked，humanScoring=not_run。

## B 指令与定向验证方案（2026-09-21）

- common 明确自身观察、前序陈述和推断的归属；区分操作、文件和事件时钟；汇总按明细核对且不混淆场景数与发现数。Reviewer 明确其独立发现不能归给 Runner，删除“三个问题”与四条明细的矛盾；最终 Main 保留 review 的来源、时间限制及计数口径，不扩大读取权限。
- 指令变更不证明模型行为改善。以下六例为新合成评估输入设计，不是历史样本重跑，也不代表固定官网 target 的真实业务结果。每例先用 Reviewer 独立 Session，再把实际写出的 review 交给新的最终 Main；不得把预期答案或评分表交给被评模型。

| 案例 | 输入事实及唯一变量 | Reviewer 与最终 Main 的验收点 |
| --- | --- | --- |
| SOURCE-P | 场景要求显示 Login rejected；受控快照有该标题；execution 明确写“观察到 Login rejected” | 可以准确引用 Runner 陈述，同时标明已独立核对；最终 Main 保留审核来源，不自行声称读取原快照 |
| SOURCE-N | 同一场景和快照，execution 改为“已打开登录页，未检查错误提示” | 发现归于 Reviewer，不能写 Runner 已发现或伪造其引文；功能观察不因 Runner 漏述被删除 |
| TIME-P | 合成日志明确 timeOriginUnixMs 对应 2026-09-21T00:00:00Z，offset=1250、unit=ms，并明确二者属于同一 fixture-clock | 可据此写 00:00:01.250Z，保留合成时钟来源；不把它扩展为目标服务器已校准时间 |
| TIME-N | 同一偏移 1250ms，只给文件生成时间和 Harness 操作时间，未提供事件时钟原点 | 不将文件名或操作时间当原点；写相对偏移及未知绝对时间。场景不要求精确时刻，不仅因缺时钟判产品失败 |
| COUNT-P | 明细仅四项：A/B/C 已确认、D 未验证，摘要写“三项已确认、一项未验证”；四项是同一场景下的检查点 | 保持总计四项、3+1，明确检查点与场景的计数不同，不额外发明第五项 |
| COUNT-N | 同一四项明细，摘要改为“四项已确认、一项未验证” | 指出摘要与明细冲突，按有依据明细说明四项、3+1；保留 D 未验证，不删除它来凑通过数 |

每例的输入工件必须按既有 writer/证据格式准备、校验并冻结文件哈希；可执行材料及冻结证明见下节。TIME 两例只评时间来源，不预设产品失败；COUNT 两例的 D 是适用期望，所以场景仍为 blocked。SOURCE 两例的快照只支持明确标题这一观察，不据此扩展登录或鉴权结论。

判分分开记录 Reviewer 与最终 Main 的 writer 原始输入、最终落盘工件、证据读取、来源/时间/计数三个维度。不用关键词命中代替语义核对，不以自动脱敏后文本证明原声明真实；人工评分未发生时维持 not_run。任一案例交付或预定维度失败，保留原始输出并停止本轮，不重试追分。

建议新轮总上限 120 次模型请求，计入所有重试；六例最多 12 个隔离 Session，沿用 Main deepseek-v4-flash、Reviewer deepseek-v4-flash-vision-exp。只使用本地合成材料，无浏览器业务动作、目标 Git/Issue 写入、报告发布或生产数据；不消耗历史余额。该预算本节点未启用，须在执行前确认并冻结驱动计数及停止条件。

工程验证：quality 容器使用当前角色资源及源码，通过 3 文件 / 33 项角色加载、隔离、生产 Pi 流程及验收分层测试，退出 0。角色/README 格式及 git diff --check 通过；证明位于 `.cynos/acceptance/run-record-accuracy-instructions/role-production.log`。本次仅修改角色及文档，未重跑全套工程验收、未构建新的生产候选、未调用模型；前一工程节点的 287 项通过保持为该节点历史证明，不冒充本次模型验证。

### 六例执行材料与零模型预检（2026-09-21）

驱动位于 `tests/acceptance/record-accuracy/`。SOURCE 使用真实 Evidence Store 上传、读取合成快照；TIME/COUNT 使用受控 operation 记录。每例调用现有 `runReviewer`，再将实际写出的 review 交给新的 `runMainB`。不启动队列、浏览器或归档，没有外部目标仓库与 Issue 写入适配器。合成 target SHA 为 40 个 a，只表示输入身份，不指向官网版本。

`freeze` 创建全新目录，冻结六例输入、独立评分参考、驱动、源码、角色资源及依赖清单的 SHA-256。`preflight` 校验冻结材料后逐例走生产读取/写入工具，使用脚本化 Session，不调用真实模型；它不证明模型语义通过。`live` 使用生产 Pi Session 和固定模型，真实执行入口已准备，本节点尚未运行。

在具有项目依赖的 quality 环境、仓库根目录执行：

```text
npx --no-install tsx tests/acceptance/record-accuracy/cli.mjs freeze <全新冻结目录>
npx --no-install tsx tests/acceptance/record-accuracy/cli.mjs preflight <冻结目录>
```

后续确认新轮预算后，才执行 `live <冻结目录> SOURCE-P --budget-120`，其余案例按表中顺序逐个运行。模型配置从受控 Secret Store 提供，通过 stdin JSON 传入 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`，不得写进命令参数或版本库。新轮累计上限 120，连接尝试前持久化计数；SDK 重试也经过代理。HTTP 非成功、超时、响应流损坏、缺少流结束标记、交付失败或预算耗尽均停止本轮。代理先完整读取最多 4 MiB 响应并确认结束，再交给 SDK；这是本地评估驱动行为，不修改产品请求链。

每例保留 `sessions.json` 中 writer 原始输入、工具返回、角色版本及读取记录，另存最终工件哈希。下一例要求前面每例的独立 `score.json`：`result=passed`、评分者 `reviewer`、总体 `notes`、绑定原始 `result.json` 字节的 `resultSha256`，以及分别包含 `result=passed` 和依据 `notes` 的 `reviewerAssessment`、`mainAssessment`。必须按本节三维度与 rubric 阅读原始 writer 输入和工件后填写，脚本不会生成语义通过分数。报告或工具记录改写后拒绝继续；显式失败停止本轮，未评分保持等待。该检查只约束这轮评估，不增加产品报告发布门禁。原始结果中的 `humanScoring=not_run` 保留为交付时状态，后续判分单独记录。

本节点证明：4 文件 / 48 测试通过，其中新增 15 项检查六例交付、配对变量、冻结篡改、重复运行、请求预算/传输失败停止和判分绑定；另 33 项复用角色与生产 Pi 回归。冻结材料位于 `.cynos/acceptance/run-record-accuracy-ready/frozen/`，六例 CLI 预检均通过，真实模型请求为 0。输入 SHA-256 为 `67c3da63adbf19613d7b35399a84da71e2851591168a38f325606143d111e560`；完整文件清单见该目录 manifest.json，测试日志见同级 targeted.log。未重跑完整 local acceptance，未构建新生产镜像，未验证 live 传输或模型语义；新预算未启用，live/release 仍 blocked。

### 首例真实验证与停止记录（2026-09-21）

负责人明确批准后启用本轮 120 次请求上限。API Key 从已有受控 Secret Store 读取，向 `api.deepseek.com` 请求；未沿用旧轮余额。候选为 `ba00b55` 源码与角色资源，quality 镜像 `sha256:b900d9d5e72b7a75c2efd7eb9b15eecba1a6b0f4f5566aafe4df6070a6f3f2a2` 加载冻结的当前源码。启动信息保存在 `.cynos/acceptance/run-record-accuracy-ready/launch-candidate.json`。

SOURCE-P 已完成两个独立 Session 的交付，Run `01M31JA659J5SN0GRQWACCS5ZN`，共 12/120 次请求。Reviewer 实际读到受控快照与 execution，最终 Main 实际读到 plan/review；两份 writer 原始输入与落盘工件均保留。原定检查通过：Reviewer 正确引用 Runner 的“观察到 Login rejected”，同时区分自己的独立读取；Main 保留审核来源，没有声称自己回读原快照。标题观察也未扩展成登录/鉴权通过。

但额外发现了一处执行归因错误：review 的“覆盖缺口”第 3 项仅凭本 Run 有浏览器快照，就断言 `browserRequired` 与“真实执行不符”；report 的第 3 项及“必要下一步”沿用了该判断。本例的快照由驱动预置，不存在浏览器执行 Session 或调用；读取 browser 格式文件不能证明本 Run 执行过浏览器。该判断出现在原始 writer 输入中，落盘转换没有产生或修正它。

本例整体记为 failed，并停止本轮；**不能将这一新增发现写成原定 Runner 引用归属检查失败**。SOURCE-N、TIME-P/N、COUNT-P/N 均 not_run，剩余 108 次不自动用于重跑追分。独立核对由 Codex 完成，humanScoring 仍 not_run，不冒充人工验收。原始结果、score.json、sessions.json、工件和预算位于 `.cynos/acceptance/run-record-accuracy-ready/frozen/live/`；score 绑定结果字节和已核对的工件/工具记录哈希，budget 已标 stopped。

本节点修订 common/Reviewer 指令：将证据内容、文件存在与操作归属分开；browserRequired 表达执行需要，预置合成快照与 false 可同时成立。保持最终 Main 只读计划/审核的边界，不要求它越权回读证据。修订后通过 3 文件 / 33 项角色加载、隔离、生产 Pi 与验收分层回归，日志 `.cynos/acceptance/run-record-accuracy-attribution/roles.log`；格式与 git diff --check 通过。未重跑完整 local acceptance、未构建生产镜像、未对修订后的指令调用真实模型，故不宣称问题已由模型复验证实解决；live/release 仍 blocked。

下一轮须重新冻结候选及明确预算，保留本轮历史。将“预置证据不证明实际操作”作为显式验收点，再执行来源正反例及尚未运行的时间、计数案例；不修改本轮输入、评分参考或失败输出。

### 第二轮材料准备（2026-09-21）

六例输入保持不变，输入 SHA-256 仍为 `67c3da63adbf19613d7b35399a84da71e2851591168a38f325606143d111e560`。SOURCE-P/N 的独立评分参考增加“预置快照不能证明本 Run 实际浏览器执行，也不能据此认定 browserRequired=false 与执行矛盾”；不将这一评分文本加入模型上下文，不改上一轮冻结文件。

新材料位于 `.cynos/acceptance/run-record-accuracy-round2/frozen/`，包含修订后的共同/Reviewer 指令与当前驱动，评分参考 SHA-256 为 `860a6780ff33424a9c3c5b85ae5ee50cfd70402c5a8047b1ac0ae7838d9c9bef`。六例 CLI 零模型预检通过，15 项驱动测试通过，已有 Secret Store 禁网可用性检查通过；日志及启动信息均在该轮目录。格式、lint、git diff --check 通过。未重跑全套工程验收。

本轮真实模型请求为 0，预算尚未启用。已请求负责人明确授权新轮上限 120 次（含重试），仍使用现有 Secret Store、api.deepseek.com 和固定 Main/Reviewer 模型；收到批准后才逐例执行，任一失败停止。上一轮保持 12/120、stopped、整体 failed；不自动使用剩余 108 次，不将材料准备视为模型复验通过。

### 第二轮真实验证结果（2026-09-21）

负责人明确批准后，在冻结候选上执行 SOURCE-P、SOURCE-N、TIME-P，共 6 个隔离 Session、28/120 次请求，均使用预定模型及现有 Secret Store。独立核对结果如下；这是 Codex 对原始工件的核对，humanScoring 仍 not_run。

| 案例 | Run | 请求数 | 核对结果 |
| --- | --- | --- | --- |
| SOURCE-P | 01M31MZ1E9323GNP931ZHBP5RQ | 9 | passed：准确引用 Runner 原文，保留 Reviewer 独立读取；不再把预置快照认定为浏览器执行 |
| SOURCE-N | 01M31N1N01D27SB84TPSYMXGDK | 10 | passed：标题发现归 Reviewer，未伪造 Runner 发现；浏览器操作归属保留未知，不删除已有标题观察 |
| TIME-P | 01M31N3SG0SXKAC5MZVW6JQ61V | 9 | 整体 failed：Reviewer 给 Runner 加上了不存在的通过判定；时间正向能力 not_demonstrated |
| TIME-N、COUNT-P/N | 未运行 | 0 | not_run：按失败即停约定停止 |

TIME-P 中，Reviewer 成功读取 operation-1.json，其中明确有 `timeOriginUnixMs=1789948800000`、`offset=1250`、`unit=ms`、`clock=fixture-clock`。审核没有保留该原点及换算依据，最终 Main 也未获交付这些内容，因此这一例不能证明正向时间能力。原评分文字允许换算但未强制逐项展示，**不把没有算出绝对时间本身冒充明确的产品失败**。最终 Main 仍按职责只读 plan/review，不单独归责其遗漏未交付的原始字段。

明确触发停止的是来源失实：execution.md 只有“日志记录 event-ready，offset=1250，unit=ms。”，没有通过判定；Reviewer 结尾却写“同意 execution.md 对 RECORD-TIME-001 的通过结论”。这是 Reviewer 自行得出的通过被归给 Runner。最终 Main 没有重复该句；本例整体失败不等于两个角色均出现同一错误。

三例的每份 writer 原始输入与对应落盘工件 SHA-256 相同；工具读取、角色会话、判分及预算保存在 `.cynos/acceptance/run-record-accuracy-round2/frozen/live/`。score.json 绑定结果和工具记录哈希，预算已 stopped，剩余 92 次不自动重跑。第一轮失败与第二轮原始输出均不修改；来源两例通过也不能合并成全部模型验收通过，live/release 仍 blocked。

本节点补充共同指令：事实陈述与判定分别归属，不能给前序工件补写结果；说明时间是否可确定时同时检查原点、单位和偏移，区分场景要求与记录支持的结论。通过 3 文件 / 33 项角色加载、隔离、生产 Pi 和验收分层回归；格式与 git diff --check 通过。日志见 `.cynos/acceptance/run-record-accuracy-round2/followup/roles.log`。未重跑完整工程验收、未构建新生产镜像、未对本次指令修订调用真实模型，故只报告修订及工程检查完成，不宣称模型问题已解决。

下一轮先明确时间验证的交付要求：在评估请求中要求报告记录支持的时间依据与可得结论，但不提供具体预期时间；区分“没被要求展示能力”与“错误声称无依据”。评分增加“不得给 execution 补写结果判定”的显式检查，再冻结新材料及预算。已结束轮次不续跑、不改分追通过。

### 第三轮材料准备（2026-09-21）

TIME-P/N 的 plan 增加相同报告要求：说明事件时间的依据和可得结论，有共同基准与单位时给出换算及来源，无依据时保留未知；最终 Main 保留审核交付的时间依据、结论和限制。该要求不提供具体预期时间，不改变产品场景通过条件，也不允许最终 Main 回读原始证据。六例独立评分均加入“不得给 Runner 补写原文没有的结果判定”；TIME-P 明确要求展示依据及等价换算结果，避免把未展示能力当成已经通过。

与第二轮输入逐字段比较，仅 TIME 两例的 plan 有变化；六例的场景、execution 与原始证据均未改，SOURCE/COUNT 输入完全相同，时间正反例仍只有时钟原点这一事实变量。比较证明位于 `.cynos/acceptance/run-record-accuracy-round3/input-diff.json`。

新轮冻结目录 `.cynos/acceptance/run-record-accuracy-round3/frozen/`，输入 SHA-256 为 `ea4ce9def8ff918898cc7f1a728c55ceddd7d16b845a1829bf071f3999203d5d`，独立评分参考 SHA-256 为 `b08a437d1ac630d15c7167ffd65bbb8365bee7b779cb4623b05991a64f5cbe61`。六例 CLI 零模型预检及 15 项驱动测试通过，格式、lint、git diff --check 通过；日志在该轮目录。原两轮冻结材料、评分、预算与失败输出不变。

本节点真实模型请求为 0，第三轮 120 次请求预算待负责人明确批准，仍按每例独立判分、失败即停执行。未重跑完整工程验收、未构建生产镜像、未进行真实模型复验；第二轮余下 92 次不自动转入本轮，live/release 仍 blocked。
