# 推荐修复架构

## 1. 核心原则：不要再从任务 Prompt 猜请求用途

R6.3 基线通过在 user message 中查找有界叶子合同、任务模式和写租约来判断当前请求是否是 mutation 请求。这对于工具调用恢复可以作为附加门禁，但不足以成为请求用途的唯一权威来源。辅助请求、重放、标题、摘要或未来 compaction 也可能携带部分历史合同。

应建立显式状态：

```text
Task request phase:
  booting
  agent_ready
  primary_mutation_armed
  mutation_in_progress
  diff_observed
  verification
  terminal
```

## 2. 建议的最小可靠路径

### 2.1 Runner 发布 tool-plane snapshot

Bridge-owned headless runner 在 `presets.mount()` 后、`agent.followup()` 前记录：

```json
{
  "taskId": "...",
  "presetId": "codex-bridge-minimal",
  "visibleTools": ["bash", "str_replace_editor", "mcp__bridge__..."],
  "coreMutationTools": ["bash", "str_replace_editor"],
  "capturedAt": "...",
  "source": "ctx.tools.schemas(agent)"
}
```

如果 core tools 缺失，应在 runner 层失败，并报告实际 visible tools；此时错误叫 `minimal_tool_plane_composition`。

### 2.2 Runner 显式 arm 首次 mutation

在 `agent.followup()` 紧前，通过受控本地接口或原子任务事件写入：

```text
primaryMutationArmedAt
primaryMutationRequestSequenceExpected
```

只有 arm 之后、diff 之前的正式 Agent 请求可以进入强制 policy。标题请求发生在 arm 前，应被记录为 auxiliary 或被 profile 禁用。

### 2.3 Proxy 记录脱敏 request envelope

每个请求持久化：

```text
requestOrdinal
endpoint
requestPurpose
topLevelKeys
toolSchemaCount
toolNames
messageRoles
contractMarkerPresent
maxTokens
thinkingType
```

不得保存 Authorization、API key、消息正文、工具参数正文或 Provider 原始完整响应。

### 2.4 区分三类工具平面错误

```text
minimal_tool_plane_composition:
  runner 作用域中没有 core tools

minimal_tool_serialization_mismatch:
  runner 有 core tools，但 wire request tools 为空或不一致

minimal_mutation_policy_violation:
  policy 已应用，Provider 未返回结构化或可安全恢复调用
```

## 3. Policy 应用顺序

推荐顺序：

```text
load latest task
→ parse and classify request
→ record redacted envelope
→ if auxiliary: bypass + audit
→ if not armed mutation: pass through or fail by explicit state rule
→ compare runner tool snapshot with wire tools
→ if composition mismatch: fail with exact attribution
→ inspect worktree diff
→ if no diff: apply required tool policy
→ persist force telemetry before upstream POST
→ send Provider request
```

`minimalMutationForceCount` 必须在上游请求开始前持久化，并且只有 `applied=true` 才递增。

## 4. Profile/preset 验收

安装器必须对最终已安装 profile/preset执行语义验收：

1. marker version 与 runtime version 一致；
2. 文件 hash 与模板渲染结果一致；
3. `session-title-llm` 状态符合设计；
4. preset native presentation 存在；
5. runner 实际挂载 `codex-bridge-minimal`；
6. dynamic probe 能看到 core tools；
7. mock mutation request 的 wire tools 包含至少一个 core tool。

## 5. Doctor 扩展

新增两级检查：

```text
bridge_doctor(static=true)
bridge_doctor(dynamicMinimalProbe=true)
```

动态检查不能调用真实 DeepSeek，也不能修改业务仓库。它应使用临时仓库和本地 mock Provider，验证真实 Harness profile → Agent → serializer → proxy 请求工具目录。

## 6. 真实 Provider 门禁

发布前必须在用户机器运行一个精确文件租约 smoke test。成功条件：

```text
minimalMutationForceCount >= 1
core tool in forced tools
nativeCallCount > 0 or recoveryCount > 0
changedPaths == exact lease
review approved
verification PASS
fingerprints equal
local commit created
```

fixture 不能替代这一步。
