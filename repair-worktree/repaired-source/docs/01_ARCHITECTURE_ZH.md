# 0.6.5 稳定版架构

## 1. 权限边界

Codex 持有规划、拆分、合同冻结、审查、验证和集成决策。Harness 与 llama.cpp 只处理叶子任务。Bridge 负责持久状态、隔离 worktree、预算代理、模型路由、渐进工具、拆分记忆和安全门禁。

```text
用户目标
  ↓
Codex 读取仓库治理 + controller_split_advice
  ↓
冻结 Plan / DAG / leases / splitDecision / Token gates
  ├─ Codex lane
  ├─ Harness minimal worker A ─┐
  ├─ Harness minimal worker B ─┼─ 可并行
  └─ llama.cpp simple leaf  ───┘
  ↓
collect / file-by-file review / verify / fingerprint / local commit
  ↓
执行、审查、验证结果写回 split memory
  ↓
下一次拆分动态调整规模、复杂度与 Token gates
```

## 2. 持久状态

`stateRoot` 下保存：

- `plans/`：冻结计划和叶子合同；
- `tasks/`：worker 状态、日志、diff、验证、提交证据；
- `usage/`：Provider/local usage 与 Token totals；
- `controls/`：Web 预算策略、活动组覆盖和本地模型设置；
- `split-memory/<repo>/profiles/`：每个任务族/模型/模式的学习画像；
- `split-memory/<repo>/events/`：append-only 分阶段结果事件；
- `minimal-tools/`：工具披露审计。

## 3. 自适应拆分

记忆键由 `taskFamily + mode + executor/model + harnessMode` 构成，并按仓库隔离。没有显式 `taskFamily` 时，Controller 使用租约路径生成保守任务族；语义上会重复的工作应由 Codex显式命名。

画像使用：

- EMA input/output Token 与占用比例；
- EMA runtime 比例（只影响拆分建议，不是用量门禁）；
- 成功、异常、Token 超限、timeout、repair、fallback、验证失败计数；
- 推荐 scale、complexity、input/output gates；
- complex-leaf confidence。

少于 `minSamplesForEnforcement` 时建议仅供参考；样本和置信度达到条件后，Controller 会拒绝明显大于记忆建议的叶子，除非 Codex提交具体 `memoryOverrideReason`。

## 4. Token 门禁

每个 budget group 累计：

```text
inputTokens + estimatedInputTokens  <= maxInputTokens
outputTokens + estimatedOutputTokens <= maxOutputTokens
```

预检、流式增量和最终 usage 都执行该规则。API 调用次数、人民币/美元估算只产生 `referenceAlerts`，不会阻止模型请求、worker、review、verify 或 commit。

取消、runtime timeout、scope、Git、symlink/gitlink、provenance 等仍是独立治理门禁，不能被“仅 Token 门禁”绕过。

## 5. 并行与隔离

Controller 验证 DAG 无环、依赖完成、租约互斥和并发配额。Git worktree 创建/清理通过短期仓库锁串行；模型施工区间可真实并行。每个 leaf 有独立分支、worktree、task、budget group、fingerprint 和本地提交。

## 5.1 显式请求状态机与 Minimal Flash 强制变更

Bridge 管理的 headless profile 禁用 `session-title-llm`，禁用 stock runner，并以独立 ID 加载 Bridge runner。runner 挂载 preset 后记录 Agent scoped visible tools 与 assembled tools，在 `followup()` 前 arm primary mutation；`llm/stream` 再记录冻结的 adapter tools 与 Harness 显式 `purpose`。

代理按 request ordinal 认领下一条 wire 请求。`session-title`、`compaction` 和 pre-arm 请求在 policy 前 bypass；分类不读取消息正文、system prefix 或 max-token shape。主请求必须满足：

```text
runner visible = assembled = adapter input = wire = proxy parsed
```

真正的首次施工请求必须携带核心变更工具，然后才应用强制策略：

```text
minimal + deepseek-v4-flash
+ mutating bounded leaf
+ 当前 worktree 无 diff
+ 请求披露 bash/pwsh/str_replace_editor
        ↓
收窄工具为已披露的核心变更工具
保持 attempt 级 thinking=disabled，Provider wire 省略 reasoning_effort
设置 tool_choice=required
        ↓
Provider 返回结构化或可安全恢复的工具调用
        ↓
出现真实 diff 后恢复完整工具目录并移除 tool_choice
thinking 仍保持 disabled
```

每个 Harness attempt 在 worker 启动前冻结模型与 Thinking Policy。Pro attempt 固定 `thinking=enabled`、`reasoning_effort=high` 并禁止 `tool_choice`。Provider 的每条 Pro 工具响应必须含真实非空 `reasoning_content`；Bridge 保存其 SHA-256、UTF-8 长度和 tool-call IDs，并在下一次请求前验证 Harness 历史完整回放。模型/模式切换或 replay 缺失均在 Provider I/O 与 Token 计量前失败。

runner/preset 缺少核心工具以 `minimal_tool_plane_composition` 失败；runner 有工具但 assembled/adapter/wire/proxy 任一层丢失则以 `minimal_tool_serialization_mismatch` 失败。辅助请求隔离不能绕过主请求工具面检查。任务分别记录：

- `minimalRequestPhase`、runner/preset 与五层脱敏 request evidence；
- `minimalMutationAuxiliaryBypassCount/Kinds/LastAt`；
- `minimalMutationForceCount/ForcedTools/PolicyVersion/LastAt`；
- Provider 原生工具调用；
- Bridge 恢复的工具调用；
- 协议或工具面失败。

Monitor proxy 仍保留严格兼容解析：合法原生调用原样透传；完整 DSML、单一独立 Shell Markdown 围栏和精确具名文本信封只在工具已披露、任务合同要求变更且完整响应无歧义时恢复。普通 JSON、周边说明、残缺或越权调用均不执行。

## 5.2 空变更终态与记忆隔离

`implementation`、`test`、`repair` 任务只要拥有写租约，就必须产生租约内 Git diff。模型退出码为 0、摘要声称 PASS 或输出命令文本都不能替代该证据。空 diff 会被 worker 标记为 `no_effect` 并失败关闭。

拆分记忆内部 schema 为 v4。执行事件只有在 `status=completed` 且 `changedPathCount>0` 时才可计为成功；`completed_no_changes` 永远不可学习。工具协议/组合/序列化、thinking policy/replay、Provider protocol/transport 与 `no_effect` 只增加基础设施故障计数，不改变规模、复杂度或 Token 建议。schema-v1/v2/v3 画像在 advice 中被忽略，并在首次新事件写入时归档；零样本基础设施画像返回当前候选提议而不是失败任务的预算。

## 6. 极简模式与工具披露

Bridge 管理的 `codex-minimal-headless` profile 使用官方 Agent preset 机制，在 Agent 发布前挂载 `codex-bridge-minimal`。模型初始可见：持久 Shell、`str_replace_editor`、`capability_catalog`、`capability_enable`。

可选能力经任务合同授权后动态出现：

| 能力 | 工具 | 限制 |
|---|---|---|
| `repository_read` | 文件读取、仓库搜索 | 只读、路径 containment、大小限制 |
| `verification` | 冻结命令按索引执行 | 不能提交任意命令 |
| `git_inspect` | status/diff | 只读 Git |

每次启用/拒绝均写审计，任务间不共享动态状态。
