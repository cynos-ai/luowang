# 自适应 Thinking 与 OSS 配置体验 Plan

- 日期：2026-10-04
- 状态：已完成
- [Intent](intent.md) · [Spec](spec.md)

## 1 实施阶段

1. 抽出按模型支持列表选择阶段 Thinking 的单一函数，接入 Provider 检查和生产 Session。
2. 为无 `off`、单档位及常规多档位模型增加定向测试。
3. 重排对象存储设置，增加 URL 规范化、必填/选填层级和可访问帮助。
4. 更新 UI workflow，覆盖自动补齐、字段顺序、帮助提示和无重复 Secret 标签。
5. 运行质量容器，重建当前预览实例并执行真实 Provider/OSS 检查。

## 2 风险与控制

- 检查与执行选择不一致：两条路径调用同一导出函数。
- 模型元数据顺序不稳定：按产品固定的 Thinking 顺序过滤，不依赖 Provider 返回顺序。
- URL 自动补齐误改自定义 HTTP：只补齐没有协议的输入，显式 `http://` 保持。
- 高级项被误认为无效：保留在同页并说明何时需要，不折叠到不可发现的位置。
- Secret 说明减少后误解轮换：通过占位符和按钮文案表达设置/轮换，配置状态继续可见。

## 3 完成证明

- 35 项定向测试覆盖 Thinking 相对档位映射、无协议 Endpoint、访问模式与稳定地址；UI workflow 覆盖自动档位展示、URL 补齐、信息顺序、帮助示例和 Secret 标签精简。
- quality 容器内 518 项测试通过，2 项既有外部 Docker 条件测试跳过；完整 E2E、format、lint 和 typecheck 通过。
- 当前数据卷上的预览实例已重建且健康；真实 `zai-coding-cn` Provider 检查通过，京东云 OSS 测试对象上传、读取和删除均通过。
