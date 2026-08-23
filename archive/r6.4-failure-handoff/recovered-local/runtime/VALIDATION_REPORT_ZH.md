# CODEX_HARNESS_BRIDGE_M1_R6_4 验证报告

## 1. 发布判定

```text
R6.0 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN
R6.1 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN
R6.2 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN
R6.3 REAL MINIMAL HARNESS ACCEPTANCE: FAILED / WITHDRAWN

R6.4 TYPESCRIPT + 60 UNIT TESTS: PASS
R6.4 DETERMINISTIC PROCESS E2E: PASS
R6.4 STDIO MCP E2E: PASS
R6.4 INSTALL / MIGRATION / ROLLBACK / UNINSTALL: PASS
R6.4 SOURCE PACKAGE HYGIENE: PASS
R6.4 DETERMINISTIC ZIP BUILD: PASS
R6.4 FINAL ZIP REVALIDATION: PASS
R6.4 REAL MACHINE UPGRADE: PENDING
```

本报告对应 `CODEX_HARNESS_BRIDGE_M1_R6_4`：Bridge 版本 `0.6.4`，配置 Schema 版本 `6`，拆分记忆 Schema 版本 `3`，Minimal Flash 强制策略版本 `minimal-flash-required-v2`。

R6.4 已在确定性 fixture 中完成编译、60 项单元测试、Controller/Monitor/Harness/llama.cpp 全进程 E2E、stdio MCP、隔离安装、配置迁移、同版本失败回滚、跨版本失败回滚、重装、卸载、包卫生、确定性 ZIP 和最终 ZIP 解压复验。当前构建环境不能代替用户机器上的真实 `/home/zyc14588/deepseek-harness`、真实 DeepSeek API 凭据与真实 Provider 输出，因此真实机器状态仍为 `PENDING`。

## 2. R6.0—R6.3 真实失败链

### 2.1 R6.0

两个 `minimal + deepseek-v4-flash` 叶子及 repair 均消耗 Token，但模型输出的 DSML/bash 意图没有进入 Harness 工具执行管线；`changedPaths=[]`，review 与 verification 被正确阻断。拆分记忆又把工具基础设施故障误学为“任务过大”，导致规模与 Token 建议持续收缩。

### 2.2 R6.1

R6.1 增加 DSML 恢复，但真实 Provider 返回单一 Markdown `bash` 围栏，仍作为 assistant 文本结束。空变更还被误记为成功样本，导致 leaf scale 和 Token 建议错误扩大。

### 2.3 R6.2

R6.2 已能把空变更标记为 `failed/no_effect`，并隔离基础设施故障对拆分记忆的影响，但真实 Flash 返回的“文本形式 bash tool-call”没有命中恢复器，最终仍为 `changedPaths=[]`。

### 2.4 R6.3

R6.3 在无 diff 的 minimal Flash 施工请求上增加 `tool_choice=required`，但真实验收在该策略生效前即失败：

```text
minimalMutationForceCount = 0
infrastructureFailureKind = minimal_tool_plane
error = minimal mutating leaf has no disclosed core mutation tool
```

根因是 Harness 的 first-prompt session-title 插件会在真正 Agent 施工请求之前，再发出一个：

```text
包含完整原始任务文本
无 tools
max_tokens = 64
purpose = session-title（仅 Harness 内部字段）
```

的辅助模型请求。DeepSeek HTTP serializer 不把内部 `purpose` 写入 wire，R6.3 因而仅凭任务正文把该标题请求误判为首次施工请求，并在没有 `bash`/编辑器的辅助请求上触发 `minimal_tool_plane`。

因此 R6.0、R6.1、R6.2、R6.3 均已撤回，不得继续用于 minimal Harness 施工。

## 3. R6.4 核心修复

### 3.1 Headless profile 禁用模型标题生成

Bridge 管理的：

```text
$DSH_HOME/profiles/codex-minimal-headless/cordis.patch.yml
```

显式禁用：

```yaml
- id: session-title-llm
  disabled: true
```

一次性受控施工不需要会话标题；移除该辅助调用同时减少无价值 Token 消耗。

### 3.2 代理层辅助请求隔离

即使外部 profile 或未来组合仍产生标题请求，Monitor proxy 也会在 mutation preflight 前识别严格标题请求：

```text
无 tools
小输出上限
固定 session-title 系统提示
```

并记录：

```text
minimalMutationAuxiliaryBypassCount
minimalMutationAuxiliaryBypassKinds = [session_title_auxiliary]
minimalMutationAuxiliaryLastAt
```

辅助请求会原样透传，不检查 worktree、不设置 `tool_choice`、不触发 `minimal_tool_plane`，也不计为施工尝试或拆分记忆样本。

### 3.3 真正施工请求仍严格强制

随后真正携带核心变更工具的 Agent 请求，在以下条件全部成立时进入强制策略：

```text
executor = harness
harnessMode = minimal
model = deepseek-v4-flash
mode = implementation / test / repair
存在非空写租约
当前 worktree 相对 base commit 无 diff
请求已披露 bash / pwsh / str_replace_editor 中至少一项
```

代理将该请求改写为：

```text
工具集合收窄到已披露核心变更工具
thinking = disabled
移除 reasoning_effort
tool_choice = required
```

并持久化：

```text
minimalMutationForceCount
minimalMutationForcedTools
minimalMutationPolicyVersion = minimal-flash-required-v2
minimalMutationLastAt
```

一旦出现真实 diff，后续请求恢复 Harness 原始请求形状。主施工请求若确实没有核心变更工具，仍以 `minimal_tool_plane` 失败关闭；辅助请求隔离不能绕过该门禁。

### 3.4 工具协议证据与失败关闭

Provider 原生 structured calls 与 Bridge 恢复调用分别记录：

```text
toolProtocolNativeCallCount / toolProtocolNativeTools
toolProtocolRecoveryCount / toolProtocolRecoveryKinds / toolProtocolRecoveredTools
```

当已应用 `tool_choice=required`，Provider 仍只返回普通说明文本或无法安全解析的工具意图时，代理立即返回 `HTTP 502` 并归因为 `tool_protocol`，不会将文本继续交给 Harness。

兼容恢复仅接受覆盖整个 assistant 响应且无歧义的：

- DSML；
- 单一独立 Markdown Shell 围栏；
- 具名 JSON 工具调用信封；
- XML `<tool_call>`；
- bracket / labelled / function-style 精确信封；
- Provider 原生 structured tool calls。

普通业务 JSON、带周边说明、多围栏、未披露工具、残缺参数和只读任务中的变更命令均失败关闭。

### 3.5 空 diff 与拆分记忆

有写租约的 `implementation/test/repair` 叶子只有在 `changedPathCount>0` 时才可能完成。以下内容均不是成功证据：

- worker 退出码 0；
- Harness 摘要声称 PASS；
- assistant 输出命令或工具调用文本；
- Token 消耗；
- `completed_no_changes`。

无 diff 时任务只能为：

```text
failed/tool_protocol
failed/minimal_tool_plane
failed/provider_transport
failed/no_effect
```

这些基础设施故障只增加 `infrastructureFailureCount`，不增加 `sampleCount/successCount`，也不改变 leaf scale、复杂度或输入/输出 Token 建议。

## 4. Token 门禁与模型分级

只有累计输入与输出 Token 是执行硬门禁：

```text
maxInputTokens
maxOutputTokens
```

API 调用次数、人民币/美元估算费用和运行时间利用率仅产生参考告警，不单独中止任务。

| 执行路径 | 最大复杂度 | 推荐模式 | Token 门禁 |
|---|---:|---|---|
| Harness + `deepseek-v4-pro` | `large` | 优先 minimal | hard input/output；complex 可不受普通 operator ceiling 约束 |
| Harness + `deepseek-v4-flash` | `medium` | 优先 minimal | hard input/output；首次无 diff 施工请求使用强制工具策略 |
| llama.cpp | `small` | exact-file 结构化输出 | hard input/output；合格异常可回退 Flash |

`ceilingPolicy=unbounded` 只表示 Pro complex 不受普通叶子 operator maximum 约束；每个复杂叶子仍必须冻结有限 input/output Token 门禁。

## 5. 编译与单元测试

```text
TypeScript clean dist rebuild: PASS
TypeScript strict --noEmit:     PASS
Node runtime dependencies:     0
Source symlinks:               0
Unit tests:                    60 passed / 0 failed / 0 skipped
```

重点覆盖：

- 标题辅助请求在 mutation preflight 前被隔离；
- 标题请求后真正 Agent 请求仍触发 required 策略；
- minimal profile 禁用 `session-title-llm`；
- first mutation `tool_choice=required`、thinking 禁用、工具收窄；
- 已有 diff、Pro、standard、analysis/read-only 不触发；
- 主请求无核心变更工具时失败关闭；
- DSML、Markdown Shell、文本信封和原生 structured calls；
- required 违约立即失败；
- Token-only gate；
- `no_effect` 和基础设施记忆隔离；
- progressive tools、lease、lock、process group、provenance；
- monitor PID 复用和 worker orphan 竞态。

## 6. 确定性进程 E2E

```json
{
  "result": "PASS",
  "version": "0.6.4",
  "adaptiveSplitMemory": "PASS",
  "splitMemoryInfrastructureIsolation": "PASS",
  "dsmlToolCallRecovery": "PASS",
  "markdownShellToolCallRecovery": "PASS",
  "textualToolCallEnvelopeRecovery": "PASS",
  "minimalFlashRequiredToolChoice": "PASS",
  "requiredToolChoiceViolationFailsClosed": "PASS",
  "nativeStructuredToolEvidence": "PASS",
  "auxiliaryTitleIsolationBeforeMutation": "PASS",
  "requiredChangeNoEffectIsolation": "PASS",
  "malformedDsmlFailsClosed": "PASS",
  "parallelMinimalHarness": "PASS",
  "proComplexTokenGateHardStop": true,
  "apiCallsAndCostReferenceOnly": true,
  "monitoredApiCalls": 26,
  "fallbackModel": "deepseek-v4-flash",
  "managedLlamaServerLifecycle": "PASS",
  "dashboardTheme": "soft-light",
  "billingAuthoritative": false
}
```

标题隔离 fixture 实际执行：

```text
无工具 session-title 辅助请求
→ 记录 session_title_auxiliary bypass
→ 不触发 mutation preflight
→ 真正 Agent 请求携带 bash
→ tool_choice=required + non-thinking
→ Provider 返回 native bash tool call
→ fake Harness 执行 Shell
→ 创建精确租约文件
→ collect 发现唯一 changed path
→ 逐文件读取
→ review approved
→ verification PASS
→ reviewed/current/verified fingerprint 一致
→ 创建本地提交
→ cleanup
```

另一个 fixture 故意在 `tool_choice=required` 后返回普通文本。代理立即返回 502，任务归因为 `tool_protocol`，且 split memory 的样本、规模、复杂度和 Token 建议保持不变。

## 7. stdio MCP

```text
Transport:                     stdio JSON-RPC
Server version:                0.6.4
MCP tools:                     22
Pro complex gate policy:       input_output_tokens / hard
Adaptive split tools:          PASS
Review / verify / commit:      PASS
```

## 8. 安装、迁移、回滚与卸载

完整 9 阶段发布链：

```text
1. fresh transactional install                                PASS
2. installed doctor 与 minimal profile/preset provenance      PASS
3. installed acceptance / stdio MCP / monitor                 PASS
4. schema v4 → v6 migration与自定义值保留                     PASS
5. same-version 注册失败事务回滚，注入 rc=9                    PASS
6. cross-version runtime/monitor/profile/preset 恢复，rc=9     PASS
7. R6.4 reinstall                                             PASS
8. uninstall 保留 evidence/runtime/config                     PASS
9. package hygiene、JSON 与 Schema 检查                       PASS
```

独立 process E2E 已先完整执行；安装事务使用脚本支持的隔离模式跳过重复 process E2E。installed unit/MCP/doctor、迁移、回滚、重装、卸载和卫生门禁均实际执行，最终退出码为 `0`。

迁移保留：

- 自定义 input/output Token 门禁；
- llama.cpp endpoint、模型、binary 与 timeout；
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
最终 ZIP 解压后 60 项单元测试              PASS
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

升级后使用全新 `taskFamily` 创建一个精确文件的 `trivial + minimal + deepseek-v4-flash` 叶子，并确认：

1. `bridge_doctor` PASS；
2. installed minimal profile 中 `session-title-llm` 已禁用；
3. 若仍观察到标题辅助请求，则 `minimalMutationAuxiliaryBypassKinds` 包含 `session_title_auxiliary`；
4. 真正施工请求 `minimalMutationForceCount>=1`；
5. `minimalMutationPolicyVersion=minimal-flash-required-v2`；
6. 强制工具至少包含 `bash`、`pwsh` 或 `str_replace_editor`；
7. native 或 recovery evidence 至少一类存在；
8. Harness 实际产生唯一租约内文件；
9. collect changed paths 精确匹配；
10. Codex 逐文件读取并批准 review；
11. verification PASS 且三指纹一致；
12. 创建本地分支提交，不 merge/push；
13. split memory 形成一个有效成功样本；
14. 失败路径必须 fail-closed，且不得改变拆分建议。

真实机器完成前，准确状态为：

```text
R6.0: FAILED / WITHDRAWN
R6.1: FAILED / WITHDRAWN
R6.2: FAILED / WITHDRAWN
R6.3: FAILED / WITHDRAWN
R6.4 deterministic build/test/install/package: PASS
R6.4 real-machine controlled use: PENDING
```
