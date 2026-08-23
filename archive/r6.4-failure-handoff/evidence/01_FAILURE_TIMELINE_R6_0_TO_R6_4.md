# R6.0–R6.4 失败时间线

| 版本 | 真实失败 | 控制面结果 | 学习系统结果 |
|---|---|---|---|
| R6.0 | 模型输出 DSML/bash 意图文本，未实际执行；两个叶子及 repair 均为空 diff | review/verification 正确拒绝 | repair/review rejection 被错误理解为叶子过大，建议持续收缩 |
| R6.1 | 增加 DSML 恢复后，真实 Provider 返回 Markdown bash 文本，仍未执行 | 空 diff 被拒绝 | 空变更被错误记录为成功，建议反而扩大 |
| R6.2 | 文本 bash tool-call 未被恢复，仍无实际副作用 | `failed/no_effect` 正确 | infrastructure failure 不污染记忆，正确 |
| R6.3 | 在 Provider 调用前，策略发现请求中没有核心 mutation tool | `failed/minimal_tool_plane`，0 Token | infrastructure failure 不污染记忆，正确 |
| R6.4 | 声称加入辅助请求隔离，但实际仍在 `minimalMutationForceCount=0` 时触发 `minimal_tool_plane` | 0 Token、无 diff，失败分支正确 | infrastructure failure 不污染记忆，正确 |

趋势说明：

1. R6.0–R6.2 的核心问题是“模型工具意图没有进入 Harness 工具管线”。
2. R6.3 将问题前移到请求层，但把“没有工具的请求”直接视作正式 mutation 请求失败。
3. R6.4 没有在真实环境中证明辅助请求隔离或正式请求工具披露；失败发生得更早，说明响应恢复不是当前首要矛盾。
4. 自适应记忆从 R6.2 起已经能正确隔离基础设施故障，应保持不变。
