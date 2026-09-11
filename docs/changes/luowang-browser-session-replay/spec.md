# 受控 Cookie 会话重放能力 Spec

## 浏览器边界

- Playwright MCP 继续以 headless、isolated、`--snapshot-mode=full`、`--codegen=none` 启动，并新增 `--caps=storage` 以取得 Cookie 工具组。
- 只有三项 storage 工具对模型可见：`browser_cookie_list`、`browser_cookie_get`、`browser_cookie_set`；它们分别用于读取 Cookie 集合、读取单个 Cookie 值/属性、恢复已捕获的 Cookie 值。
- 其余 storage 工具必须通过接入层排除并保持不可见：`browser_cookie_delete`、`browser_cookie_clear`、`browser_storage_state`、`browser_set_storage_state` 及全部 `browser_localstorage_*`、`browser_sessionstorage_*`；原有的 `browser_evaluate`、`browser_run_code`、`browser_run_code_unsafe` 继续排除。
- 边界不新增容器能力、宿主挂载、网络出口或 Secret；Cookie 值只存在于当次隔离浏览器上下文与模型上下文中。

## 连接检查与预检

- `checkConnectivity` 要求基础工具（navigate、snapshot、screenshot）与三项 Cookie 会话重放工具全部被真实发现；任一缺失即返回 failed，并明确指出缺少会话重放能力。
- 接入层必须携带完整排除清单；缺失任一排除项即返回 failed。
- 零模型预检在真实适配器工具清单上再次校验：批准的三项 Cookie 工具存在，被排除的工具全部不可见。完成导航、snapshot、PNG 校验与释放后，再按目标页面就绪文本确认沙箱可用。
- 预检结果只决定是否放行业务 Run，不构成业务场景通过证据；任一检查失败继续保持业务 Run 不创建。

## 验收条件

- AC-CSR-01：MCP 启动参数包含 `--caps=storage`，且排除清单包含全部未获授权的 storage 工具。
- AC-CSR-02：工具探测缺少 Cookie 读取或恢复能力时，连接检查失败且原因可见。
- AC-CSR-03：零模型预检在两个非生产目标上通过，且适配器可见清单包含三项 Cookie 工具、不含任何被排除工具。
- AC-CSR-04：正常/缺陷各一次真实 Run 能在不改变既有期望、不放宽证据要求的前提下观察“退出后原 Cookie 被拒”和“删除账号后旧 Cookie/原凭据不可用”。
- AC-CSR-05：证据与报告不记录完整 Cookie 值，不把清理告警或连接检查当作业务通过。

## 边界与兼容

- 阶段 thinking（low/off/low/off）、三组 Agent 配置、清理资源域与告警语义保持不变。
- 历史 Run、首轮失败证据和已发布报告不改写；本能力只影响后续 Run。
- 模型与工具名称沿用既有前缀规则；Playwright MCP 版本继续锁定，避免能力漂移。
