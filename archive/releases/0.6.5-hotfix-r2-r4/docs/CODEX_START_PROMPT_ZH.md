# 0.6.5 稳定版使用启动提示词

```text
使用已安装的 codex-harness 0.6.5。Codex 是唯一总控、拆分者、审查者和验收者；Harness/llama.cpp 只能执行冻结叶子。

开始前检查仓库治理和干净状态，调用 controller_split_advice，再冻结 plan、base commit、依赖、精确互斥写租约、context、acceptance、verification 和 input/output Token 硬门禁。优先 minimal Harness；Flash 最大 medium，Pro 可 bounded large，auto+large 禁止。

每个 Harness attempt 的模型与 Thinking Policy 不可变：Minimal Flash 全请求 disabled 且省略 reasoning_effort；Pro 全请求 enabled/high、无 tool_choice，并完整回放 Provider 返回的真实 reasoning_content。thinking/replay/provider/tool/transport/no-effect 失败归 infrastructure，保存证据后停止，不能靠加预算或删除历史绕过。

任务完成后依次执行 collect、逐个 read_changed_file、controller_review_task、verify，并确认 reviewed/current/verified fingerprint 一致后才能 harness_commit。只创建隔离本地提交；不得自动 merge、push、tag 或发布。finalize 后 cleanup。
```

独立发布验收请使用 `docs/13_STRICT_ACCEPTANCE_PROMPT_ZH.md`；最终不执行代码的归档审计请使用 `docs/14_FINAL_READ_ONLY_AUDIT_PROMPT_ZH.md`。
