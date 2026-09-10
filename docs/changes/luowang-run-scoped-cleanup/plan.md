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

## 后续授权的独立实例与原生 Run

两端PR经CI通过后合入develop：罗网PR #60为 `fb1ee6dcea14824af16905dd715bd72c5029a906`，官网PR #9为 `5ae2f2dee59a32ff16d67c2b1c4849470ce5bf8f`。官网在专用 `chore/run-cleanup-validation` 分支整合原scenario-testing历史及账号删除功能，固定执行提交为 `cfe23fd3e59256e7188b22027d030389542aed31`；未改默认测试分支。整合后官网7测试、typecheck/build通过，两个真实runtime镜像在独立数据卷和回环端口启动。真实设置UI保存与清空秘密草稿通过。首次构建中断、internal网络未发布端口及客户端无正文DELETE错误声明JSON的启动失败均保留；最终使用允许外联的独立桥接网络，不宣称断网隔离。

按用户授权从受控env解析引用并配置加密Secret Store，未照搬旧服务地址、分支或较旧的Runner思考级别。GitHub读取、专用OSS子前缀临时对象读写删除、测试环境和MCP检查通过。随后只提交一次原生Run `01M24MC989M0EPP8N89AP71TC2`，真实应用入口、RunStore、浏览器、Reviewer、最终Main、HTTP清理及Archiver共同执行，结果为completed/passed。执行已批准的AUTH-REGISTRATION-001，保留场景内自助删除，另外登记一个不计为场景的收尾探针账户供Harness删除。

四阶段配置是Main Flash low、Runner Flash off、Reviewer Vision low、最终Main沿用正式Main low；没有Session factory或指令覆写。临时HTTP relay仅限制固定原生端点的预算：每system-prompt hash组最多64次、总计256次、max_tokens上限4096、单HTTP90秒及一小时接入窗口。实际69次均HTTP200，四组各有正常stop，合计API用量1,060,313 tokens；这些组不是声称已采集到的SDK Session ID，也不宣称关闭了产品SDK内置重试。没有整链重试或补写失败报告。结束后恢复原生直连地址并停用relay，自动触发仍关闭。

独立观察与验收：执行/审核期间Run范围有1个残留探针；最终模型流结束后，官网实际收到Harness的DELETE→GET→DELETE→GET，均200，两项登记均核验不存在。外部查询和只读SQLite检查确认Run账户/会话为0且无孤立会话，预置账号创建时间早于Run且仍能登录。16份真实OSS证据下载的长度/hash吻合；[正式报告](https://github.com/cynos-ai/cynos-website/blob/61f487bbd4956b908ed29764ecffcb23d3243ced/docs/scenario-testing/reports/01M24MC989M0EPP8N89AP71TC2/report.md)和review与本地原文逐字一致，归档commit `61f487bbd4956b908ed29764ecffcb23d3243ced` 仅新增当前Run的这两份文件。既有报告未改，未创建产品Bug Issue，未验证新的场景PR或Issue发布路径。当前清理Token、模型/Git/OSS凭据及测试密码扫描无命中。

限制必须保留：模型报告虽判passed，但DB密码存储形式和Cookie属性未验证；Runner将“不在响应中泄露密码”作为DB存储期望的可观察替代，不能当作数据库期望已成立。Reviewer/最终Main保留了该缺口，并指出部分HTTP状态码缺少其可回读原始捕获、三张截图底部裁切。后验服务器/数据库检查不补塞给模型，不追改已发布报告。本次只证明单场景及真实清理闭环，不是全站、安全完整性或总体模型准确率验收。原有共享实例未替换，向默认scenario-testing的官网PR #10仍保留Draft，推广前须协调目标部署与已有触发设置。

原始证据分别保存在 `.cynos/acceptance/cleanup-deployment/` 和 `.cynos/acceptance/cleanup-native-run/`，包含失败记录、镜像/源码、逐轮元数据、Run工件、独立查询、字节核验和凭据扫描；不存原生模型隐藏思考或明文凭据。

## 日常实例切换

后续经用户授权，罗网证明PR #61已合入develop；官网PR #10在完整检查后合入默认scenario-testing，提交 `3e67fc4bfb4acc4465ba75a937fe2808982aeab5`。切换检查发现Prettier拒绝31份历史/当次报告，故官网PR #11仅排除不可重排的reports目录，并为指向scenario-testing的PR启用现有CI；源码和场景格式检查不跳过，历史报告原文不变。修正后本地format/lint/typecheck、7测试及E2E、两个PR的GitHub Quality均通过。

官网按合入提交重建runtime镜像并验证revision，产品源码/测试/lockfile/Dockerfile与原生验收target cfe23fd一致。新实例复用原数据卷及Token，健康检查、预置账号登录、原Run残留为0、准确commit的索引同步及浏览器入口通过。官网项目日常入口为服务器本机罗网3778、官网3101，默认分支已切为scenario-testing，两个服务使用unless-stopped；测试自动触发和cron仍关闭，本次不新增模型Run、不改变旧Run target。

旧官网与两个官网Harness停止并关闭自动重启，保留容器/原卷及前一新版官网容器用于回退。旧两个Harness的只读临时快照各确认13条Run且ID集合一致；没有迁入新实例，新实例仍为1条Run。3777上的罗网属于另一项目，未改动。旧SQLite只读卷检查首次因WAL辅助文件失败，改复制DB/WAL/SHM到断网容器tmpfs后只读检查，不写旧卷；辅助脚本重名导致前态观察文件被覆盖的事故亦记录，未影响产品数据或回退清单。切换清单、失败与完成证明见 `.cynos/acceptance/cleanup-cutover/`。模型遗漏明确期望却仍判passed的问题保留为后续目标，不在切换中追改报告。
