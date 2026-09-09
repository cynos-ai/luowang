# 实施与证明

1. 官网从develop创建 feat/run-scoped-test-cleanup，新增默认关闭的受控按Run查删路由与范围/鉴权/级联测试。
2. 罗网延续 fix/cleanup-capability-disclosure，新增HTTP adapter、部署URL配置、专用Secret键及设置字段，默认App入口注入；补全脱敏和回归。
3. 两仓库分别在匹配lockfile的隔离quality环境运行测试、lint/typecheck/build，保留失败。
4. 固定源文件hash，以新建非生产服务/合成数据验证真实HTTP删除与独立查询、其他Run不受影响及收尾接入；随后记录完整Run事实。不得把尚未运行的检查标为通过。
5. 分别提交目标仓库与罗网的PR；不直接写长期分支，不自动部署发布或改写历史报告。

实现及工程联通完成：罗网220测试/31文件、format/lint/typecheck/build、相关测试严格编译及headless E2E通过；官网6测试/2文件、lint/typecheck/build、严格测试编译及E2E通过。默认应用是否注入adapter有两项回归，不只是手工组装测试manager。

真实HTTP联通使用两套匹配lockfile的quality镜像、独立internal网络及tmpfs数据。生产orchestrator、加密Secret Store、RunStore、HTTP adapter和真实官网接口配合脚本化四阶段，零模型请求：正确Token的Run 01M23B39462MPZFA1T2NSJT6N4为completed/passed，四阶段dispose后DELETE200再GET200，remaining=0；错误Token的Run 01M23B39AX2KD2NH8C7DMX5YD6仍completed/passed（注册功能成立），清理401、remaining=1并追加真实未完成告警。后者在原报告保留告警后，单独用正确Token回收并GET确认为零；没有追改Run结果。未标记合成账号全程可访问，所有临时容器和网络已删除。

失败保留：官网首次Fastify logger泛型编译不匹配，修复后通过；前两次联通在禁用CHOWN能力的容器内tar恢复属主失败，服务未就绪，改用--no-same-owner后通过。未降低容器权限隔离或扩大删除范围。

上述是脚本化全链清理接线，不是新增原生模型或部署实例验收；既有共享服务和模型配置未改，未归档发布测试报告、创建产品Bug Issue或写入真实OSS。源码hash、工程日志、集成报告和清理记录保存在 `.cynos/acceptance/run-scoped-cleanup/`。主要剩余风险：未实际应用Run标记的数据不在范围、部署Token不一致及网络故障；按清理告警处理。
