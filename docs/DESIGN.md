---
colors:
  paper: '#fffdf4'
  ink: '#070707'
  muted: '#62615b'
  accent: '#e51c23'
  success: '#286956'
  warning: '#9a5b0b'
typography:
  display: "'Arial Narrow', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"
  body: "Inter, 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"
  mono: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace"
rounded: 0
spacing:
  page: 'clamp(20px, 3vw, 44px)'
  panel: 'clamp(18px, 2vw, 28px)'
  gap: 'clamp(14px, 1.5vw, 22px)'
components: 'src/web/components/ui.ts'
---

# Overview

延续现有罗网纸白、黑框、红色主操作的工具界面，不更换品牌。项目测试准备面向能判断业务、无需理解容器配置的操作者。此次为 Redesign · Preserve：保留路由、Secret Store、运行模式、人工保存及原执行链；调整信息层级和准备流程。

Design Read：桌面配置工作台；视觉变化 2/10、动效 1/10、信息密度 5/10、素材依赖 1/10、品牌保真 10/10。第一屏承担当前状态与下一步，普通电脑观看距离，克制明确；技术详情折叠，窄屏单列。

# Colors

使用 `src/web/tokens.css` 的现有变量。纸面正文必须使用 ink，次要说明使用 muted；不得继承深色界面的浅色事实值。红色只强调主操作，绿/琥珀表达真实状态。

# Typography

保持现有字体。业务方案使用正文；命令、SHA 和路径只在依据/技术详情使用等宽字体。标题、状态、行动形成阅读顺序。

# Layout

沿用页面间距和共享设置分组。先状态与行动，再待办、业务方案、真实验证，最后技术详情。不增加一套独立配置事实源。

# Elevation & Depth

沿用共享 Button 的错位阴影和现有 Dialog 层级，不为业务页面另加阴影。

# Shapes

方形边框、分隔线；不引入圆角卡片风格。

# Components

复用 Button、Field、StatusLabel、Message、Dialog、SelectBox 和 AppLink。原生 details 用于技术展开。每个任务显示原因和可执行入口，禁用动作附原因。

长时间分析和环境验证使用共享 BusyOverlay：复用现有 dialog 的纸白、黑框、错位阴影及 backdrop，三枚红色方块表达不定进度；保留明确的停止操作和真实进展，不显示虚构百分比。模态期间背景不可操作；Escape 不隐去仍在运行的任务，减少动态效果设置下不播放跳动动画。

# Do's and Don'ts

- 方案是未来动作；保存、执行、验证分别表达。
- 不把 HTTP 健康检查当作账号登录或业务通过。
- 不让用户通过普通文本框提供密码。
- 保留高级手动定义、原始 JSON 和旧链接。
- 不为展示填入未经验证的服务、角色或通过状态。
