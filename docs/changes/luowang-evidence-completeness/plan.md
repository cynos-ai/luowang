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

### 第三轮首例与必需工件漏读修复（2026-09-21）

明确批准第三轮预算后执行 SOURCE-P，Run `01M31Q8HH9DC0R2QXE8JS687AN`，共 7/120 次请求、2 个 Session。Reviewer 独立读取 plan.md 和浏览器快照，但完整工具轨迹中没有 execution.md 读取；write_review 仍成功，随后最终 Main 正常读取 plan/review 并写报告。Reviewer 没有伪造浏览器执行，但未获得 Runner 原文，因此不能验证来源对照；本例按审核交付不完整记 failed，其余五例未运行。budget 已 stopped，剩余 113 次不自动续跑。

两份 writer 原始输入与落盘工件哈希一致，原始记录、独立 score 及预算保存在 `.cynos/acceptance/run-record-accuracy-round3/frozen/live/`。人工未评分，humanScoring 仍 not_run。最终 Main 无权补读 execution，不以扩大其权限修复上游漏读。第一、二轮记录保持不变。

根因是既有 `review-order` 的 assertReady 仅校验计划、存在的 patch 与原始图片尝试，并同时用于 execution 读取前及 review 提交前。它没有记录 execution 成功读取，故只读快照即可提交。修复复用同一 Session 的顺序控制：execution 读取前沿用既有证据顺序检查；实际读取成功后才登记；write_review 使用独立的提交检查，漏读或读取失败时返回明确提示且不写文件。零图片或零执行场景也须读取真实执行工件，但不要求不存在的图片/日志。真实图片读取失败仍作为阻塞事实允许后续诚实交付，不改原失败规则。

新增回归覆盖漏读、提前拒绝、真实读取失败、成功后提交及 Session 间不共享状态；编排集成证明读完图片但跳过 execution 时，review/report 均不会生成，最终汇总不会继续。正常 Phase 4 测试替身也按已有要求先读图片再读执行记录，避免以先前被拒的尝试冒充成功读取。专项 6 文件 / 75 项通过，日志 `.cynos/acceptance/run-record-accuracy-round3/followup/targeted.log`；完整 quality 容器本地验收退出 0：40 文件 / 304 测试、格式、lint、类型检查、构建、e2e 及 Phase 9（34 AC）均通过，证明见同目录 quality.log 与 acceptance/2026-09-21T10-16-38-640Z-local/report.json。本地验收未调用真实模型；未构建新的生产容器镜像，不将工程通过视作模型语义通过。

该修复只能证明必需工件确实交付给模型，不能证明模型理解、引文或判定准确。本轮不重跑模型覆盖原失败，下一轮仍须冻结新候选并独立复验；live/release 保持 blocked。

### 第四轮材料准备（2026-09-21）

第四轮只替换为包含 execution 读取门禁的候选源码与新增工具轨迹断言；六例 inputs.json 和 rubric.json 与第三轮逐字节相同。输入 SHA-256 保持 `ea4ce9def8ff918898cc7f1a728c55ceddd7d16b845a1829bf071f3999203d5d`，评分参考 SHA-256 保持 `b08a437d1ac630d15c7167ffd65bbb8365bee7b779cb4623b05991a64f5cbe61`，不调整案例追求通过。

新冻结目录为 `.cynos/acceptance/run-record-accuracy-round4/frozen/`。六例零模型预检全部通过；每例 Reviewer 工具轨迹均为成功读取 execution.md 后再调用 write_review。新增自动断言把该顺序纳入驱动测试。3 文件 / 36 项定向测试通过，覆盖冻结和预算、漏读拒绝、编排集成与六例工具交付；既有修复节点的完整本地验收仍为 40 文件 / 304 测试、格式、lint、类型检查、构建、e2e 和 Phase 9（34 AC）通过。

现有 Secret Store 的禁网可用性检查通过。第四轮尚未调用真实模型，modelRequests=0、humanScoring=not_run；必须获得独立的新轮 120 次请求预算后才逐例执行，失败即停。第三轮保持 7/120、stopped、failed，剩余 113 次不转入本轮。工程门禁通过不证明 Reviewer 会正确理解或引用 execution，live/release 继续 blocked。

### 第四轮真实验证与最终汇总来源修复（2026-09-21）

负责人明确批准第四轮独立 120 次请求预算后，按顺序执行 SOURCE-P 与 SOURCE-N，共 4 个隔离 Session、16/120 次请求。两个案例的 Reviewer 都在成功读取 execution.md 后才提交审核；每份 writer 原始输入与对应落盘工件 SHA-256 相同。独立核对由 Codex 完成，humanScoring 保持 not_run。

| 案例 | Run | 累计请求数 | 核对结果 |
| --- | --- | --- | --- |
| SOURCE-P | 01M31WZVH4C86ZA6579JZ7BCM6 | 8 | passed：准确引用 Runner 的标题观察，同时把 passed 归于 Reviewer 对快照的独立判断；最终 Main 保留审核来源 |
| SOURCE-N | 01M31X1VG34XHANBKWY7S9ZW89 | 16 | 整体 failed：Reviewer 正确区分 Runner 未声明标题观察及自身独立发现；最终 Main 把 Reviewer 已作出的适用性判断错误改归自己 |
| TIME-P/N、COUNT-P/N | 未运行 | 0 | not_run：按失败即停约定停止 |

SOURCE-N 的 review.md 已明确写明 Runner 的“未检查错误提示”与场景仅检查标题的范围一致，且该对象本就不是适用期望。report.md 却声称这是“本次汇总角色的判断，非 Reviewer 已作出的适用性结论”。这不是普通措辞差异：最终 Main 丢失了 Reviewer 来源，并越过只整理 plan/review 的职责自行补判。Reviewer 维度记 passed，最终 Main 维度记 failed，本例整体 failed。预算已锁定 stopped，剩余 104 次不自动转入新一轮。

原始 sessions.json、writer 输入、工件、score.json 和预算保存在 `.cynos/acceptance/run-record-accuracy-round4/frozen/live/`，结束轮次的任何记录不修改。修订 main-finalization 指令，要求 Reviewer 已交付的期望适用性、范围解释和结论依据继续归 Reviewer；不能声称 Reviewer 未作判断后由最终 Main 补判。审核内部矛盾仍按既定结果聚合规则处理并保留来源，不扩大最终 Main 的读取权限。新增角色资源防回归断言，角色加载、记录精度和生产 Pi 定向回归共 36 项通过。当前源码的 quality 镜像 `sha256:9b980c14dc659f009a253ae1bdfcec1baad83ad3427ae0403baf6c2d26cff567` 完整本地验收通过，覆盖 40 文件 / 305 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）；live/release 因未提供外部联合验收输入保持 blocked。以上只证明约束和工程回归，不能冒充模型复验通过；下一轮仍须重新冻结候选并获得独立预算。

### 第五轮材料准备（2026-09-21）

第五轮冻结当前提交 `558ef0ac3a47723fdeaf143ca1daae72dcc5d6f4`，使用 quality 镜像 `sha256:9b980c14dc659f009a253ae1bdfcec1baad83ad3427ae0403baf6c2d26cff567`。与第四轮 manifest 对比，候选文件只变化 `resources/agent-roles/main-finalization.md`；六例 inputs.json 与 rubric.json 逐字节不变，SHA-256 分别保持 `ea4ce9def8ff918898cc7f1a728c55ceddd7d16b845a1829bf071f3999203d5d` 和 `b08a437d1ac630d15c7167ffd65bbb8365bee7b779cb4623b05991a64f5cbe61`。比较记录位于 `.cynos/acceptance/run-record-accuracy-round5/candidate-diff.json`，不修改第四轮材料或评分追求通过。

新冻结目录为 `.cynos/acceptance/run-record-accuracy-round5/frozen/`。六例零模型预检全部通过：每例 Reviewer 都在成功读取 execution.md 后才写 review，最终 Main 只读取 plan.md 与 review.md。当前 quality 镜像中的角色加载、记录精度和生产 Pi 定向回归 3 文件 / 36 项通过；既有同一源码完整本地验收仍为 40 文件 / 305 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）通过。

现有 Secret Store 的禁网可用性检查通过，输出仅确认 provider key 可用，modelRequests=0，不输出凭据。第五轮尚未启用真实模型预算，humanScoring=not_run；前四轮的预算、工件和失败结论保持不变，任何剩余请求都不转入本轮。下一步需明确批准新的 120 次请求上限，仍按 SOURCE-P、SOURCE-N、TIME-P、TIME-N、COUNT-P、COUNT-N 顺序逐例独立判分，任一案例失败即停止。live/release 继续 blocked。

### 第五轮首例与证据清单计数修复（2026-09-22）

负责人明确批准第五轮独立 120 次请求预算后执行 SOURCE-P，Run `01M32FS54FDGV8087Y3JRRRZ12`，共 9/120 次请求、2 个隔离 Session。Reviewer 成功读取 execution.md，准确引用 Runner 的“观察到 Login rejected”，把 passed 归为自己的快照核对判断，并明确预置快照不证明实际浏览器执行。最终 Main 保留了 Reviewer 的判断来源和适用性边界，第四轮发现的来源改写问题没有重现。

但最终报告的覆盖缺口同时写了“唯一证据为预置合成快照”和“本 Run 证据列表为空”。实际 `list_evidence_files` 返回一个 browser 工件，报告要表达的是没有 command、MCP、控制台或实际操作归属记录，不能扩大成零证据文件。这个矛盾会让证据清单及计数失真，因此 Reviewer 维度记 passed，最终 Main 维度记 failed，SOURCE-P 整体 failed。两份 writer 原始输入与落盘工件 SHA-256 相同，预算已锁定 stopped；SOURCE-N、TIME-P/N、COUNT-P/N 均未运行，剩余 111 次不转入后续轮次。humanScoring 保持 not_run。

原始 sessions.json、工件、独立 score.json 和预算保存在 `.cynos/acceptance/run-record-accuracy-round5/frozen/live/`，结束轮次记录不修改。修订 main-finalization 指令：存在浏览器、图片或其他证据文件但缺少某类操作记录时，分别写清现有证据与缺失项；证据文件数量和类别须与 review.md 一致，不得把“没有某类证据”写成“证据列表为空”。新增角色资源防回归断言，角色加载、记录精度和生产 Pi 定向回归 3 文件 / 36 项通过。当前源码的 quality 镜像 `sha256:2e66f5387d391e5cb973509d0a4199f0324b06b292f75f9f08566531eccfdb83` 完整本地验收通过，覆盖 40 文件 / 305 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）；live/release 因未提供外部联合验收输入保持 blocked。修订后仍需新的独立模型轮次，不能改写第五轮失败结论。

### 第六轮传输停止与诊断保留（2026-09-22）

第六轮冻结提交 `a3161afeeffaa4dcde3d00c7d6c301af4f1b3e70` 与 quality 镜像 `sha256:2e66f5387d391e5cb973509d0a4199f0324b06b292f75f9f08566531eccfdb83`。六例 inputs.json 与 rubric.json 和第五轮逐字节相同；manifest 只有 `resources/agent-roles/main-finalization.md` 变化。六例零模型预检、工具顺序及 Secret Store 禁网检查通过，modelRequests=0。负责人批准新的 120 次请求上限后启动 SOURCE-P。

首个 Reviewer 请求在获得任何 HTTP 状态前失败，预算记录只有一次 `deepseek-v4-flash-vision-exp` 尝试，状态为 failed；Reviewer Session 没有工具调用，result.status=failed，未形成 review.md、report.md 或可判分的模型语义结果。驱动按传输失败规则将第六轮锁定在 1/120，SOURCE-N、TIME-P/N、COUNT-P/N 均未运行，剩余 119 次不重试也不转入后续轮次。humanScoring 与 semanticResult 均保持 not_run/not_evaluated。

本轮还暴露了评估驱动的诊断覆盖：代理已因传输或响应失败停止预算，CLI 外层捕获又把 reason 改成更泛的 case-delivery-failure。修订控制 helper，使外层只在预算尚未停止时写交付失败；已存在的最早传输停止原因保持不变。新增回归同时验证已有原因不被覆盖，以及非传输的普通交付失败仍记录 case-delivery-failure。角色加载、记录精度和生产 Pi 定向回归 3 文件 / 37 项通过。当前源码的 quality 镜像 `sha256:1805ef5a37e806a0cfee2c2057ff7833466acc987e268ef396b8ed4fe81190e0` 完整本地验收通过，覆盖 40 文件 / 306 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）；live/release 因未提供外部联合验收输入保持 blocked。第六轮原始 budget.json 不修改，无法从已覆盖的字段进一步断言 DNS、连接、超时或响应流中的哪一种具体原因；修订后的诊断行为仍需下一轮真实失败才能实证。

### 第七轮传输复现与阶段诊断（2026-09-22）

第七轮冻结提交 `0405f792e2c3637df7a55e907f5daedc92cfca57` 与 quality 镜像 `sha256:1805ef5a37e806a0cfee2c2057ff7833466acc987e268ef396b8ed4fe81190e0`。inputs.json、rubric.json 和所有角色指令与第六轮逐字节相同，manifest 只变化 `tests/acceptance/record-accuracy/cli.mjs` 与 `control.mjs`。六例零模型预检、工具顺序和 Secret Store 禁网检查通过，modelRequests=0。负责人批准新的 120 次请求上限后启动 SOURCE-P。

首个 Reviewer 请求再次在获得 HTTP 状态前失败，Reviewer Session 没有工具调用，也没有 review.md、report.md 或可评分的模型语义结果。新驱动成功保留 budget.reason=`transport-or-response-failure`，证明 CLI 不再覆盖先前停止原因；本轮在 1/120 次请求后锁定，剩余五例未运行，119 次不重试也不转入后续轮次。humanScoring 与 semanticResult 保持 not_run/not_evaluated。

固定 reason 仍把请求建立、超时、HTTP 拒绝、响应流损坏和缺失结束标记合在一起；本轮 attempt 没有 httpStatus，只能排除“已记录 HTTP 状态后失败”，不能再追溯具体阶段。评估代理改为在 attempt 中写受控 failureCategory：upstream-connect、upstream-timeout、upstream-http、upstream-missing-body、response-stream-error、response-too-large、response-incomplete 或 consumer-disconnected，不保存原始异常消息、响应正文、请求内容或凭据。已有第七轮 budget.json 保持不变；新增本地故障回归分别覆盖 HTTP、超时、响应流错误和缺结束标记。角色加载、记录精度和生产 Pi 定向回归 3 文件 / 37 项通过。当前源码的 quality 镜像 `sha256:16cb9d5f0b24944906e052dd82f78a86e62e11a2bca1562f036366303f8b0bec` 完整本地验收通过，覆盖 40 文件 / 306 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）；live/release 因未提供外部联合验收输入保持 blocked。新的 failureCategory 尚未经过真实失败实证。

### 第八轮三例通过与连接阶段实证（2026-09-22）

第八轮冻结提交 `33d97986e75b5b6edc35e37d7acfbb62a6bd4f90` 与 quality 镜像 `sha256:16cb9d5f0b24944906e052dd82f78a86e62e11a2bca1562f036366303f8b0bec`。六例 inputs.json、rubric.json 和角色指令与第七轮逐字节相同，SHA-256 分别为 `ea4ce9def8ff918898cc7f1a728c55ceddd7d16b845a1829bf071f3999203d5d` 与 `b08a437d1ac630d15c7167ffd65bbb8365bee7b779cb4623b05991a64f5cbe61`；候选只变化 `tests/acceptance/record-accuracy/proxy.mjs`。六例零模型预检通过：Reviewer 均在成功读取 execution.md 后才提交审核，最终 Main 只读取 plan.md 与 review.md。已有 Secret Store 的禁网可用性检查通过，预检阶段 modelRequests=0。

负责人批准独立的 120 次请求上限后，按固定顺序执行 SOURCE-P、SOURCE-N、TIME-P 和 TIME-N。前三例共使用 29 次请求并通过独立核对；每份 writer 原始输入与落盘工件 SHA-256 相同，humanScoring 保持 not_run。

| 案例 | Run | 累计请求数 | 核对结果 |
| --- | --- | --- | --- |
| SOURCE-P | `01M330TPQ8M6TGCTAR594GBRY5` | 9 | passed：Reviewer 准确引用 Runner 观察并独立判定；最终 Main 保留来源，证据清单为 1 项 browser 证据，缺失项准确限定为 command/MCP/操作归属记录 |
| SOURCE-N | `01M330YMF7T0TGW9JX8XARZ0PG` | 19 | passed：标题发现归 Reviewer，Runner 的执行叙述未被扩写成标题观察或结果判定；最终 Main 保留 Reviewer 的适用性判断来源 |
| TIME-P | `01M3311EZMCB3Y5GPY82KRP5M3` | 29 | passed：使用同一 `fixture-clock` 的原点 `1789948800000ms`、偏移 `1250ms` 和单位 `ms` 得出 `2026-09-21T00:00:01.250Z`；最终 Main 完整保留依据、来源和真实时钟未验证的限制 |
| TIME-N | `01M3314VQTJEM8ZHWM5K7QEDXJ` | 30 | 交付失败：首个 Reviewer 请求未取得 HTTP 状态，Session 无工具调用、无 review/report，semanticResult=not_evaluated |
| COUNT-P/N | 未运行 | 0 | 按失败即停约定未启动 |

TIME-N 的第 30 次 attempt 记录 `status=failed`、`failureCategory=upstream-connect`，budget.reason 保持 `transport-or-response-failure`。这实证了新诊断可以把取得 HTTP 状态前的失败归到上游连接阶段，同时仍不保存原始异常、响应正文、请求内容或凭据。它不能继续细分为 DNS、TCP 或 TLS，也不能冒充 TIME-N 的模型语义结果。预算已锁定 stopped，剩余 90 次不重试、不转入下一轮。

第八轮原始预算、Session、writer 输入、工件及三例独立 score 保存在 `.cynos/acceptance/run-record-accuracy-round8/frozen/live/`。前三例通过不能补齐 TIME-N 与计数正反例，也不能与旧轮次拼成六例全通过；live/release 继续 blocked。当前节点只新增验收记录，没有修改生产代码；同一候选此前的定向回归与完整本地验收仍为 3 文件 / 37 项、40 文件 / 306 测试及 Phase 9（34 AC）通过。

### 第九轮连接失败复现（2026-09-22）

第九轮复用第八轮逐字节相同的 inputs.json、rubric.json、角色指令和候选 manifest；当前提交 `d2efd06030c290705b6f8ac2d46037468fa78f96` 只比第八轮候选多 README 与本计划的验收记录，不改变 manifest 内的被评估源码。六例零模型预检再次通过，Reviewer 均在成功读取 execution.md 后才可写审核，最终 Main 只读取 plan.md 与 review.md；Secret Store 禁网检查通过，modelRequests=0。

负责人批准独立的 120 次请求上限后启动 SOURCE-P，Run `01M331Z0KHHCP84ZKK5R67GT2S`。首个 `deepseek-v4-flash-vision-exp` 请求未取得 HTTP 状态，attempt 记录 `status=failed`、`failureCategory=upstream-connect`，budget.reason 保持 `transport-or-response-failure`。Reviewer Session 无工具调用，未生成 review.md、report.md 或可评分的模型语义结果；humanScoring=not_run、semanticResult=not_evaluated。

驱动在 1/120 次请求后锁定本轮，SOURCE-N、TIME-P/N、COUNT-P/N 均未运行，剩余 119 次不重试也不转入下一轮。该结果再次证明连接阶段失败可以被稳定识别，但不能区分 DNS、TCP 或 TLS，也不能说明模型语义能力。第九轮没有暴露新的产品代码问题，因此不为同一外部连接失败修改生产代码；下一步先在相同容器网络路径做不带凭据、不计模型请求的连接诊断，再决定是否申请新的模型轮次。live/release 继续 blocked。
