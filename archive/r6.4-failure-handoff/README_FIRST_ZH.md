# Codex-Harness Bridge R6.4 失败修复交接包

本包用于把 **R6.4 真实机器验收失败**完整交接给 Codex，继续定位、施工、验证和重新发布。

## 结论先行

当前版本状态必须按以下方式管理：

```text
R6.0：FAILED / WITHDRAWN
R6.1：FAILED / WITHDRAWN
R6.2：FAILED / WITHDRAWN
R6.3：FAILED / WITHDRAWN
R6.4：FAILED / WITHDRAWN
```

R6.4 的控制面表现正常：环境检查、失败隔离、Git 门禁、清理和 split-memory 基础设施故障记账均符合预期。但 minimal Harness 在 Provider 调用前就因 `minimal_tool_plane` 失败，强制 mutation 策略完全没有进入已应用状态：

```text
minimalMutationForceCount = 0
inputTokens/outputTokens = 0/0
changedPaths = []
infrastructureFailureKind = minimal_tool_plane
```

因此，下一步不是继续增加响应文本恢复规则，而是先证明：

1. Bridge 管理的 minimal preset 在真实 Agent 作用域中实际暴露了哪些工具；
2. 正式 mutation 请求发往 DeepSeek adapter 前实际组装了哪些工具；
3. Monitor proxy 收到的第一批请求分别是什么用途；
4. 为什么正式请求进入 `applyMinimalMutationPolicy` 时没有 `bash`、`pwsh` 或 `str_replace_editor`；
5. 安装在本机的 0.6.4 runtime/profile/preset 是否确实包含声称的 R6.4 变更。

## 包内结构

```text
source/       当前会话可获得的完整 0.6.3 工程源码基线
prompts/      Codex 施工、严格验收和最终审计提示词
docs/         给项目所有者阅读的解释、技术审计、修复设计和风险登记
evidence/     R6.0–R6.4 失败事实与 R6.4 验收原始摘要
scripts/      从本机回收 0.6.4 已安装 runtime/profile/preset/任务证据的只读脚本
```

## 重要来源限制

当前会话执行环境中**没有精确的 R6.4 源码归档**。本包包含的是最后一个可核验的完整源码树：`0.6.3`。用户机器上的下列内容是恢复精确 R6.4 实现的权威输入：

```text
/home/zyc14588/.local/share/codex-harness-bridge/0.6.4
/home/zyc14588/.config/codex-harness-bridge/config.json
$DSH_HOME/profiles/codex-minimal-headless
$DSH_HOME/.agent-presets/codex-bridge-minimal
plan-1787365388387-r6-4-minimal-aux-isolation-smoke 的任务证据目录
```

Codex 必须先运行 `scripts/capture-installed-r6-4.sh`，把本机精确 runtime 与 profile/preset 复制到本包工作区；不得直接把 0.6.3 基线冒充为 0.6.4 源码。

## 使用顺序

```bash
unzip CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1.zip
cd CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1

./scripts/verify-package.sh
./scripts/capture-installed-r6-4.sh \
  --task-id plan-1787365388387-r6-4-minimal-aux-isolation-smoke

./scripts/inspect-repair-inputs.sh
codex
```

进入 Codex 后，完整粘贴：

```text
prompts/00_CODEX_MASTER_REPAIR_PROMPT_ZH.md
```

施工完成后另开全新 Codex 会话，依次使用：

```text
prompts/01_CODEX_STRICT_ACCEPTANCE_PROMPT_ZH.md
prompts/02_CODEX_POST_REPAIR_AUDIT_PROMPT_ZH.md
```

任何确定性 fixture PASS 都不能替代真实 `/home/zyc14588/deepseek-harness` + 真实 DeepSeek Provider 的最终 smoke test。
