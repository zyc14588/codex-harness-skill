# R6.4 安装与严格验收提示词

你正在安装并验证 `CODEX_HARNESS_BRIDGE_M1_R6_4` / `0.6.4`。Codex 是唯一总控和最终验收方。

执行要求：

1. 校验 ZIP SHA-256 和内部 `MANIFEST_SHA256.txt`；
2. 使用真实 Harness checkout 安装，不修改 Harness 源码；
3. 验证 commit/build-tree pin；
4. 验证 Bridge 管理的 minimal profile/preset 和渐进工具服务器，并确认 profile 显式禁用 `session-title-llm`；
5. 运行 60 项单元测试、强制 tool_choice、文本/DSML/Markdown Shell 工具恢复 direct E2E、stdio MCP 和 actual doctor；
6. 验证 Dashboard 三标签、人民币默认显示和拆分记忆表；
7. 验证无工具的 Harness 标题辅助请求不会被当成施工请求；若观察到它，应记录 `minimalMutationAuxiliaryBypassCount>=1` 和 `session_title_auxiliary`，随后精确文件 Flash 主请求必须触发 `minimalMutationForceCount>=1`、策略为 `minimal-flash-required-v2`，并证明工具调用确实落盘；
8. 核对 `minimalMutationForceCount`、强制工具和时间；若 Dashboard 出现 `toolProtocolRecoveryCount`，核对 recovery kind、恢复工具和 collect diff；若 recovery count 为 0，核对 `toolProtocolNativeCallCount`；任何情况下都不得凭策略触发或模型摘要推断工具已执行；
9. 验证残缺/越权 DSML、模糊文本工具调用返回 `tool_protocol_error`，验证上游传输故障被标记为 `provider_transport`，并确认这些基础设施异常不缩小 split advice；
10. 验证已有 R6.0 schema-v1 与 R6.1 schema-v2 画像被隔离；R6.2/R6.3 schema-v3 基础设施故障仅保留证据且不改变 R6.4 建议；
11. 创建一个参考阈值很低但 Token 充足的叶子，确认 calls/cost 超出只告警；
12. 创建 input Token gate 很低的叶子，确认硬停止并写入 split memory；
13. 再次调用 `controller_split_advice`，确认真正的任务规模异常会使建议规模/复杂度下降；
14. 创建两个租约互斥的 Pro `large` + `minimal` 叶子，确认并发运行；
15. 至少一个叶子按需启用合同允许的渐进工具；
16. 每个叶子分别 collect、逐文件读取、review、verify、fingerprint、local commit；
17. 不 cherry-pick、merge、push 或发布；
18. 清理 worktree，保留分支、提交、usage、tool-protocol 和 memory 证据；
19. 报告模型、模式、并发峰值、Token、参考费用、工具恢复、基础设施异常、split memory revision、建议变化和提交 SHA。

失败时保留证据并停止。不得关闭 provenance、scope、Git、review、verification、fingerprint 或 Token gates 来制造 PASS。
