# 语义判断归属 Plan

依据同目录 intent/spec，延续当前未发布反馈分支，本地提交、不 push/merge/release。

1. 为 Main 的 write_plan 加显式浏览器需求，删除两处计划语义正则；追踪初始化重写、Runner MCP 注入及 Reviewer 图像能力边界。
2. 零场景只校验空清单附有理由；删除跨三工件关键词证明，更新既有角色方法和输出契约。
3. Provider 消息猜测改为明确错误类型/码，未知保持未知；不动安全正则和候选检索。
4. 更新真实 Pi/脚本 fixture 协议，覆盖显式声明与实际能力不一致、无视觉模型、原误判文本、空清单与错误分类。Docker quality 跑匹配风险的测试与完整验收，记录失败和未运行项。

## 风险

不能简单删除所有浏览器保护，也不能通过模型声明绕过 MCP 配置或证据审核。新声明必须随成功的 plan 写入更新，写入失败不能改状态；初始化不能残留上一阶段的语义结论。旧评估输入保持冻结，不能为新协议回写历史记录。

## 进度

- 已完成：Main/初始化候选 Main 的 write_plan 必填 requiresBrowser，成功写入后更新既有 RunContext，Runner/Reviewer 收到同一声明供核对；两处浏览器/视觉语义正则及跨工件零场景关键词证明已删除，无兼容分支。
- MCP/URL 的客观检查、Runner 扩展权限、图片原始读取顺序和完整性保持；图像读取工具交付前检查 Reviewer 的实际 Provider 模型元数据，能力不可用不交付图片并记录阻塞。不因为声明就认定有能力或执行成功。
- 空清单须有非空理由；固定标题、ID、去重、approved 与结果完整顺序保留。理由不靠语言匹配判断，否定句/矛盾理由由 Reviewer 审核，不把解析成功冒充理由成立。
- Provider 不再按自由文本猜认证、thinking 或超时。明确认证状态/码、model_not_found、TimeoutError/ETIMEDOUT 正确分类；普通404、AbortError、unsupported response_format、null/字符串等未知异常保持通用失败，不回显原始异常。
- 验证：Docker quality 完整本地验收通过，28个测试文件/194项测试，format/lint/typecheck/build/headless E2E/Phase 9、生产 Pi 四/六/三 Session 专项均通过；受影响测试另经严格 TypeScript 编译通过。
- 新增回归覆盖：显式 true/false 不受中文否定、其他语言、代码块或缺少传统浏览器关键词影响；声明缺失/类型错误拒绝；无关键词但显式需要浏览器仍检查 MCP；声明不需要时含“无浏览器服务/不执行UI/不做截图对比”不被阻塞；无视觉能力不交付图片；自然语言理由、空理由、固定ID边界；12项 Provider 明确/未知异常案例。
- 失败记录保留：首轮2项旧 fixture 未显式声明正确范围/提供真实模型能力，已更新；补充测试时两轮独立严格编译暴露 unknown 类型断言缺失，已修正；中间 engineering-final 在文件补充及格式化期间捕获 phase4-orchestrator 的 format 失败，不作为完成证明。停止源代码修改后重新运行的 verified 全部通过。
- 最终证据：`.cynos/acceptance/semantic-decisions/verified/report.json`，exit=0，local=passed、live/release=blocked；严格编译 `test-typecheck-verified.log` 通过。旧误判复测数据和历史模型评分未改写。
- 工程完成时未执行真实模型或实际部署 MCP 联合复测；后续授权复测见下节。仅本地提交，不 push/merge/release。

## Qwen 有界复测

- 冻结 `a0b39af → 078eb99`，正常/真实注销缺陷/执行服务不可用各一轮每版本，共六链路、24个唯一且已释放的生产Pi Session、268请求；全部 qwen3.7-plus、Thinking off，无请求/auth/quota/终端失败。仅API源码测试，存储与Git为明确披露的本地替代，不访问共享服务或账号，不发布。
- 正常：基线 blocked → 候选 passed（42/40请求）；缺陷：基线 blocked → 候选 failed（48/54）；不可用：两者 blocked（41/43），没有实际运行测试。正常与缺陷基线均被UI关键词额外阻塞；缺陷确认Bug始终保留。
- 候选三次规划由模型显式声明 requiresBrowser=false。候选缺陷的原计划仍会被旧检测器判断为需要浏览器，新实现则按声明保持真实 failed，证明不是只靠规避词语。正常候选计划本身不触发旧函数，不能把全部配对差异归因于删除正则。
- 九次真实命令中两次错误过滤器在同一Runner内纠正，七次实际测试执行；不可用条件三次服务拒绝。Reviewer十二次原始读取逐字节一致，六链路均先原始证据后execution；350个冻结哈希一致，固定target工作树清洁、无Run容器残留。已阅读全部24个Markdown及相关输入/事件，独立人工评分仍not_run。
- 未通过整体质量：候选缺陷规划误解两个独立场景文件，提交无效patch被安全拒绝；随后识别误解却误以为plan只能写一次，未改正落盘计划。工具原始输入正确，生产writer可重写，无实际场景改动。Reviewer未指出该交接矛盾。Runner另有一个损坏证据链接（此前工具已给出正确地址），Reviewer/最终report链接正确；不能据此认为链接问题已普遍解决。
- 独立零模型调用MCP实探：新断网quality容器中的生产启动定义在工具发现前超时，无浏览器截图。镜像确有安装0.0.79，但从证据目录启动npx时离线诊断返回ENOTCACHED，未利用/app已有依赖。没有改启动方式/开放外网重跑取绿，没有改产品代码。现有部署未检查，不能据此判断其MCP不可用；localhost3100未触碰。
- 证据：`.cynos/acceptance/semantic-model/` 的冻结manifest、live-output、review/findings.md、checks.json、browser-attribution.json、semantic-checks.json及MCP失败/解析诊断记录。manifest中继承的baselineOriginal是未使用的陈旧字段，实际执行版本由baselineApplication、checkout与哈希确认；冻结记录不回写。
- 结论：本轮API误阻塞修复有效；零场景、初始化重定、真实UI需要与Qwen图像审核未在本次模型复测覆盖，Phase 5整体质量及真实联合/发布验收仍未通过。不修改产品、不进行追分重跑，不push/merge/release。
