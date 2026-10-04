# 模型设置交互收尾 Spec

- 日期：2026-10-04
- 状态：已确认
- [Intent](intent.md) · [Plan](plan.md)

本 Spec 覆盖 `luowang-adaptive-thinking-oss-settings/spec.md` 中“Final Main 使用最低档”和“持久化 Thinking 偏好不参与运行”的旧规则。

## 1 Thinking 配置

- Main、Runner、Reviewer 各显示一个 Thinking 下拉，只列当前目录模型实际支持的档位。
- 首次选择或切换模型时，Main 与 Reviewer 默认选择第二低档，Runner 默认选择最低档；只有一个档位时均选择该档。
- 已保存且仍受当前模型支持的值保持不变。旧值不受支持时，页面展示并在下次保存时持久化角色默认值。
- Main 与 Final Main 共用 `agents.main` 的模型及 Thinking，不提供独立配置。
- 连接检查和真实 Session 使用相同解析规则：有效的已保存值优先，否则按上述角色默认值回退。

## 2 Provider 与模型选择

- Provider 与角色模型使用同一套样式化组合框，支持输入过滤、鼠标选择、上下键、Enter 和 Escape。
- 组合框具备 combobox/listbox/option 语义，并保留手工输入未知值的能力。
- 成功载入模型目录不显示整行提示。加载和错误状态紧凑展示；错误仍可被辅助技术读取。
- 模型能力以带名称和悬浮说明的紧凑图标表示文本、视觉和推理能力，不重复占行显示模型名称。

## 3 标题、帮助和 Secret

- 三个角色标题统一为 Main、Runner、Reviewer。Reviewer 的视觉要求通过可聚焦问号帮助说明。
- Provider API Key、OSS Access Key ID 和 OSS Access Key Secret 在输入框内部表达是否已配置；状态不另占一行，清除操作与输入同行。
- 已配置 Secret 的占位提示为“已配置 · 输入新值可轮换”，未配置时为“输入凭据”。原值始终不回显。
- 管理员菜单入口使用圆形头像表达，保留账户设置和退出功能。

## 4 验收条件

- AC-MSP-01：三个角色的 Thinking 选项与当前模型支持档位一致，切换模型应用角色默认值，保存的有效选择用于连接检查与真实 Session。
- AC-MSP-02：Main 与 Final Main 使用同一模型和 Thinking；旧的无效档位自动回退且不阻塞。
- AC-MSP-03：Provider 和模型组合框支持键盘、鼠标、过滤和未知值输入，且无原生 datalist。
- AC-MSP-04：目录成功提示不占行；能力图标和 Reviewer 帮助可由鼠标及键盘理解。
- AC-MSP-05：三个部署级 Secret 的配置状态内联，原值不回显，保存、轮换、清除和锁定规则保持。
- AC-MSP-06：管理员入口呈头像样式；768、1024、1440 像素宽度无横向溢出或字段错位。
- AC-MSP-07：相关单元、UI workflow、完整质量门通过。

