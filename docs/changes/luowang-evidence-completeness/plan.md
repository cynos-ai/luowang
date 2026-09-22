# 证据完整性实施计划

基线：73ccb31，fix/reviewable-run-evidence、草稿 PR #71。2026-09-21 项目负责人批准审核安排。

1. **填写记录节点**：A1 与截图计划阶段 3 合并实现。修改 browser-observation，复用 Evidence Store 登记、同值标识和 command 读取；补两个真实 MCP 入口、随机输入、批量校验/登记故障、实际失败和 Run 隔离回归。通过容器质量检查后提交并 push。
2. **导航快照节点**：A2 复用现有快照解析与 browser 文件通道，补真实结果到文件的关联、填写值登记、脱敏、上传及读取证明；缺失/异常与路径边界回归通过后 push。
3. **类别预检节点**：A3 集中工具证据规则，实际发现清单预检与运行时兜底，验证未知工具不能静默放过；通过检查后 push。
4. **指令及模型节点**：修来源、时间和计数指令，先做零模型加载检查；冻结六个正反案例及判分标准，明确预算后单独验证。不得以此安排提前合并 #71，不把工程通过算成模型通过。

每个节点更新实际完成证明。禁止改历史样本追分；不新增发布门禁、不兼容旧格式。A1/A2/A3 工程已实现；B 角色指令及六例模型语义验证已完成，第十一轮六例全部通过独立工件核对。humanScoring=not_run；完整外部联合验收与正式发布状态不由这组六个合成案例替代，整体 live/release 仍 blocked。

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

### 第九轮后 TLS 诊断与固定分类（2026-09-22）

push 第九轮记录后，使用同一 `luowang:failure-stage-quality` 容器网络路径做无凭据诊断，只访问 `api.deepseek.com`，不调用 `/chat/completions`，modelRequests=0。三次收窄检查得到一致边界：DNS 解析成功且返回 IPv4，TCP 443 建连成功，TLS 握手失败；仅读取标准错误 code 后确认 `SELF_SIGNED_CERT_IN_CHAIN`。断网环境检查同时确认容器未设置 HTTP/HTTPS/ALL proxy、`NODE_EXTRA_CA_CERTS` 或 `NODE_TLS_REJECT_UNAUTHORIZED`。

该结果说明第八轮 TIME-N 和第九轮 SOURCE-P 的 `upstream-connect` 在当前环境中可进一步定位为容器不信任所见证书链。后续宿主机检查确认这是当前开发机的本地 HTTPS 拦截，不是 DeepSeek 服务、罗网代码或服务器部署的证书链缺陷。诊断没有保存错误消息、证书正文、请求内容或凭据。不得通过关闭 TLS 校验、给 DeepSeek 域名单独跳过校验或把开发机拦截证书注入产品镜像继续验收；生产部署保持标准 TLS 校验。下一次模型轮次应在没有本地 HTTPS 拦截的服务器或干净网络环境中执行，并重新申请独立预算。

评估代理增加安全的固定分类：从异常及最多四层 cause 中只读取标准 `code`，将 `ENOTFOUND/EAI_AGAIN` 记为 `upstream-dns`，已知证书错误及 `ERR_TLS_`/`ERR_SSL_` 记为 `upstream-tls`，超时保持 `upstream-timeout`，其余建连异常保持 `upstream-connect`。预算仍在首次失败后锁定，原始异常不进入记录。新增 DNS、TLS 和普通连接三项回归后，record-accuracy 19 项测试、格式和 lint 通过；新 quality 镜像为 `sha256:6b407875049fa4ac3a4a1af5b5e1a92ec1b4b62b2b3bdc346fbc552b8a139066`。完整本地验收退出 0，覆盖 40 个测试文件 / 309 项测试、格式、lint、类型检查、构建、e2e 和 Phase 9（34 AC）；local=passed，live/release=blocked。该分类修订尚未调用真实模型验证。

### 第十轮本机复验与范围否定反转（2026-09-22）

负责人批准独立 120 次请求预算并明确先用本机继续。启动前从同一 quality 容器做无凭据检查：DNS 与 TCP 443 成功，TLS `authorized=true`，无鉴权请求返回 HTTP 401，modelRequests=0；没有关闭证书校验、增加额外 CA 或修改产品/部署配置。第十轮冻结提交 `9bbc4db7f3c8975c5fda3f018812c1cd4c4ceb79` 与 quality 镜像 `sha256:6b407875049fa4ac3a4a1af5b5e1a92ec1b4b62b2b3bdc346fbc552b8a139066`。inputs.json、rubric.json 与第九轮逐字节相同，候选 manifest 只变化 `tests/acceptance/record-accuracy/proxy.mjs`；六例零模型预检和 Secret Store 禁网检查通过。

按固定顺序执行 SOURCE-P、SOURCE-N 与 TIME-P，共 6 个隔离 Session、29/120 次请求，全部取得 HTTP 200 且响应流完成。SOURCE-P（Run `01M33FQTW491REW0TQ5DYKR08R`，累计 10 次）和 SOURCE-N（Run `01M33FX2D7B9GF8DCNT7VHFQTC`，累计 19 次）均通过独立核对：Reviewer 区分 Runner 陈述与自身快照观察，最终 Main 保留判定来源、证据数量和无实际浏览器操作归属的限制。每份 writer 原始输入与落盘工件 SHA-256 相同。

TIME-P（Run `01M33G1H6JJC0NFFTECYEW27C2`，累计 29 次）的 Reviewer 正确使用同一 `fixture-clock` 的原点 `1789948800000ms` 与偏移 `1250ms` 得出 `2026-09-21T00:00:01.250Z`，并明确该换算不证明真实服务器时钟已校准；Reviewer 维度通过。最终 Main 也保留时间依据，却在测试范围首段把计划与审核的“不代表真实产品执行”写成“为代表真实产品执行”，反转范围并与同一报告后文矛盾。最终 Main 维度及本例整体记为 failed；预算锁定 stopped，TIME-N、COUNT-P/N 未运行，剩余 91 次不重试、不转入新轮。humanScoring 保持 not_run。

原始 result、sessions、writer 工件、独立 score 和 budget 保存在 `.cynos/acceptance/run-record-accuracy-round10/frozen/live/`，不修改结束轮次。最终汇总指令与 Spec 增加通用一致性要求：定稿前保留计划/审核中的范围限定和否定关系，不得把“不代表、仅限、未验证、无法确认”等压缩成相反结论；报告内部范围冲突须在 write_report 前修正。不增加语义关键词门禁，不改历史工件。角色加载、记录精度和生产 Pi 定向回归 3 文件 / 40 项通过；完整本地验收退出 0，覆盖 40 文件 / 309 测试、格式、lint、类型检查、构建、e2e 与 Phase 9（34 AC）。local=passed，修订尚未经过新模型轮次验证，live/release 继续 blocked。

### 第十一轮六例模型语义验收（2026-09-22）

负责人批准独立 120 次请求预算并要求在本机继续。启动前零请求检查确认 DNS、TCP、标准 TLS 和无鉴权 HTTP 路径可用；TLS `authorized=true`，HTTP 返回 401。Secret Store 禁网检查只确认现有 Provider Key 可用，`modelRequests=0`，没有输出凭据。未关闭 TLS 校验、注入本机 CA、增加 DeepSeek 域名例外或修改产品部署配置。

第十一轮冻结提交为 `f1dc00f7dc052753218a515c29e6f4508b3b8fc9`，继续使用 quality 镜像 `sha256:6b407875049fa4ac3a4a1af5b5e1a92ec1b4b62b2b3bdc346fbc552b8a139066`。inputs.json 与 rubric.json 和第十轮逐字节相同；候选 manifest 的唯一变化是 `resources/agent-roles/main-finalization.md`。六例断网预检通过，记录为 6 个案例、0 次模型请求、`humanScoring=not_run`。

按固定顺序完成全部六例，共 12 个隔离 Session、50/120 次请求；50 次上游请求均返回 HTTP 200 并完整交付。每例都在下一例开始前由 Codex 独立读取 result、Session 工具轨迹、writer 原始输入和四份工件，分别记录 Reviewer 与最终 Main 的判断，再生成绑定 result、sessions 和工件 SHA-256 的 score.json。所有 writer 原始输入与对应落盘 review/report 哈希一致。

| 案例 | Run | 累计请求数 | 独立核对结果 |
| --- | --- | ---: | --- |
| SOURCE-P | `01M33JJQ5A2KWEHV6VD6BQEDQY` | 8 | passed：Runner 引文、Reviewer 独立观察和判定来源区分正确；预置快照未被写成实际浏览器执行 |
| SOURCE-N | `01M33JNTY4758G8P3VW3MDQC27` | 17 | passed：标题发现归 Reviewer，未伪造 Runner 发现；合成材料范围和操作归属限制保留 |
| TIME-P | `01M33JRWZBHSSF8JDABA524RFQ` | 25 | passed：按同一 fixture-clock 原点和 1250ms 偏移得到 `2026-09-21T00:00:01.250Z`；未外推为真实服务器时钟 |
| TIME-N | `01M33JVKF9RVXDQBJZ64AT2JV5` | 33 | passed：只确认 1250ms 相对偏移；未借文件或 Harness 操作时间拼接绝对事件时间 |
| COUNT-P | `01M33JYBS9KE3VM51GAF0A0J1E` | 42 | passed：一个场景内 A/B/C confirmed、D unverified，按 3+1 保留 D，场景 blocked |
| COUNT-N | `01M33K3JYDDMAKDAQHR0KDTV2M` | 50 | passed：识别 Runner 摘要与四行明细冲突，按原始证据采用 3+1，未发明第五项 |

TIME-P 的最终报告保留“只审核合成材料、不代表官网执行、不证明真实服务器时钟”等否定和限定，未复现第十轮的范围反转。六例的 Reviewer 与最终 Main 维度均通过，预算未因失败停止；剩余 70 次随本轮结束，不转入其他轮次。原始冻结材料、预算、Session、工件和 score 位于 `.cynos/acceptance/run-record-accuracy-round11/frozen/live/`，历史轮次未修改。

这证明当前候选在固定六例中满足来源、时间和计数的模型语义要求，B 节模型验证完成。它不包含真实官网操作、报告发布、目标 Git/Issue 写入或人工评分，不能代替完整外部联合验收；`humanScoring=not_run`，项目整体 live/release 仍 blocked。

### 当前候选完整联合验收与后续计划（2026-09-22）

负责人批准后，以提交 `6c93037c6ed10b24bb6a79cbcc3508a9edf0f084` 和 runtime 镜像 `sha256:5f0f68d60af23ace9c3cf14764931f11da4aaa221df687df691d47df3eb13436` 执行 normal、defect、blocked 三例。固定官网 target 为 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`，目标镜像为 `sha256:8acf63fd25d73e71bf4d73edfa8755d6a6d4a0bda8e70ee4954a7f5ea8a537cd`。启动前的零模型预检通过：原生 MCP、浏览器、Cookie 读取/恢复、截图、只读容器和六个 tmpfs 均可用；候选源码、镜像内六份角色资源及驱动哈希一致。

三例共使用 12 个隔离 Session 和 233/400 次模型请求，其中 `deepseek-v4-flash` 209 次、`deepseek-v4-flash-vision-exp` 24 次；全部请求返回 HTTP 200 并完整结束。三例 Run 都完成四阶段交付、自动归档和清理，但最终结果均为 blocked：

| 样本 | Run | 请求数 | 结果及独立核对 | 报告提交 |
| --- | --- | ---: | --- | --- |
| normal | `01M33MYN0YAMPNW5PA50VQSDSZ` | 93 | Reviewer 依据原 Cookie、恢复值、真实 request headers 和 401 判定 A–D 全部 passed；7 份表单快照采集失败及通用 MCP 证据失败使 Run 聚合为 blocked | `5daa84ab0d8240721e7a89b60049f55a764e229d` |
| defect | `01M33NBRWACRX2E37GAHXJ7069` | 48 | 目标已注入退出不撤销 Session；Runner 的填表调用在执行前因参数形态错误被拒，未建立登录态，只得到匿名 401，未观察到注入缺陷 | `096da26563e6b4745267e29b8256fc030bdca100` |
| blocked | `01M33NKSTFC65HNKBE222P7JV0` | 92 | Reviewer 实际遇到 23 次注入的 operation 读取失败，保留 A/B passed，C/D 因无法核对原 Cookie 与请求头保持 blocked，没有用普通 401 替代 | `5d21614623253bb4c6886a7b9c34bade559f925f` |

本地共有 7 张 PNG，6 张成功上传；逐张查看确认拒绝登录截图保留已填邮箱和掩码密码，删除后截图保留邮箱，没有为截图清空或覆盖表单。`after-delete.png` 遇到一次 OSS 上传失败，只保留在本地。已上传对象与本地 SHA-256 一致；远端六份 report/review Git blob 与本地字节一致。三个目标数据库停止前均为 `users=0、sessions=0`，三个清理接口均返回 `remaining=0`。

本轮发现两个必须先修的问题。第一，`browser-snapshot.ts` 不接受 Playwright 在真实表单快照中使用的嵌套 textbox 节点，解析报 `Unsupported field value`；失败文件不上传，但未完成本地脱敏。27 份页面快照中有 2 份失败快照保留了密码输入框明文值，未进入 OSS 或 Git，对应合成账号和 Session 已清理。第二，执行前的填表参数校验失败也调用通用证据失败回调，使没有执行的无效调用永久增加 `MCP 操作证据捕获失败`；这与工具路由/参数错误不能冒充证据损坏的规则不符。defect 样本因此没有验证到注入缺陷。

固定 quality 镜像内的 `test:acceptance:local` 通过。宿主机第一次运行因 `better-sqlite3` Node ABI 与 Node 24 不一致失败，不计为代码失败。官方 `test:acceptance:live` 仍 blocked：它要求首次 initialization、passed、包含两个独立 confirmed Bugs/Issues 的 failed、blocked、场景审核 PR 和当前 HEAD 重测等完整 Closure 7 历史事实；本轮三例不满足这组门禁，不能称 release passed。`humanScoring=not_run`。

后续按以下顺序执行，每一项形成独立可 push 节点：

1. **表单快照与失败路径**：支持真实 Playwright 嵌套 textbox 结构，在保存前登记并脱敏字段；捕获或解析失败时也不得留下可恢复的原字段值。增加邮箱、密码、空值、placeholder、格式错误和失败清理回归。截图仍保留原页面状态，不清空表单，不兼容旧快照格式。
2. **错误分类**：把执行前参数/路由拒绝与真实证据捕获、完整性、上传和读取失败分开。无效调用返回具体错误但不增加证据损坏阻塞；真实证据失败继续阻塞并保留受控诊断。
3. **Runner 与上传稳定性**：按当前工具合同明确只使用 `target`，不接受旧 `ref` 形态；补模型执行回归，确保被拒后能按现行 schema 恢复。OSS 上传增加有界重试和每次尝试的受控收据，重试后仍失败才阻塞。
4. **工程验收**：先跑快照、browser observation、Evidence Store、截图标签和上传专项，再在当前提交的 quality 镜像运行完整 `test:acceptance:local`。任何未脱敏本地快照、标签/图片哈希不一致或 evidence 失败都不得进入模型轮次。
5. **三例复验**：重新申请独立模型预算，仍按 normal → defect → blocked 顺序。验收线为 normal=passed；defect 能确认退出缺陷并只关联既有 issue #5；blocked 因注入读取失败保持 blocked；三例归档、清理、图片读取和远端字节核对全部通过。
6. **正式门禁决策**：三例通过后，再处理 Closure 7 要求两个独立 Issue 与当前“不创建新 Issue、只关联 #5”之间的冲突。在负责人决定修改门禁或准备第二个既有 Issue 前，不运行 release 验收。

### 修复候选三例复验（2026-09-22）

负责人批准继续后，冻结提交 `0c696f09112101b7d6cf41c874c04d49dea27a47`，构建 quality 镜像 `sha256:9241c483838f0e8ea61354a8db8e9b1b5947e6c6f2711cf8bf68610e98159e30` 和 runtime 镜像 `sha256:35cb71fc92af3fcc7cebeacdc429905154fea0449094999ec7250e7cf5bcb24f`。固定官网 target 与目标镜像保持为 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23` 和 `sha256:8acf63fd25d73e71bf4d73edfa8755d6a6d4a0bda8e70ee4954a7f5ea8a537cd`。断网、只读 runtime 预检通过，六份镜像内角色资源与源码 SHA-256 一致；同容器网络路径的 DNS、TCP 443 和标准 TLS 通过，无鉴权请求返回 HTTP 401，预检阶段模型请求为 0。没有关闭 TLS 校验、增加额外 CA 或设置域名例外。

当前 quality 镜像的 `test:acceptance:local` 退出 0，结果为 local=passed、live=blocked、release=blocked。live/release 的状态来自正式 Closure 7 外部事实未齐，不是本地工程检查失败。随后按 normal → defect → blocked 完成三例，共 12 个隔离 Session、240/400 次请求；`deepseek-v4-flash` 205 次，`deepseek-v4-flash-vision-exp` 35 次，全部取得 HTTP 200 并完整交付。

| 样本 | Run | 累计请求数 | 结果及独立核对 | 报告提交 |
| --- | --- | ---: | --- | --- |
| normal | `01M33ZHXAK5DEB9TPFVDJ47AEH` | 82 | `passed`。四条适用期望均由 Reviewer 依据原 Cookie、恢复值、真实请求头和响应闭合；`after-refresh.png` 第一次上传注入 connection 故障，第二次重试成功，Run 无上传阻塞 | `1f157d819815fdfa0981535301348d65d4cd46fd` |
| defect | `01M33ZSFV2TZMX698355WGZ6MX` | 164 | `failed`。Runner 使用当前 `target` 参数建立登录态；退出后恢复原 Cookie，状态接口仍返回 authenticated=true，同一会话还能删除账号，Reviewer 确认退出未撤销 Session，只选择 link 既有 Issue #5，不创建新 Issue | `2abafffe804647862b3c6b0ef618b8ccae8bf014` |
| blocked | `01M3402YTEJ8TJ6RW2ZPHQS397` | 240 | `blocked`。Reviewer 遇到 13 次受控 operation 读取失败，只保留可从页面快照和日志直接观察的事实；原 Cookie 与真实请求头无法关联的期望 C/D 继续 blocked，没有用普通 401 替代 | `df6b038d0b17d7558c1a908a325dc8b464a3b186` |

三例共保留 152 份 command/operation 记录，Reviewer 发起的成功 OSS 读取均与本地文件 SHA-256 一致；blocked 的 13 次读取故障按注入保留。normal 和 defect 共 4 张 PNG，Reviewer 全部实际读取。逐图检查确认两张欢迎页保持登录现场；删除后登录拒绝图保留已填邮箱和掩码密码；没有为了截图清空、覆盖或遮挡表单。图片包含的合成字段值按已批准规则保留并进入 OSS。32 份本地页面快照没有原账号邮箱命中，没有 `Unsupported field value`、采集失败文件或未清理的原表单值迹象。三例共有 9 次 `browser_fill_form`/`browser_type` 记录，全部使用 `target`，旧 `ref` 调用为 0，参数记录中的邮箱值均已脱敏。

normal 的上传收据明确记录 `after-refresh.png` attempt 1/3 failed connection 并安排重试，attempt 2/3 succeeded；最终没有 `证据上传失败` 或 `MCP 操作证据捕获失败` 阻塞。全部三次归档只新增当前 Run 的 report/review，远端六个 Git blob 与本地最终工件一致；`scenario-testing` 远端 HEAD 为 `df6b038d0b17d7558c1a908a325dc8b464a3b186`。三套目标数据库停止前均为 users=0、sessions=0，三个独立清理查询均返回 remaining=0。当前 Run 的 Markdown 在发布前使用当轮 API Key、Token、OSS 凭据、随机账号和口令做精确扫描，均无命中；`humanScoring=not_run`。

三例复验达到本计划第 5 步的验收线。仍有两项范围限制：defect 没有直接取得计划字面要求的 `GET /api/me` 401/非 401，但原 Session 在状态接口继续认证且能执行删除账号，Reviewer 据此确认同一退出缺陷；blocked 没有像素截图，因此除了命令证据读取失败外还存在 UI 截图缺口。两项均已写入各自正式报告，不改写本轮结果。

下一步进入第 6 步正式门禁决策。现有授权只允许关联 Issue #5、不创建新 Issue，而 Closure 7 live 门禁要求 failed 历史中存在两个独立 confirmed Bugs/Issues。负责人决定调整门禁口径或指定第二个既有 Issue 前，不运行 release 验收，也不把本轮三例通过扩大成正式发布结论。

### Closure 7 双缺陷 Run 与第二条 Issue（2026-09-22）

负责人确认目标项目本身用于测试，同意通过真实 Run 创建第二条 Issue。测试仍固定使用官网 target `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`，Main/Runner 使用 `deepseek-v4-flash`，Reviewer 使用 `deepseek-v4-flash-vision-exp`。专用目标同时注入两个独立缺陷：退出接口不撤销服务端 Session；删除接口返回成功，但不删除账号或 Session。第一个缺陷应关联既有 Issue #5，第二个缺陷没有同类 Issue 时由 Archiver 创建新 Issue。

首轮 Run `01M3427WNHX1EX4PWWF9PMK6MG` 在 160/160 次请求时停止。160 次请求均返回 HTTP 200，但 Runner 在 `start_scenario` 前重复调用 `browser_cookie_list` 136 次，并在未读取真实 Cookie 前调用 `cookie_set`，未进入正式场景，也未启动 Reviewer。该 Run 没有业务结论、没有归档、没有创建 Issue；收尾后目标数据库为 users=0、sessions=0，清理查询 remaining=0。首轮余额不转入后续轮次。

第二轮增加明确的执行顺序和重复限制：Runner 首项必须是 `start_scenario AUTH-LOGIN-001`；Cookie 只能使用本轮真实读回值，同一状态不得重复轮询；完成验证后立即写 execution 并结束。Run `01M342XE5V39VTB8AQSSARMMFC` 创建四个隔离 Session，使用 80/300 次请求，其中 `deepseek-v4-flash` 68 次、`deepseek-v4-flash-vision-exp` 12 次；全部请求返回 HTTP 200 并完整交付。Runner 按要求先开始场景，两个登录状态下各调用一次 `cookie_list` 和 `cookie_get`，没有再次出现轮询。

Reviewer 依据真实请求头、响应和页面状态确认两项独立缺陷：

1. 退出页面返回登录态且接口返回 200，但恢复退出前 Session 后，携带该 Session 的 `GET /api/me` 仍返回 200。最终报告选择 link Issue [#5](https://github.com/cynos-ai/cynos-website/issues/5)。
2. 删除接口返回 200，页面提示账号及会话已删除；恢复删除前 Session 后 `GET /api/me` 仍返回同一用户，原邮箱和口令也能再次登录。最终报告选择 create，Archiver 创建 [#12](https://github.com/cynos-ai/cynos-website/issues/12)。

两条 confirmed bug 的 key、标题和 Issue URL 均不同，两个归档动作均为 `succeeded`。Issue #12 为 open，正文包含 `luowang-run:01M342XE5V39VTB8AQSSARMMFC`、`luowang-bug:delete-account-ineffective`、target commit 和场景 ID。Run 结果为 failed，自动归档提交为 `f4800046e7797109527371504d97f778926ca957`；提交只新增该 Run 的 report/review，两份本地工件与 Git blob 一致。

Reviewer 成功读取 70 份证据，包括 52 条操作收据、14 份页面快照和 4 张截图，没有受控读取失败。人工逐图核对确认登录、退出、删除提示和删除后重新登录状态与报告一致；删除提示截图保留邮箱字段，没有为了取证清空或覆盖表单。登录刷新与删除后重新登录两张截图字节相同，Reviewer 已将后一张降为辅助材料，删除后仍可登录的结论以场景内页面快照和 HTTP 200 为主。发布前的当轮 Secret/账号精确扫描无命中。

归档后清理查询 remaining=0，目标数据库停止前为 users=0、sessions=0。当前 HEAD `94e4205a5d097bdae9c2098e88358e7447abdeef` 相比 runtime 来源 `0c696f09112101b7d6cf41c874c04d49dea27a47` 只增加 README 和本计划的验收记录，没有代码或角色指令差异。

这次 Run 补齐了“同一个 failed Run 有两个独立 confirmed Bugs，并成功归档到两个不同 Issue”的单项事实。正式 Closure 7 仍未通过：现有 passed、failed、blocked 事实分布在不同的临时数据库里，且尚未在同一持久候选实例完成首次 initialization、三 Session 场景审核 PR、PR 合并后的 current-head passed 重测及最终 live/release 检查。不能把本次双 Issue 成功写成 release passed。`humanScoring=not_run`。

### Closure 7 历史事实审计（2026-09-22）

为确认现有历史能否直接用于正式门禁，本轮只读扫描 `.cynos/acceptance/**/luowang.db`，严格复用 `tests/acceptance/closure.ts` 中 `selectLiveFacts()` 的筛选条件。共检查 127 份数据库，只有 6 份命中至少一项 Closure 7 事实：

| 数据库 | 可用事实 |
| --- | --- |
| `run-joint-acceptance-0c696f0/live-data/state/luowang.db` | 含截图的 passed Run `01M33ZHXAK5DEB9TPFVDJ47AEH`；不推进的 blocked Run `01M3402YTEJ8TJ6RW2ZPHQS397` |
| `run-closure7-dual-bug-round2-94e4205/live-data/state/luowang.db` | 双 confirmed Bug、双 Issue 的 failed Run `01M342XE5V39VTB8AQSSARMMFC` |
| `run-evidence-followup/live-data/state/luowang.db` | 含截图的 passed Run `01M2VZGC4D8AGZWPT164BBW0TV` |
| `run-evidence-followup-v41/live-data/state/luowang.db` | 不推进的 blocked Run `01M2WS1AFYVBDS40N4PK0PHQ9K` |
| `run-blocked-closure/live-data/state/luowang.db` | 不推进的 blocked Run `01M2YVAJV51D6AJG6WE873278H` |
| `run-joint-acceptance-6c93037/live-data/state/luowang.db` | 三个不推进的 blocked Run `01M33MYN0YAMPNW5PA50VQSDSZ`、`01M33NBRWACRX2E37GAHXJ7069`、`01M33NKSTFC65HNKBE222P7JV0` |

127 份数据库的 `test_request_queue` 都为空。没有数据库保存首次 initialization queue/run、三 Session 特殊场景 PR Run、`manual-current-head` passed 重测或同时带“开始场景”和“完成场景”活动的 passed Run。现有单项事实也不在同一个持久实例中，不能通过复制、拼接或改写数据库把它们变成一条真实历史。

GitHub 远端仍保留三条以 `scenario-testing` 为 base 的真实场景审核 PR：[#4](https://github.com/cynos-ai/cynos-website/pull/4) 对应 Run `01M1G225V3E3GZY46RW0CG5KR1`，已合并；[#7](https://github.com/cynos-ai/cynos-website/pull/7) 对应 Run `01M1GNA28DD9HJ1F7PN71V9ZD0`，已关闭未合并；[#8](https://github.com/cynos-ai/cynos-website/pull/8) 对应 Run `01M1H4F72HSFS5MHE41M894RKE`，已合并。这些 PR 能证明远端曾发生场景审核，不能替代候选实例已经丢失的 Run、工件契约和 queue 关联。远端 `scenario-testing` 当前 HEAD 为 `f4800046e7797109527371504d97f778926ca957`，分支已存在；在不删除现有分支和历史报告的前提下，无法重新产生 `preparedMergeMode=initial-create` 的首次创建事实。

因此，当前固定目标 `cynos-ai/cynos-website` 无法用现有历史合法完成 Closure 7。继续重复普通 Run 只能增加 passed、failed 或 blocked 事实，补不回 initialization queue。正式 live/release 保持 blocked；下一步需要负责人明确更换一个尚无 `scenario-testing` 的独立测试仓库，之后从首次创建开始在同一个持久候选实例按门禁顺序执行。现有目标分支、报告和数据库均保持原样。

### Closure 7 独立目标准备（2026-09-22）

负责人明确授权更换固定测试目标。本轮创建公开仓库 [`cynos-ai/luowang-closure7-fixture`](https://github.com/cynos-ai/luowang-closure7-fixture)，并且只推送 `main`。`main` 直接指向原官网固定提交 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`，因此产品代码、需求和已有文件树没有重新打包或改写；新仓库没有继承原仓库的其他分支、PR、Issue 或候选数据库事实。

远端复核结果：仓库为 public，默认分支为 `main`，Issues 已启用；heads 列表只有 `main`，`scenario-testing` ref 返回 HTTP 404。新仓库满足 Closure 7 首次 `initial-create` 的 Git 前置条件。首次分支创建仍必须由新持久候选实例通过 `manual-merge-source` 队列完成，不能提前手工创建 `scenario-testing`。

本轮只准备仓库，没有启动 Harness、模型请求或 initialization Run，live/release 继续为 blocked。下一步使用新的数据目录启动单一持久候选实例，保存固定仓库、模型、MCP、OSS、清理地址和测试账号配置；零模型预检通过后，再从 `main@6405a45b6889ad92cf7cfbce12d8ec22b5040f23` 发起首次分支请求。后续 passed、双缺陷 failed、依赖 blocked、场景审核 PR、合并后 current-head passed 重测和最终只读 live 检查都必须留在该实例中。

### Closure 7 initialization 真实联合验收（2026-09-22）

本轮使用候选提交 `07e898901f0604c63740ca1ff21e44737349eb9c`，在新的持久数据目录 `.cynos/acceptance/run-closure7-persistent-07e8989/live-data/` 启动单一实例。零模型 runtime 预检通过；同一路径对 DeepSeek 的 DNS、TCP 443 和标准 TLS 检查通过，无鉴权请求返回 HTTP 401，预检模型请求为 0。第一次驱动执行在 Git 远端读取阶段遇到一次临时 `ls-remote` 失败，尚未创建 `scenario-testing`，也没有模型请求。失败记录原样保存在 proof 目录；驱动只增加三次有界远端读取重试，随后重新执行成功，没有删除或改写首次失败事实。

队列 `1` 以 `manual-merge-source + initialization=true` 从 `main@6405a45b6889ad92cf7cfbce12d8ec22b5040f23` 首次创建此前不存在的 `scenario-testing`。`preparedMergeMode=initial-create`，prepared、resolved 和 Run target commit 都是该固定 source；队列最终为 completed，archiveStatus=completed，只创建一个 initialization Run `01M348D1DVD9S0J9YTJ6Y8JTSB`。该 Run 复用目标中已有的 approved 场景 `AUTH-LOGIN-001`，没有生成 `scenario-changes.patch`。

Run 按 Main · 规划 → Runner → Main · 规划 → Runner → Reviewer → Main · 最终汇总创建六个不同 Session，结果为 passed，进度为 1/1。四份工件 `plan.md`、`execution.md`、`review.md`、`report.md` 已进入 completed 目录。完整证据共 111 个 JSON、6 个日志、9 张 PNG 和 26 个 YAML；Reviewer 实际读取截图并核对登录、刷新、退出、删除和拒绝登录状态。9 张截图保留真实页面现场和合成邮箱字段，密码保持掩码，没有为了截图清空、覆盖或遮挡表单。

本轮使用 152/180 次模型请求：`deepseek-v4-flash` 137 次，`deepseek-v4-flash-vision-exp` 15 次；152 次均为 HTTP 200、响应流完整，`budget.stopped=false`。Harness 清理收尾记录两项测试数据均已独立核验不存在，因此驱动再次调用 cleanup 时 attempted=0；独立清理查询返回 remaining=0，目标数据库停止前 users=0、sessions=0。当前 Run 的 Markdown 对已知凭据和账号值做精确扫描，无命中。`review.md` 在 Harness 清理前生成，清理事实由 Harness 追加到 `report.md`，不回写审核工件。

归档提交为 `2c4684c50a58cf7728041b4cba50ca46b54d6723`，父提交正是 `6405a45b6889ad92cf7cfbce12d8ec22b5040f23`。提交只新增 `docs/scenario-testing/reports/01M348D1DVD9S0J9YTJ6Y8JTSB/report.md` 和 `review.md`；远端两份文件与本地 completed 工件逐字节一致，SHA-256 分别为 `3e670b4b74b001ab6c6d062db698f68b53b3f52e9a9cf88c1bca5e022da63a4d` 和 `55f02ea1380b729ea4aecd91fa9a4b55ced4e94a5c7a9ba56aedfc3dcf095ed9`。

该持久数据库现在只有这一条 queue，已补齐首次 initial-create、唯一 initialization Run、六 Session、带截图 passed、进度活动、清理和归档事实。整体 live/release 仍为 blocked；后续必须继续使用同一数据目录，依次完成已有 `scenario-testing` 的普通 merge-source passed Run、双缺陷 failed Run并创建或关联两个 Issue、不推进的 blocked Run、三 Session 场景审核 PR、合并 PR、`manual-current-head` passed 重测，最后执行正式 live/release 检查。普通 passed Run 会成为数据库中更晚的 passed 记录，必须实际确认 Closure 7 的筛选仍能选中所需事实，不能提前把 initialization 结果当作最终门禁通过。
