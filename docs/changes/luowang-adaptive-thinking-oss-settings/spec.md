# 自适应 Thinking 与 OSS 配置体验 Spec

- 日期：2026-10-04
- 状态：已确认
- [Intent](intent.md) · [Plan](plan.md)

## 1 自适应 Thinking

每个阶段保留两种相对强度意图：Runner 和 Final Main 使用最低档；规划 Main 和 Reviewer 使用第二低档。运行前读取所选模型的受支持 Thinking 档位，按全局稳定顺序 `off → minimal → low → medium → high → xhigh → max` 过滤后选择：

- 最低档取支持列表第一项。
- 第二低档取第二项；模型只有一个档位时回退到第一项。
- 运行时创建 Session 与连通性检查必须使用同一个选择函数。
- 不再因为模型缺少字面 `off` 或 `low` 而失败；模型不存在、Reviewer 不支持图像等既有客观检查保持。

持久化的三个角色 Thinking 偏好不在本需求中迁移；阶段运行策略仍由产品控制，页面继续展示模型自身支持的档位。

## 2 OSS 信息层级

对象存储页面按以下顺序展示：

1. 必填连接信息：Endpoint、Bucket、Region、访问模式。
2. 必填访问凭据：Access Key ID、Access Key Secret。
3. 选填高级项：Public URL、Object prefix。

必填和选填使用明确标题及简短说明。Endpoint、Region、Bucket、访问模式、Public URL 和 Object prefix 提供键盘可聚焦的问号帮助，悬浮或聚焦可看到用途和示例。

## 3 输入行为

- Endpoint 和非空 Public URL 在离开输入框及提交时补齐缺失的 `https://`。
- 后端 OSS 适配器同时接受历史上未带协议的 Endpoint，并按 HTTPS 解析，使已有配置无需重新保存即可检查。
- 已配置 Secret 的输入框使用“输入新值以轮换”占位符；未配置时使用“输入凭据”占位符。输入框保留可访问名称，但不显示“新值（不会回显）”标签。
- 页面继续展示配置状态和掩码，Secret 原值不回显。

## 4 验收条件

- AC-ATO-01：只支持 `low/high/max` 的模型可按最低档和第二低档分别使用 `low`、`high`，Provider 检查不再报缺少 `off`。
- AC-ATO-02：非推理模型或只有一个 Thinking 档位的模型对两种阶段意图均使用唯一可用档位。
- AC-ATO-03：连通性检查与真实 Session 使用相同的自适应档位。
- AC-ATO-04：OSS 必填项、凭据、选填项顺序明确，帮助示例可由鼠标和键盘访问。
- AC-ATO-05：缺少协议的 Endpoint 自动按 HTTPS 处理；保存后页面显示完整 URL。
- AC-ATO-06：凭据输入无重复解释标签，设置、轮换、清除、脱敏和运行锁规则保持。
- AC-ATO-07：相关单元测试、UI workflow、响应式检查和完整质量门通过。

