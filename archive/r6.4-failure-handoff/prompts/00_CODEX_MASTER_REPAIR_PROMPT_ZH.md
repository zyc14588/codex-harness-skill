# Codex 主施工提示词：修复 R6.4 minimal tool-plane 失败

你现在是本项目的唯一施工总控。目标不是重新解释失败，而是基于真实证据定位根因、完成最小可靠修复、建立不会再次虚假 PASS 的验收链，并生成候选发布包。

## 一、权威输入

当前工作目录是 `CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1`。先阅读：

```text
README_FIRST_ZH.md
SOURCE_PROVENANCE.json
REPAIR_CONTRACT.yaml
AUDIT_FINDINGS.json
docs/00_EXECUTIVE_EXPLANATION_ZH.md
docs/01_TECHNICAL_AUDIT_ZH.md
docs/02_ROOT_CAUSE_HYPOTHESES_ZH.md
docs/03_RECOMMENDED_REPAIR_ARCHITECTURE_ZH.md
docs/04_ACCEPTANCE_MATRIX_ZH.md
docs/05_RISK_REGISTER_ZH.md
docs/06_SOURCE_RECOVERY_AND_PROVENANCE_ZH.md
evidence/00_R6_4_USER_ACCEPTANCE_REPORT.md
```

源码基线是 `source/CODEX_HARNESS_BRIDGE_M1_R6_3_BASELINE`。它是 0.6.3，不是精确 0.6.4。

必须先确认 `recovered-local/` 已由 `scripts/capture-installed-r6-4.sh` 生成。若不存在，执行该脚本；若无法读取用户本机路径，则立即报告 `BLOCKED_MISSING_EXACT_R6_4_RUNTIME`，不得把 0.6.3 冒充 0.6.4 继续发布。

## 二、已确认失败

真实 R6.4 遥测：

```text
status=failed
infrastructureFailureKind=minimal_tool_plane
minimalMutationForceCount=0
minimalMutationForcedTools=[]
toolProtocolNativeCallCount=0
toolProtocolRecoveryCount=0
inputTokens/outputTokens=0/0
changedPaths=[]
auxiliaryBypassCount=0
```

错误：`minimal mutating leaf has no disclosed core mutation tool`。

R6.0–R6.4 均为 `FAILED / WITHDRAWN`。不得沿用任何历史“确定性 PASS”作为发布依据。

## 三、施工规则

1. 不直接修改已安装 0.6.4 runtime 或用户主项目仓库。
2. 新建独立 Git 工作目录，恢复一份可构建源码。
3. 先比较 0.6.3 source/dist 与 recovered 0.6.4 runtime/profile/preset；输出差异报告。
4. 先定位请求工具在哪一层丢失，再编码。必须区分 Agent scoped visible tools、assembled request tools、DeepSeek adapter input tools、wire request tools、proxy parsed tools。
5. 为模型请求增加脱敏 evidence，只允许记录用途、序号、endpoint、顶层字段、工具名称、工具数量、message roles、max token、thinking 类型、合同标记。禁止记录 API key、Authorization、消息正文或完整参数。
6. 不得把继续增加 Markdown/DSML 模糊解析作为主修复。
7. 保持 input/output Token 唯一硬用量门禁、API/费用参考告警、基础设施故障记忆隔离、无 diff 门禁、scope/Git/fingerprint 门禁和禁止自动集成。
8. 优先最小变更，不进行无关重构。
9. 不得用 Harness 修复 Harness Bridge 的这一路径；本轮由 Codex 直接施工，避免递归依赖故障链。

## 四、强制诊断任务

### D1. Provenance

- 读取 recovered installed runtime version；
- 读取 MCP 实际注册命令和路径；
- 读取 monitor PID/module identity；
- 散列 installed runtime、profile、preset；
- 检查 source map 是否能映射回 TS；
- 检查 0.6.4 变更是否真的存在。

### D2. Profile/preset effective composition

- 检查 managed marker；
- 检查 `session-title-llm` 有效状态；
- 检查 custom headless runner；
- 检查 mounted preset ID；
- 使用 Harness profile dump 或等价方式获得有效组合；
- 证明 runtime Agent 能看到 `bash`/`pwsh` 和 `str_replace_editor`。

### D3. Request path

为 mock provider 重现一次真实 profile 调用，捕获 request ordinal、request purpose、runner visible tools、assembled tools、wire tools 和 proxy parsed tools。必须解释为什么 R6.4 在 force count 为 0 时产生 `minimal_tool_plane`。

### D4. Root-cause classification

必须在以下类别中选出一项或多项，并给出证据：

```text
stale_or_mixed_installation
profile_or_preset_composition_failure
request_purpose_ordering_failure
tool_serialization_mismatch
proxy_schema_parser_mismatch
other_evidence_backed_root_cause
```

不允许只写“可能”。

## 五、目标设计

实现显式、可审计的请求状态机。推荐但不强制的最小方案：

```text
runner mounted preset
→ runner records scoped tool snapshot
→ runner marks primary mutation armed immediately before followup
→ proxy classifies each request before policy
→ auxiliary requests bypass and audit
→ primary mutation compares scoped snapshot with wire tools
→ no diff: apply tool_choice=required
→ persist force telemetry
→ Provider
```

错误至少区分：

```text
minimal_tool_plane_composition
minimal_tool_serialization_mismatch
tool_protocol
no_effect
provider_transport
```

如果选择不同方案，必须证明其比 prompt-based inference 更可靠，并保持 Harness 源码不被私有修改；Bridge 可以通过自己安装的 profile/preset/plugin 扩展。

## 六、测试要求

### 单元测试

至少新增：

1. auxiliary 请求在 policy 前被识别；
2. primary mutation 请求没有 core tool 时给出准确归因；
3. runner 有 core tool、wire 无 tool 时为 serialization mismatch；
4. policy applied 时 force counter 在 POST 前递增；
5. impossible state invariant；
6. debug evidence 完全脱敏；
7. infrastructure failures 不改变 split advice。

### 动态 fixture

必须使用真实 Bridge managed profile/preset 和 Harness 固定 commit，通过 mock Provider 验证 `profile → Agent → request assembly → DeepSeek serializer → proxy`。不能直接伪造 proxy request body 代替整个链路。

### 真实机器 smoke

候选包安装后，必须使用真实 DeepSeek key 完成精确单文件租约任务。任何真实失败都撤回候选包。

## 七、版本和交付

使用候选版本 `0.6.5-rc.1`。只有真实 smoke PASS 后才允许发布 `0.6.5`。

最终一次性生成完整源码树、修复差异说明、根因报告、测试报告、真实 smoke 证据、安装包 ZIP、SHA-256、MANIFEST 和后续验收提示词。不得逐个要求用户下载；最终统一打包。

## 八、完成判定

只有以下全部成立才可报告 PASS：

```text
minimalMutationForceCount >= 1
minimalMutationForcedTools 非空且含 core mutation tool
nativeCallCount > 0 或 recoveryCount > 0
changedPaths 精确等于租约
逐文件审查完成
controller_review_task=approved
verification PASS
reviewed/current/verified fingerprint 完全一致
本地 commit 已创建
worktree 已清理
main 未变化
split-memory 正确记为有效成功样本
真实 DeepSeek/Harness smoke PASS
```

在此之前，只能报告 `BLOCKED`、`FAIL` 或 `PASS_WITH_CONDITIONS`，不得声称 controlled use allowed。
