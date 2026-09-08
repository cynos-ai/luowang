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
- 未执行真实模型或实际部署 MCP 联合复测、未发布；工程通过不代表整体模型质量通过。仅本地提交，不 push/merge/release。
