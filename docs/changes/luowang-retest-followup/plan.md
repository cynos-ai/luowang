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
