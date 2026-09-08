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

证据：`.cynos/acceptance/retest-followup/model/` 的manifest、live-output、artifacts.txt、audit.py、checks.json。MCP断网启动截图与Qwen API链路是分开验证；Qwen+MCP网站浏览器业务联合验收尚未执行，不能合并两者声称联合通过。正式部署未更改，整体质量/发布不作通过声明。
