# Codex 最终只读审计提示词

以最新候选版本和真实 smoke 证据为基准，不修改任何文件，进行发布前全面审计。

检查：

1. 是否彻底解释并修复 R6.4 的 `forceCount=0 + minimal_tool_plane + 0 Token`；
2. request purpose 是否使用显式状态，而不是主要依赖 prompt 文本；
3. Agent scoped、assembled、wire、proxy tools 是否都有审计证据；
4. Doctor 是否增加动态 minimal request-path probe；
5. 真实 smoke 是否使用真实 Harness、真实 DeepSeek、精确写租约；
6. 是否仍存在 fixture 与真实路径不一致的测试盲区；
7. split-memory 是否只学习任务能力问题，不学习基础设施故障；
8. Token-only hard gate 和 API/cost reference-only 是否保持；
9. scope、Git、review、verification、fingerprint、cleanup 门禁是否保持；
10. 安装、迁移、rollback 是否正确更新 profile/preset；
11. source/dist/version/marker/MCP/runtime 是否一致；
12. 日志是否可能泄露密钥、prompt 正文或工具参数；
13. 旧失败版本是否明确标为 withdrawn；
14. 发布文档是否没有虚假 PASS。

输出 Final audit result、Release blockers、Residual risks、Evidence quality assessment、Controlled-use recommendation 和 Exact next action。

只有全部硬门禁和真实 smoke 通过，才允许建议 `PASS / CONTROLLED USE ALLOWED`。
