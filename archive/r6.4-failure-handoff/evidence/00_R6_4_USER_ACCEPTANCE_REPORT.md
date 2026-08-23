# R6.4 真实机器验收报告

## 判定

```text
FAIL（受控基础设施失败）
```

## 身份

```text
Bridge runtime version: 0.6.4
Plan: plan-1787365388387
Task: plan-1787365388387-r6-4-minimal-aux-isolation-smoke
Task family: codex-harness-r6-4-auxiliary-request-isolation-smoke-v1
Executor/mode/model/complexity: harness / minimal / deepseek-v4-flash / trivial
Base commit: 6d7225828b45b69ecc44d5bb51a04c40f0865aba
```

## Split advice

```text
schemaVersion = 3
sampleCount = 0
ignoredLegacySampleCount = 0
recommendedLeafScale = 1
recommendedComplexity = trivial
recommendedInputTokens = 180000
recommendedOutputTokens = 240000
```

## 终态遥测

```text
status = failed
infrastructureFailureKind = minimal_tool_plane
changedPaths = []
minimalMutationForceCount = 0
minimalMutationPolicyVersion = missing
minimalMutationForcedTools = []
toolProtocolNativeCallCount = 0
toolProtocolNativeTools = []
toolProtocolRecoveryCount = 0
toolProtocolRecoveryKinds = []
toolProtocolRecoveredTools = []
inputTokens/outputTokens = 0/0
auxiliaryBypassCount/auxiliaryBypassKinds = 0/[]
```

错误：

```text
minimal mutating leaf has no disclosed core mutation tool
```

## 正确执行的失败分支

- 没有 repair；
- 没有读取不存在的目标文件；
- 没有 review、verification、fingerprint 或 commit；
- worktree 已清理；
- Harness 分支保留在基线；
- main 工作树保持干净；
- 没有 cherry-pick、merge、push 或发布。

## Split memory 终态

```text
sampleCount = 0
successCount = 0
infrastructureFailureCount = 1
recommendedLeafScale = 1
recommendedComplexity = trivial
recommendedInputTokens = 180000
recommendedOutputTokens = 240000
```

基础设施失败没有污染有效拆分样本。这一行为是修复时必须保留的正确控制面能力。
