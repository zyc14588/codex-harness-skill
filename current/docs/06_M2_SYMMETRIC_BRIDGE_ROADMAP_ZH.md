# M2 对称任务总线路线

R6 仍采用 Codex stdio MCP + 独立 Harness headless worker。M2 可在不改变 R6 安全合同的前提下增加本地 Streamable HTTP 任务总线，让 Harness 主动上报结构化进度、blocker 和工具申请。

预定约束：

- 至少一次传输 + 幂等 command ID；
- revision compare-and-swap；
- 单一权威状态机；
- 租约、Token gate 和 split-memory 更新必须由 Controller 事务提交；
- 不宣称网络 exactly-once；
- 不允许 Harness自行修改拆分记忆；
- 进度信号只作建议，Codex仍负责审查和验收。

R6 的 split memory 可作为 M2 调度器输入，但不得演化为自动接收代码或取消审查门禁的机制。
