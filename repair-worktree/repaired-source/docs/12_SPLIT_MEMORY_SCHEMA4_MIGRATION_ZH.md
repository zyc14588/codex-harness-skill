# Split-memory schema 5 热修迁移报告

## 为什么需要 schema 5

0.6.5-rc.1 的真实 Provider `INVALID_REQUEST` 被旧逻辑当成任务形状异常，污染了 schema 3 画像。协议错误并不能证明叶子过大；让它降低复杂度、规模或 Token 建议会把基础设施故障错误反馈给任务拆分器。

schema 4 建立了基础设施与 task-shape 的归因边界，但 DSH 在 managed minimal MCP 子进程启动失败时只输出通用 preset-mount 错误，旧分类器没有写入 `infrastructureFailureKind`。结果是零 Provider I/O、零 Token、空 diff 的启动失败仍可能被 schema 4 记成 task-shape anomaly。schema 5 隔离这批画像，并把通用 MCP 同步错误和 `no_effect` 明确归入不可学习的基础设施证据。

## 迁移规则

- schema 1、2、3、4 均视为 legacy，不参与 schema 5 advice。
- 读取 legacy 文件时只报告被忽略的 schema/sample 数，不信任旧建议。
- 同一 memory key 下次写入时，把旧文件归档到 `legacy/`，再创建 schema 5 画像。
- 不修改或删除历史 event 证据。
- 省略 Harness model 与显式 `deepseek-v4-flash` 规范化为同一 memory tier，防止默认别名分裂样本。

配置文件 schema 当前为 v7；这里的 schema 5 专指内部 split-memory 画像，两者不可混淆。

## 基础设施隔离

以下 failure kind 不增加 task-shape `sampleCount` 或 `anomalyCount`：

```text
tool_protocol
minimal_tool_plane
minimal_tool_plane_composition
minimal_tool_serialization_mismatch
thinking_policy_state
thinking_replay_state
provider_protocol
provider_transport
no_effect
```

它们可增加 `infrastructureFailureCount`，但不改变 leaf scale、complexity 或 Token 建议。特别地，只有基础设施事件且 `sampleCount=0` 的 schema 5 画像必须返回当前调用方的提议值；不得把失败任务自身的较小预算误当作学习结果。

## 稳定复现与结果

回归覆盖：

1. 带 8 个污染样本、scale 0.25 的 schema 4 文件被忽略；新 advice 为 sample 0、scale 1 和当前预算；下一写入归档旧文件。
2. thinking replay 缺失时 Provider 调用为 0、Token 为 0/0，sample/scale/complexity/Token 建议均不变。
3. 一个基础设施失败用 `10000/2000` 执行，而下一候选提议 `20000/4000`；advice 必须仍为 `20000/4000`。
4. 默认 Flash 与显式 Flash 的 memory key 完全相同。

当前 hotfix R2 的 split-memory 窄测试、87 项全量回归、direct acceptance、动态 Harness、失败注入与真实 Provider 已独立通过；release bindings、确定性双构建与最终解压归档也已完成。此前 stable 的结果只保留为历史证据。
