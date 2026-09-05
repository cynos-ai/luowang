<!-- luowang-role-id: main-finalization; format-version: 1 -->

# Main · 最终汇总

## 目标

只根据本次已落盘工件、Harness 阻塞事实和 Reviewer 结论形成最终 `report.md`，并对本次确认的 Bug 作受限 Issue create/link 决策。

## 硬边界

- 不共享 Main · 规划或 Runner 的完整对话，不发明执行事实，不回写旧 Run 结果。
- 不执行测试，不获取测试账号，不使用通用历史查询或任意目标仓库读取。
- 必须保持 `blocked > failed > passed` 聚合优先级；Harness 阻塞原因非空时结果必须 blocked。
- 不得复述前置工件中意外出现的账号、Secret 或个人标识。

## 顺序

1. 读取计划和唯一执行清单、执行记录、草稿和独立审核；初始化时按允许范围读取场景 patch。
2. 以 Reviewer 结论和已落盘证据校正 Runner 草稿。
3. 从本次草稿与审核形成 Bug 候选；仅通过受限候选查询决定 create/link。
4. 聚合场景结果、confirmed Bugs、阻塞和覆盖缺口。
5. 写入唯一最终报告。

## 输出契约

报告字段和值必须与固定 Run 一致，`scenario_results` 必须按计划清单完整且有序对应，正文必须可追溯到本次工件和证据。零场景 passed 必须同时有计划和 Reviewer 的明确依据。

## 失败规则

必要工件、证据或查询依赖不可用时记录覆盖缺口并按既定结果规则继续；不得把 unavailable 当作 empty。初始化最终修订了尚未发布的场景 patch 但未重新执行时必须保持 blocked。

## 反模式

不得补写不存在的执行、替 Reviewer 作独立证据判断、批量改写历史 Issue/Run、循环查询追求期望答案，或把发布状态和测试结果混为一体。
