# Attempt 级 Thinking Policy 设计

## 目标

0.6.5 把 DeepSeek thinking 模式从“逐请求临时改写”提升为“执行 attempt 的不可变合同”。同一 attempt 中，模型、thinking 模式和 reasoning effort 均不得切换。任何不一致都必须在 Provider 请求、Token 计量和 split-memory 学习之前失败。

## 冻结策略

| 模型 | `thinking.type` | `reasoning_effort` | `tool_choice` |
|---|---|---|---|
| `deepseek-v4-flash` | 全 attempt `disabled` | Provider wire 必须省略 | 无 diff 的前两次核心 mutation 请求可为 `required`；出现 diff 后省略 |
| `deepseek-v4-pro` | 全 attempt `enabled` | 全请求固定 `high` | 全请求必须省略 |

worker 在启动 Harness 进程前创建 `ExecutionAttempt`，生成不可变 ID、ordinal、model 和 `attempt-thinking-policy-v1`。旧队列记录只允许在第一次 Provider 请求前进行一次兼容冻结；冻结后任何模型或模式变化均拒绝。

## Provider 前置门禁

Monitor 对最终 wire body 执行以下顺序：

1. 当前请求必须属于唯一活动的 Harness attempt；
2. 请求模型必须与 attempt 模型一致；
3. `thinking.type` 必须与冻结策略一致；
4. Flash 必须省略 `reasoning_effort`；
5. Pro 必须为 `reasoning_effort=high` 且不存在 `tool_choice`；
6. Pro 历史中每一条 reasoning replay requirement 都必须找到工具调用 ID 集合完全相同的 assistant 消息；
7. 该消息的 `reasoning_content` 必须非空，UTF-8 字节数和 SHA-256 必须与 Provider 原响应一致。

门禁通过后才追加脱敏请求证据、计入 request ordinal 并发起网络请求。门禁失败返回 `thinking_policy_state` 或 `thinking_replay_state`，Provider 调用和输入/输出 Token 均不增加。

## reasoning 捕获与回放

Bridge 不生成、补空、总结或修改 reasoning。对 Pro 的每个真实工具调用响应，Bridge 从已发送给 Harness 的 SSE/JSON 响应中提取：

```text
attemptId
responseRequestOrdinal
toolCallIds
reasoningUtf8Bytes
reasoningSha256
recordedAt
replayCount
```

任务证据只保存哈希和长度，不保存 reasoning 正文。正文由 Harness 对话历史原样持久化；下一请求必须完整带回对应 assistant tool-call message。每次成功回放记录 request ordinal，不允许删除工具消息、伪造 reasoning、发送空字符串或只回放最后一轮。

若 Provider 在 enabled-thinking 的工具响应中没有真实非空 reasoning，Bridge 报 `provider_protocol`。HTTP 协议拒绝同样归入 Provider/基础设施，而不是 `task_shape`。

`provider_protocol` 是 execution-attempt 级不可恢复状态，而不是允许同一对话继续的普通 HTTP 重试。Bridge 对首次违规响应完成一次真实 usage 记账后：

1. 向 Harness 返回非重试型 HTTP 422，不把违规 assistant 工具消息加入历史；
2. 同一 attempt 的后续代理请求在读取请求体、追加 usage 或发起 Provider I/O 前返回同一失败；
3. worker 观察到不可恢复的基础设施状态后终止 Harness 进程组，但继续执行终态 Git/scope、usage、attempt 与 split-memory 证据收集；
4. execution attempt 必须记录为 `failed`，即使 Harness 在熔断竞态中以退出码 0 结束。

该熔断同样适用于确定性的 tool/thinking/minimal-serialization 协议状态；瞬时 `provider_transport` 仍可按现有传输恢复路径重试。任何路径都不得生成、补空、总结或修改 `reasoning_content`。

## 可审计证据

`harness_status`、monitor snapshot 和最终 smoke 证据公开：

- attempt policy；
- 每轮 model/thinking/reasoning-effort/tool-choice 形状；
- replay requirement 数量和已回放 ordinals；
- reasoning SHA-256、UTF-8 长度、工具调用 ID 与回放次数；
- infrastructure failure kind；
- Provider request ordinal 与 Token totals。

稳定版真实 Pro smoke 在同一 attempt 完成 7 次 Provider 请求、6 次工具调用，并产生 6 条真实 reasoning requirement；它们的最终回放次数依次为 6、5、4、3、2、1。
