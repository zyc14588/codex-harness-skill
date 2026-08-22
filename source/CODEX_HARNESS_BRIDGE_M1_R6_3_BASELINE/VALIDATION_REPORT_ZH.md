# CODEX_HARNESS_BRIDGE_M1_R6_3 验证报告

## 1. 发布判定

```text
R6.0 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN
R6.1 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN
R6.2 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN

R6.3 TYPESCRIPT + 58 UNIT TESTS: PASS
R6.3 DETERMINISTIC PROCESS E2E: PASS
R6.3 STDIO MCP E2E: PASS
R6.3 INSTALL / MIGRATION / ROLLBACK / UNINSTALL: PASS
R6.3 SOURCE PACKAGE HYGIENE: PASS
R6.3 DETERMINISTIC ZIP BUILD: PASS
R6.3 FINAL ZIP REVALIDATION: PASS
R6.3 REAL MACHINE UPGRADE: PENDING
```

本报告对应 `CODEX_HARNESS_BRIDGE_M1_R6_3`，Bridge 版本 `0.6.3`，配置 Schema 版本 `6`，拆分记忆内部 Schema 版本 `3`。

当前发布包在确定性 fixture 中完成了编译、单元测试、进程级 Controller/Monitor/Harness/llama.cpp E2E、stdio MCP、隔离安装、配置迁移、同版本失败回滚、跨版本失败回滚、重装、卸载、确定性 ZIP 和最终 ZIP 解压复验。当前构建环境不能替代用户机器上的真实 `/home/zyc14588/deepseek-harness`、真实 DeepSeek API 凭据和真实 Provider 输出，因此真实机器状态仍为 `PENDING`，不能宣称 `CONTROLLED USE ALLOWED`。

## 2. 前三版真实失败证据

### 2.1 R6.0

两个 `minimal + deepseek-v4-flash` 叶子及各自 repair 都消耗了 Token，但没有产生租约内文件。模型输出 DSML/bash 工具意图文本，Harness 没有执行；`changedPaths=[]`，review 被拒绝，verification 正确阻断。

R6.0 的记忆系统把 repair/review rejection 当作任务过大信号，错误地把 leaf scale 和 Token 建议持续压低。这是基础设施故障污染拆分学习。

### 2.2 R6.1

R6.1 增加 DSML 恢复，但真实 Provider 返回的是单一 Markdown `bash` 围栏。围栏仍作为 assistant 文本结束，没有进入 Harness 工具管线，目标文件不存在。

更严重的是，该空变更执行被错误记录为成功样本：

```text
sampleCount: 0 → 1
successCount: 0 → 1
leaf scale: 1.0 → 1.12
recommended input/output tokens: 180000/240000 → 201601/268800
```

因此 R6.1 同时存在工具执行缺口和成功学习条件错误。

### 2.3 R6.2

R6.2 已正确实现：

- 空变更任务为 `failed/no_effect`；
- `sampleCount=0`、`successCount=0`；
- `infrastructureFailureCount=1`；
- leaf scale、复杂度和 Token 建议保持不变。

但真实 Flash 返回了“文本形式的 bash tool-call”，既没有原生 structured `tool_calls`，也没有命中 R6.2 已实现的 DSML/Markdown 恢复。最终仍为 `changedPaths=[]`。这证明**只在响应结束后增加格式猜测不能从协议源头保证工具执行**。

因此 R6.0、R6.1、R6.2 均已撤回。

## 3. R6.3 核心修复

### 3.1 请求层 Minimal Flash 强制变更策略

仅在以下条件全部成立时启用：

```text
executor = harness
affected model = deepseek-v4-flash
harnessMode = minimal
mode = implementation / test / repair
存在非空 Harness 写租约
当前 worktree 相对 base commit 仍无 diff
```

代理对该次 Provider 请求执行：

```text
工具目录收窄到当前已披露的 bash / pwsh / str_replace_editor
thinking = disabled
移除 reasoning_effort
tool_choice = required
```

一旦 worktree 出现真实 diff，后续请求恢复 Harness 原始请求形状。该策略不作用于：

- `deepseek-v4-pro`；
- standard Harness；
- analysis/read-only；
- 空写租约；
- 已产生 diff 的任务。

每次触发持久化：

```text
minimalMutationForceCount
minimalMutationForcedTools
minimalMutationPolicyVersion = minimal-flash-required-v1
minimalMutationLastAt
```

策略触发本身不是成功证据；最终仍必须有租约内 Git diff。

### 3.2 `tool_choice=required` 响应不变量

当代理已经应用强制变更策略后，Provider 响应必须至少满足一个条件：

- 返回合法原生 structured tool call；
- 返回可按严格规则恢复的工具调用信封。

若仍返回普通文本，代理立即：

```text
HTTP 502
infrastructureFailureKind = tool_protocol
toolProtocolFailure = provider violated minimal-flash-required-v1
```

不会把普通文本继续交给 Harness，也不会等 worker 结束后才归因为空变更。

### 3.3 严格文本工具调用兼容层

R6.3 保留 DSML、Markdown Shell 和 structured normalization，并增加“整个响应就是工具调用”的精确格式：

- 具名 JSON，例如 `bash tool-call:` 后跟参数对象；
- XML `<tool_call>` / `<tool_calls>`；
- `[Calling tool: ... with arguments: ...]`；
- labelled/function-style 精确信封；
- fenced JSON 工具调用对象。

兼容层必须同时验证：

- Bridge 有界变更合同；
- 非空写租约；
- 工具已在本次请求正式披露；
- 完整响应无周边说明；
- 参数是可确定的 JSON 对象或受控 Shell command；
- 调用数量和参数字节未超限。

普通业务 JSON、带说明文字、模糊标记、未披露工具和残缺参数均不执行。

恢复种类包括：

```text
dsml_content_to_tool_calls
markdown_shell_fence_to_tool_calls
text_tool_call_envelope_to_tool_calls
structured_tool_call_delta_normalized
```

Provider 原生工具调用单独记录：

```text
toolProtocolNativeCallCount
toolProtocolNativeTools
```

### 3.4 空 diff 与拆分记忆

带写租约的 `implementation/test/repair` 叶子只有在 `changedPathCount>0` 时才可能完成。以下内容不能替代实际副作用：

- worker 退出码 0；
- Harness 摘要声称 PASS；
- assistant 输出 Shell 命令或工具调用文本；
- Token 消耗；
- `completed_no_changes` 字样。

无 diff 时任务为：

```text
failed/tool_protocol   # 有明确协议泄漏或 required 违约
failed/no_effect       # 无更具体协议证据
```

`tool_protocol`、`minimal_tool_plane`、`provider_transport`、`no_effect` 只增加 `infrastructureFailureCount`，不改变任务规模、复杂度或 Token 建议。执行成功要求：

```text
status == completed && changedPathCount > 0
```

### 3.5 Dashboard 与审计

“任务”详情新增：

- Minimal 强制变更请求次数；
- 策略版本；
- 强制工具列表；
- 最近触发时间；
- recovery/native evidence；
- infrastructure failure。

任务历史行同时显示工具协议恢复和强制变更请求次数。

### 3.6 生命周期与安全延续

R6.3 保留：

- worker readiness 两阶段握手；
- dead PID 二次确认后才可 orphan；
- monitor PID 启动 tick + 精确模块路径身份绑定；
- Provider 非幂等 POST 不盲目自动重试；
- scope、HEAD/index、symlink/gitlink、provenance、review、verification、fingerprint 硬门禁；
- 不自动 merge、push 或发布。

## 4. Token 门禁与模型分级

只有累计输入/输出 Token 是模型用量硬门禁：

```text
maxInputTokens
maxOutputTokens
```

以下参数仅产生参考告警：

```text
maxApiCalls
maxCostCny / maxCostUsd
runtime utilization
```

| 路径 | 最大复杂度 | 模式 | Token 门禁 |
|---|---:|---|---|
| Harness + `deepseek-v4-pro` | `large` | 优先 minimal | hard input/output；complex 可不受普通 operator ceiling 约束 |
| Harness + `deepseek-v4-flash` | `medium` | 优先 minimal | hard input/output；首个无 diff 变更请求使用强制工具策略 |
| llama.cpp | `small` | exact-file 结构化输出 | hard input/output；合格异常可回退 Flash |

## 5. 编译与单元测试

```text
TypeScript clean dist rebuild: PASS
TypeScript strict --noEmit:     PASS
Node runtime dependencies:     0
Source symlinks:               0
Unit tests:                    58 passed / 0 failed / 0 skipped
```

关键测试覆盖：

- Minimal Flash 首次变更请求强制 `tool_choice=required`；
- thinking 禁用与 `reasoning_effort` 移除；
- 已产生 diff 后恢复普通请求；
- Pro/standard/read-only 不触发；
- 无核心变更工具时 preflight 失败；
- DSML、Markdown、文本信封和原生 structured calls；
- 普通 JSON 与带说明工具文本不执行；
- Token-only gate；
- `no_effect` 与 schema-v2 污染隔离；
- progressive tools、lease、lock、process group、provenance；
- monitor PID 复用与 worker orphan 竞态。

## 6. 确定性进程 E2E

结果：

```json
{
  "result": "PASS",
  "version": "0.6.3",
  "adaptiveSplitMemory": "PASS",
  "splitMemoryInfrastructureIsolation": "PASS",
  "dsmlToolCallRecovery": "PASS",
  "markdownShellToolCallRecovery": "PASS",
  "textualToolCallEnvelopeRecovery": "PASS",
  "minimalFlashRequiredToolChoice": "PASS",
  "requiredToolChoiceViolationFailsClosed": "PASS",
  "nativeStructuredToolEvidence": "PASS",
  "requiredChangeNoEffectIsolation": "PASS",
  "malformedDsmlFailsClosed": "PASS",
  "parallelMinimalHarness": "PASS",
  "proComplexTokenGateHardStop": true,
  "apiCallsAndCostReferenceOnly": true,
  "monitoredApiCalls": 24,
  "fallbackModel": "deepseek-v4-flash",
  "managedLlamaServerLifecycle": "PASS",
  "dashboardTheme": "soft-light",
  "billingAuthoritative": false
}
```

文本工具调用测试实际执行：

```text
Monitor 发现 worktree 无 diff
→ 请求改为 non-thinking + tool_choice=required
→ fixture Provider 返回 bash tool-call 文本信封
→ proxy 恢复为 streamed structured tool_calls
→ fake Harness 执行 bash
→ 创建精确租约文件
→ collect 精确发现 changed path
→ 逐文件读取
→ review approved
→ verification PASS
→ reviewed/current/verified fingerprint 一致
→ 本地分支提交
→ cleanup
```

另一个 fixture 故意在 `tool_choice=required` 后返回普通文本。代理立即返回 502、任务归因为 `tool_protocol`，且 split memory 的 sample/scale/Token 建议保持不变。

## 7. stdio MCP

```text
Transport:                     stdio JSON-RPC
Server version:                0.6.3
MCP tools:                     22
Pro complex gate policy:       input_output_tokens / hard
Adaptive split tools:          PASS
Review / verify / commit:      PASS
```

## 8. 安装、迁移、回滚与卸载

完整发布链结果：

```text
1. fresh transactional install                                PASS
2. installed doctor 与 minimal profile/preset provenance      PASS
3. installed acceptance / stdio MCP / monitor                 PASS
4. schema v4 → v6 migration 与自定义值保留                    PASS
5. same-version 注册失败事务回滚，注入 rc=9                    PASS
6. cross-version runtime/monitor/profile/preset 恢复，rc=9     PASS
7. R6.3 reinstall                                             PASS
8. uninstall 保留 evidence/runtime/config                     PASS
9. package hygiene、JSON 与 Schema 检查                       PASS
```

发布脚本的完整重复 E2E 在一次单命令运行中触及执行容器外层时限。最终验收采用脚本支持的隔离模式：先独立运行完整 process E2E，再在安装事务中显式跳过该重复步骤；installed unit/MCP/doctor、迁移、回滚、重装、卸载和卫生门禁均实际执行。最终后台发布进程退出码为 `0`。

迁移保留：

- 自定义 input/output Token 门禁；
- llama.cpp endpoint、模型、binary 和 timeout；
- runtime controls；
- CNY 主计价与默认隐藏 USD；
- minimal profile/preset managed provenance。

## 9. 最终归档门禁

```text
MANIFEST_SHA256 全文件校验                 PASS
确定性 ZIP 构建 ×2                         PASS
两份 ZIP 字节完全一致                      PASS
路径穿越、重复条目与 symlink 检查          PASS
Unix 执行权限                              PASS
最终 ZIP 解压后 58 项单元测试              PASS
最终 ZIP 解压后完整 process E2E             PASS
最终 ZIP 解压后 stdio MCP E2E               PASS
最终 ZIP 解压后安装/迁移/回滚/卸载          PASS
```

最终包不含：

```text
.git
bridge/node_modules
package-lock.json
symlink
临时日志
PID 文件
测试 worktree
测试状态目录
```

## 10. 真实机器复验要求

升级到 R6.3 后，使用新的 `taskFamily` 创建一个精确文件 `trivial + minimal + deepseek-v4-flash` 叶子，确认：

1. `bridge_doctor` PASS；
2. split-memory schema 为 3；
3. `minimalMutationForceCount >= 1`；
4. `minimalMutationPolicyVersion = minimal-flash-required-v1`；
5. 强制工具包含 `bash`、`pwsh` 或 `str_replace_editor`；
6. recovery 或 native call evidence 至少一类存在；
7. Harness 实际产生唯一租约内文件；
8. collect changed paths 精确匹配；
9. Codex逐文件读取并批准 review；
10. verification PASS 且三指纹一致；
11. 创建本地分支提交，不 merge/push；
12. split memory 形成一个有效成功样本；
13. 若仍无 diff，必须 fail-closed，且不改变拆分建议。

真实机器完成前，准确状态为：

```text
R6.0: FAILED / WITHDRAWN
R6.1: FAILED / WITHDRAWN
R6.2: FAILED / WITHDRAWN
R6.3 deterministic build/test/install/package: PASS
R6.3 real-machine controlled use: PENDING
```
