# 真实机器 smoke 模板

```text
$codex-harness

执行 minimal request-path 真实验收。

要求：
1. bridge_doctor(static=true, dynamicMinimalProbe=true)；
2. 使用全新 taskFamily；
3. 创建 minimal + deepseek-v4-flash + trivial implementation 叶子；
4. 唯一写租约为一个新的 JSON 文件；
5. 文件包含 status/executor/mode/model/bridgeVersion；
6. 完成后立即 collect；
7. 报告 runnerVisibleCoreTools、assembledToolNames、wireToolNames、proxyParsedToolNames；
8. minimalMutationForceCount >= 1；
9. minimalMutationForcedTools 至少含 bash/pwsh/str_replace_editor；
10. nativeCallCount > 0 或 recoveryCount > 0；
11. changedPaths 精确等于租约；
12. 逐文件读取并验证 JSON；
13. review approved；
14. verification PASS；
15. reviewed/current/verified fingerprint 一致；
16. 创建本地 commit；
17. 清理 worktree，保留测试分支；
18. main 不变；
19. 不 merge/push/publish；
20. 再读 split memory，确认成功样本增加 1。
```
