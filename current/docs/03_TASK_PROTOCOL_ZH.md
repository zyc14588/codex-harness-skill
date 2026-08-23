# 任务协议

## 1. 拆分前

Codex 必须：

1. 检查仓库治理与干净状态；
2. 冻结 base commit、接口、验收标准和验证命令；
3. 为每个候选叶子确定 `taskFamily`、executor/model、Harness mode 和初始复杂度；
4. 调用 `controller_split_advice`；
5. 根据建议调整规模、复杂度和 input/output Token gates；
6. 使用 `controller_plan_create` 冻结决定。

每个 leaf 的关键字段：

```json
{
  "id": "storage-migration",
  "taskFamily": "storage/postgres-migration",
  "splitRationale": "schema 与 repository 可在独立租约完成",
  "executor": "harness",
  "model": "deepseek-v4-pro",
  "complexity": "large",
  "harnessMode": "minimal",
  "parallelGroup": "backend-wave-1",
  "dependsOn": [],
  "toolCapabilities": ["repository_read", "verification", "git_inspect"],
  "harnessWritePaths": ["internal/storage/**", "migrations/**"],
  "budget": {
    "maxInputTokens": 1600000,
    "maxOutputTokens": 180000,
    "maxApiCalls": 60,
    "maxCostCny": 120,
    "maxCostUsd": 16.7
  }
}
```

这里仅 input/output Token 是硬门禁。calls/cost 是参考阈值。

## 2. 记忆约束

`controller_plan_create` 会保存 `splitDecision`：

```text
memory revision / samples / confidence
recommended scale / complexity / token gates
chosen complexity / token gates
rationale / optional override reason
```

当画像样本和置信度达到门槛，Codex选择更大的 complexity 或明显背离建议时必须提交具体 `memoryOverrideReason`。不能用“需要更快”作为空泛豁免；应说明为什么合同、依赖和租约让本次更大叶子仍可控。

## 3. 并行启动

使用 `controller_launch_leaf`。只有满足依赖、租约互斥和并发配额的叶子可启动。并行组是调度提示，不替代 DAG 或路径验证。

Codex 在 worker 运行时应继续自己的互斥 lane，不得空等。

## 4. 执行终态检查与记忆更新

worker 结束时 Bridge 自动读取：

- task status、attempts、timeout、fallback、scope/Git 异常；
- budget group 输入/输出 Token totals；
- API calls、费用和 runtime ratio（参考）；
- repair 状态；
- `minimalMutationForceCount`、策略版本与强制工具；
- recovery/native tool-call 证据和 `infrastructureFailureKind`。

对 `minimal + deepseek-v4-flash` 的有界变更叶子，只要当前仍无 diff，Monitor 会在请求层使用非思考模式与 `tool_choice=required` 强制至少一次已披露的核心变更工具。该事实只是协议证据，不替代最终 Git diff。

执行阶段结果写入一次。随后：

- `controller_review_task` 写 review 阶段结果；
- `harness_verify` 写 verification 阶段结果；
- 每个阶段使用独立幂等 marker。

Token 超限不会在 review/verification 阶段重复计数；review revise/reject 或 verification failure 仍会独立降低后续建议。

## 4.1 基础设施异常归因

`tool_protocol`、legacy `minimal_tool_plane`、`minimal_tool_plane_composition`、`minimal_tool_serialization_mismatch`、`thinking_policy_state`、`thinking_replay_state`、`provider_protocol`、`provider_transport` 与 `no_effect` 表示 Provider/Agent/上游协议或传输链异常，而不是叶子任务过大。它们会：

- 使当前叶子 fail-closed；
- 保留 usage、stdout/stderr 和协议证据；
- 增加 `infrastructureFailureCount`；
- 不增加 task-shape `sampleCount` / `anomalyCount`；
- 不缩小推荐规模、复杂度或 Token 门禁。

split-memory schema v5 不使用 schema-v1/v2/v3/v4 画像，并在后续写入时把旧文件归档到 `legacy/`。历史记录继续作为证据存在，但不能改变 schema 5 的规模、复杂度或 Token 建议。仅有基础设施事件且 sample 为零时，advice 必须保留当前候选提议。

## 5. 审查和验收

```text
harness_collect
→ harness_read_changed_file（changed paths 逐个）
→ controller_review_task
→ 必要时 harness_repair
→ reviewed.patch + reviewed fingerprint
→ baseCommit 的新 detached verification worktree
→ git clean -ffdx + 只应用 reviewed.patch
→ harness_verify（冻结命令在 clean tree 中执行）
→ harness_commit
→ 接收分支完整验证
→ controller_finalize_plan
→ harness_cleanup
```

reviewed/current/verified fingerprint 必须一致，ignored/untracked residue 不得进入 verification tree，且临时 worktree 必须删除。不同并行叶子必须分别审查、验证和提交。

## 6. 复杂度规则

- Pro Harness 可使用 `large`；
- Flash Harness 最大 `medium`；
- llama.cpp 最大 `small`；
- `auto + large` 被拒绝；
- 大叶子仍需明确 write lease、context 和 acceptance；
- split memory 可建议将后续 `large → medium/small`，或在稳定证据充分时保守扩大。
