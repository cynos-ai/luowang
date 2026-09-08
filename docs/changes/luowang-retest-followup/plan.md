# 复测问题收敛 Plan

1. 改MCP依赖解析与启动，保留证据cwd和安全参数，增加对应回归。
2. 明确计划可重写、失败后纠错及Reviewer维护事实检查，强调原样引用地址。
3. 容器工程检查及一次断网真实MCP导航/截图验证，保留失败证据。
4. 在以上前提成立后再准备Qwen定向及浏览器业务联合复测；未执行项明确标注，不追分重跑。

当前：MCP直接使用已安装CLI、工件可重写/维护声明核对及链接原样复用指令已实现。容器194项测试、lint/typecheck/build通过；断网真实MCP已完成about:blank导航、snapshot和PNG截图，证据在`.cynos/acceptance/retest-followup/`。这只证明接入与浏览器启动，不是网站业务验收。

已检查证据owner：RunEvidenceStore保管实际上传引用，Runner上传后才取得稳定地址，最终报告解析不负责完整Markdown链接解析。当前先落实原样复用指令，不用不完整的Markdown正则仓促增加拒绝门禁。程序链接校验未新增，Qwen定向与网站联合复测仍待执行。
