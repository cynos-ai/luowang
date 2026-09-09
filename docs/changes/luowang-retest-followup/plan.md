# 复测问题收敛 Plan

1. 改MCP依赖解析与启动，保留证据cwd和安全参数，增加对应回归。
2. 明确计划可重写、失败后纠错及Reviewer维护事实检查，强调原样引用地址。
3. 容器工程检查及一次断网真实MCP导航/截图验证，保留失败证据。
4. 在以上前提成立后再准备Qwen定向及浏览器业务联合复测；未执行项明确标注，不追分重跑。

当前：MCP直接使用已安装CLI、工件可重写/维护声明核对及链接原样复用指令已实现。容器194项测试、lint/typecheck/build通过；断网真实MCP已完成about:blank导航、snapshot和PNG截图，证据在`.cynos/acceptance/retest-followup/`。这只证明接入与浏览器启动，不是网站业务验收。

已检查证据owner：RunEvidenceStore保管实际上传引用，Runner上传后才取得稳定地址，最终报告解析不负责完整Markdown链接解析。当前先落实原样复用指令，不用不完整的Markdown正则仓促增加拒绝门禁。程序链接校验未新增。

## Qwen 单链路定向复测

冻结候选`75c0756`，复用此前同一网站固定缺陷target、请求与隔离/本地存储披露，仅跑一次候选API完整链路，不重跑基线或扩大矩阵。qwen3.7-plus、Thinking off，四个已释放Session/52请求，退出0、无模型请求错误。真实注销测试200≠401，删除测试通过，最终failed并保留Bug。

Main在同一Session实际写计划三次：先纠正三级清单标题，再纠正清单区域边界，最终正确说明无需维护场景，没有无效patch或错误拆分声明。本轮验证了可覆盖更新，但未重现此前的错误文件理解，不能据此保证所有语义纠错已解决。

Runner仍首次漏用测试过滤参数`-t`，一次“No test files found”后在同一Session纠正；Reviewer明确记录。三次原始证据读取逐字节相同且先于execution；九处Markdown证据链接均对应实际对象，没有损坏链接。195个冻结哈希一致，target工作树清洁、无Run容器残留。已阅读四工件及相关事件，独立人工评分仍not_run。

证据：`.cynos/acceptance/retest-followup/model/` 的manifest、live-output、artifacts.txt、audit.py、checks.json。MCP断网启动截图与Qwen API链路是分开验证；截至该轮，Qwen+MCP网站浏览器业务联合验收尚未执行，不能合并两者声称联合通过。正式部署未更改，整体质量/发布不作通过声明。

## Qwen＋真实MCP网站只读联合验收

冻结候选`7002f43`（运行代码仍为`75c0756`），固定网站衍生target `dce0db485d2f4c9abf887ba8c6a3598403312d09`，预置`AUTH-FORM-UI-001`，仅验证登录→注册→登录入口和字段，不输入凭据、不提交表单。一个完整链、四个独立且已释放Session、55次qwen3.7-plus请求，Thinking off，无模型请求/认证/配额/终止错误，不重跑追分。

Main两次写计划均自主声明`requiresBrowser=true`，选择正确且无维护patch。Runner经生产Pi和受控MCP扩展真实导航、完成两次有效切换、获取三份snapshot和两张PNG。原始快照依次为登录/注册/登录，实际指定操作符合预期。Reviewer在execution之前读取两张图片；原件、上传对象、工具返回及随后SDK模型上下文中的图像字节一致。八个Markdown证据链接有效，203个冻结哈希一致。

**联合验收仍未通过，最终Run为blocked。** Reviewer用`read_command_evidence`读取浏览器console/log和page/yml，被命令ID成员检查在实际读取前拒绝；本Run没有命令证据。这类工具路由错误却被统一记为证据读取失败，并产生两条永久阻塞。原件没有丢失，不能归因为存储或hash失败。

同时存在真实的审核通道缺口：Reviewer没有受控读取原始浏览器快照的工具，未核对实际返回登录快照，转而用初始截图和Runner文字推断反向切换成立。注册截图下沿的返回入口被裁切，Reviewer的可见性描述也偏满。因此不能仅清空阻塞就宣称通过，也不应以强制每步再截图代替解决原始证据可读性和判断问题。下一步应围绕既有证据owner区分类型/读错工具与真实读取或完整性失败，补齐必要的受控浏览器记录读取，保留权限与归属边界；本轮尚未修改相关生产代码。

模型运行前零请求预检曾因只读浏览器容器默认HOME条件下的crashpad错误失败；仅将HOME置于已配置的/tmp tmpfs后预检成功，失败记录保留。模型启动前还纠正了新fixture PROJECT继承的旧API请求范围，重新固定target，应用代码未变。浏览器和网站均在独立internal网络，无宿主端口；网站日志只有七次GET，无填表/提交/账号写请求。最终Main后Harness销毁预登记基础设施命名空间，工作树清洁、无Run容器或网络残留。

证据：`.cynos/acceptance/browser-joint/`的manifest、evaluation-plan、两次preflight、live-output、mcp-trace、artifacts、findings、audit.py和checks.json。已由助手阅读四工件、截图与相关原始事件，独立人工评分仍not_run。本轮未改生产代码、未重新跑194项工程测试或41项完整验收；现有部署、认证提交及全站验收均未覆盖，整体质量与发布仍不作通过声明。

## 浏览器证据通道修复

已实现：沿用RunEvidenceStore上传引用，对真正获准安装受控MCP扩展的Run开放固定CLI自动命名快照/日志读取；不另建正文提交或注册事实源。列表增加kind/readTool，错误ID和读错工具不读取正文、不计入证据失败，也不满足图片读取顺序；已知记录丢失、篡改或格式失败仍阻塞。图像能力检查在合法图片ID检查之后、图像读取之前执行。

文本在Runner结束后统一脱敏上传，上传使用固定字节而不重新打开可能变化的生产者文件；读取校验已上传hash、UTF-8与大小，再次脱敏并明示截断。Reviewer指令明确按读取工具取证、不能用初始状态截图替代反向操作事实，不把视口裁切误称为完整可见或遮挡，也不要求每步截图。

工程验证：205项测试/29文件、lint、应用typecheck、相关测试严格编译、build通过，记录在`.cynos/acceptance/browser-evidence-fix/verified.log`和`verified.exit`。新增11项测试覆盖正常读取、脱敏/固定上传字节、类型与ID拒绝、真缺失/篡改、阅读顺序、图像能力边界、未授权Run、截断/二进制/大小/路径与symlink。未重新运行41项聚合验收，真实Qwen复测须另列。

保留中间验证记录：最初1项旧列表断言失败；之后高负载下并行测试超时及连带清理错误，改为单worker而非延长超时；一次整目录lint扫描到被忽略的`.cynos`评估驱动，随后在容器内用tmpfs遮蔽该非产品目录；测试严格编译的details类型/私有路径访问已修正。没有隐藏失败或修改历史模型评估。

## 修复后的Qwen单链复验

候选`432a3aa`，复用上一轮同一固定target、请求、只读场景、容器及本地证据披露，只跑一次候选链。四个独立已释放Session/60请求（13/30/13/4），qwen3.7-plus、Thinking off，无模型请求/认证/配额/终止错误。最终completed/passed、阻塞列表为空；旧blocked记录保持不变。

Reviewer实际用新工具读取三份页面快照和一个控制台记录，包括真正的返回登录快照；未调用命令证据工具。四文本与保存字节一致，三张原始PNG及SDK模型上下文图像字节一致，七项原始读取均早于execution，最终Main只读plan/review。203个冻结哈希一致，六个Markdown证据链接有效；七次网站请求全为GET，无输入/提交/账号创建，工作树及Run容器/网络清理核验通过。

本轮Runner自主多拍一张返回登录截图，非新增程序门禁；反向操作判断同时获得新通道的快照和额外截图支持，不将全部改善单归因于一个改动。本轮没有错走命令工具，错误路由恢复与真损坏仍阻塞由工程回归证明，不冒称现场已复现恢复过程。

仍保留质量缺口：注册图下沿的返回入口被裁切，Reviewer仍写成“均清晰可见”；console没有API记录不能证明网络没有调用，实际有GET /api/auth/status。历史Issue空列表属于离线驱动替代，不证明真实GitHub无历史问题。Runner修正了场景路径及MCP ref/target参数错误，原始事件保留。只读业务Run passed及原始记录通道打通成立，不代表视觉审核措辞或整体模型质量已完全收敛。

证据在`.cynos/acceptance/browser-evidence-fix/model/`的manifest、live-output、mcp-trace、artifacts、findings、audit.py和checks.json。四工件、三图及原始事件已由助手审阅，独立人工评分仍not_run；不扩展为认证提交、全站或正式部署验收，不push或发布。

## 固定图片的Reviewer视觉诊断

未改生产代码或角色指令，复用同一注册PNG与对应snapshot，执行一次零网络SDK工具消息序列化回放和两次独立Qwen请求：仅图 / 图加snapshot。qwen3.7-plus、Thinking off、输出1024、超时90秒、重试0；两次HTTP200/stop，共3,137 tokens，不额外采样或切换模型。

真实HTTP body仅相差snapshot文本块，两份发送图片均为原始1280×720、71,587字节且sha256一致；离线回放的三张历史工具图片也无客户端改动。历史HTTP body未保存，回放未重建全部工具schema/SDK元信息，不能作为历史wire包原封重放；服务端内部缩放、视觉编码和路由仍不可观测。

**两组均错误地把下沿被裁切的返回登录入口判成“完整可见”，并称依据来自截图。** 误判在不提供snapshot时同样出现，不能仅归因为文字证据干扰。当前样本显示局部可见程度判断不可靠，不等于模型完全不能看图；单图各一次亦不能推出总体准确率或确定服务端/模型内部机制。

九个冻结哈希、发送body及图像字节、两组唯一输入差异均校验通过。材料及输出由助手核对，独立人工评分仍not_run。证据在`.cynos/acceptance/reviewer-vision-diagnostic/`的plan、manifest、output、audit、checks和findings。下一步建议小范围核验视觉Reviewer候选能力，而非继续修改传输或追加提示词；模型更换须另行授权。未重跑工程全套、操作网站/账号/现有服务、发布或改写历史结果。

## 已授权多模型及思考模式对照

用户随后授权glm-5.3-flash、deepseek-v4-flash-vision-exp及从Pi临时取用相关凭据。GLM off首先被本地参数保护拦住，实际外部请求为零；SDK包装的Connection error不是服务端连接或认证错误。零网络回放与官方文档确认：该模型不支持关闭思考，Pi将off转为low。保留此设置失败，再单列执行原先已授权的DeepSeek off两组：两次HTTP200/stop，共1,794 tokens，均正确识别返回入口下沿裁切；带snapshot组明确区分DOM存在与截图不完整。

用户进一步明确允许开启思考且不限最低档，包括Qwen。按运行前固定计划新增四次请求：GLM high两组、Qwen开启思考两组，输出上限4096、90秒、重试0，不改图或问题。四次均HTTP200/stop、无截断，共8,453 tokens。实际body分别包含GLM thinking.enabled/high和Qwen enable_thinking=true/high；四次均返回非零思考用量。Qwen接口内部high档位语义未独立校准，结论仅称开启思考。

| 固定原图的返回入口判断 | 仅图片 | 图片＋snapshot |
| --- | --- | --- |
| Qwen off / 1024（既存） | 误判完整可见 | 误判完整可见 |
| DeepSeek vision off / 1024 | 正确识别裁切 | 正确识别裁切 |
| GLM high / 4096 | 正确识别裁切 | 正确识别裁切 |
| Qwen开启思考 / 4096 | 仍误判完整可见 | 仍误判完整可见 |

新增六次实际请求的图片均与原件逐字节一致，messages与对应Qwen off请求一致；每模型两组仅snapshot差异。前批十三个、思考批七个冻结哈希及body/图像核对通过；初次思考批后验审计误假定统一max_tokens，修正对Qwen实际max_completion_tokens的读取后通过，原失败保留且未补调用。凭据原文扫描通过，思考正文未记录或展示。

证据在`.cynos/acceptance/reviewer-vision-model-comparison/`与`.cynos/acceptance/reviewer-vision-thinking/`。单图每条件一次、不相同的思考/预算和默认采样不能形成总体排名或严格因果结论；当前Qwen接入的误判也不能单归因于基础模型内部某个模块。建议优先验证DeepSeek的完整Reviewer审核质量，GLM备选，不继续仅为本图调提示词或追分。独立人工评分仍not_run；未换正式配置、改生产代码/角色指令、重跑工程全套或完整四Session联合Run、操作网站/账号/现有服务、发布或回写历史结果。

## Coding Plan Kimi固定图补充

按用户要求调用Coding Plan中的kimi-k2.5，不走Moonshot原生或其它计费通道。原图/图加snapshot各一次，4096输出上限、90秒、重试0；两次HTTP200/stop、无截断，共5,128 tokens。实际请求携带reasoning_effort=high，沿用已有Pi元数据，未额外注入思考开关；两次均有思考块及非零reasoning用量，但不宣称已校准通道内部high语义。

两组均误判返回入口“完整可见”。七个冻结哈希、两份body和原图字节、跨模型messages一致性及两组唯一snapshot差异均校验通过；凭据原文扫描通过，不保存思考正文。证据在`.cynos/acceptance/reviewer-vision-kimi/`。

当前单图中Coding Plan的Qwen/Kimi均误判，原生DeepSeek/GLM识别裁切；因未做同模型跨通道的交叉对照，不能单归于基础模型或断言Coding Plan服务端处理有故障。仍优先验证DeepSeek完整Reviewer、GLM备选，不扩为总体排名。独立人工评分not_run；未改正式配置/生产代码，未重跑工程全套或真实联合Run、操作网站/账号/现有服务、发布或回写旧结果。

## DeepSeek报告可信度收尾

前置联合Run `01M22MQF5ZN46Y1P270BYFDX06` 使用Flash规划low、Runner off、Flash Vision审核low、最终Flash off（仅驱动覆盖）。四Session/40请求，真实入口双向切换成立，Run completed/passed，原始证据与清理核验通过；报告仍有截图覆盖偏满、模型冒称人工、非空清单套用零场景说明。原始材料保留在`.cynos/acceptance/deepseek-joint/`，不回写结果，不宣称完整质量或部署验收通过。

本次范围：
1. 在既有tool描述/输出契约中将零执行场景规则限定为空清单；角色指令明确真实审阅主体、只输出适用结论和实际画面覆盖。保留格式/证据安全规则，不增加语义拒绝门禁。
2. 运行角色装载、orchestrator、语义边界和证据相关工程回归，检查实际组装输入，而不是只验证资源文件文字。
3. 冻结本次候选与上一轮plan/execution/八份原始证据，沿用原生DeepSeek Vision low→Flash off，仅一次Reviewer→最终Main重放。保留错误与旧结果，不操作浏览器或账号、不重新执行场景、不发布、不改变正式模型/思考配置。
4. 审阅新工件、实际模型参数、证据字节和读序，区分工程通过、报告改善及未解决问题；独立人工评分not_run。

已完成本轮实现与一次定向复验，材料在`.cynos/acceptance/report-truthfulness/`。候选为冻结的本地工作树及差异，不是未修改的316c36c。

有效工程检查在quality容器的临时工作副本、断网条件下完成：lint/typecheck、205测试/29文件、build、受影响测试严格编译通过；归档源码逐文件匹配冻结候选，关键文件hash与工作目录在日志中核验。前三次包装尝试不计为候选通过：一次只读根目录造成Vite临时文件EROFS；两次/work权限失败且漏fail-fast，误跑镜像旧137项测试，其中一次外层exit仍为0、另一次管道141。随后改为/tmp目录、set -eu及源hash检查，`engineering-4.exit=0`才是有效验证。候选工程验证实际完成晚于模型启动，不把旧镜像测试冒称先行通过。

零模型工具/格式重放通过；真实复验仅两个独立已释放Session、9请求（Reviewer 6 / 最终Main 3），原生DeepSeek Vision low→Flash off，HTTP200，无模型或工具错误，不重跑。Reviewer读4文本/3原PNG后再读execution，最终Main只读plan/新review；原件、工具返回、SDK及HTTP图像字节一致，255个冻结/来源hash通过，旧Run未修改，未操作网站/账号或追加清理成功印章。

本样本三项目标改善：不再为非空清单写零场景通过说明，不再冒称人工，明确指出注册图返回入口下沿裁切且最终Main保留限制；功能判断仍passed，不把截图局限当产品缺陷。仍有来源归因和措辞问题：Reviewer把自身卡片高度观察写成Runner报告已有说明，将内容相同快照称为重复上传，“无需处理清理”未充分限定主体。未修改模型输出或追分补跑；单样本改善不代表总体质量/发布通过，独立人工评分not_run。下一步建议冻结候选，复用正常/已知缺陷样本验证正负判断，而非持续围绕本图微调；扩大执行范围另行授权。
