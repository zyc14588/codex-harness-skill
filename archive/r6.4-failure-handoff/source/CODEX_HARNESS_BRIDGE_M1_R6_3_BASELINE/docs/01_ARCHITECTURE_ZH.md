# R6.3 架构

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

## 5.1 Minimal Flash 强制变更与协议修复层

R6.2 的真实验收表明，仅在响应结束后识别 DSML/Markdown 仍不足：Flash 可能把工具调用以普通文本形式返回。R6.3 增加请求层策略：

```text
minimal + deepseek-v4-flash
+ mutating bounded leaf
+ 当前 worktree 无 diff
        ↓
收窄工具为已披露的 bash/pwsh/str_replace_editor
禁用本次 thinking，移除 reasoning_effort
设置 tool_choice=required
        ↓
Provider 必须返回至少一个结构化工具调用
        ↓
出现真实 diff 后恢复 Harness 原始请求形状
```

该策略不作用于 Pro、standard、analysis/read-only 或已产生 diff 的请求。工具面缺失或无法检查 worktree 时，任务以 `minimal_tool_plane` 失败关闭。每次触发都会持久化策略版本、工具和次数。

Monitor proxy 仍有一层严格兼容解析：

```text
合法原生 tool_calls                   → 原样透传并记录 native evidence
空/null continuation identity        → 规范化为稳定 streamed tool call
完整 DSML invoke                     → 仅按请求披露工具恢复
单一独立 Shell Markdown 围栏         → 仅限 mutating bounded leaf
精确文本工具调用信封                 → 具名 JSON/XML/bracket/labelled 形式
残缺、越权、带周边说明或普通 JSON     → 不执行；有明确标记时 HTTP 502
```

恢复器只接受请求工具目录内的名称，并限制调用数量与参数字节。普通业务 JSON 即使语法合法也不会被当作工具调用。强制策略、恢复证据和原生工具证据分别写入任务记录与 Dashboard。

## 5.2 空变更终态与记忆隔离

`implementation`、`test`、`repair` 任务只要拥有写租约，就必须产生租约内 Git diff。模型退出码为 0、摘要声称 PASS 或输出命令文本都不能替代该证据。空 diff 会被 worker 标记为 `no_effect` 并失败关闭。

拆分记忆内部 schema 为 v3。执行事件只有在 `status=completed` 且 `changedPathCount>0` 时才可计为成功；`completed_no_changes` 永远不可学习。`tool_protocol`、`minimal_tool_plane`、`provider_transport` 与 `no_effect` 只增加基础设施故障计数，不改变规模、复杂度或 Token 建议。schema-v1/v2 画像在 advice 中被忽略，并在首次新事件写入时归档。

## 6. 极简模式与工具披露

Bridge 管理的 `codex-minimal-headless` profile 使用官方 Agent preset 机制，在 Agent 发布前挂载 `codex-bridge-minimal`。模型初始可见：持久 Shell、`str_replace_editor`、`capability_catalog`、`capability_enable`。

可选能力经任务合同授权后动态出现：

| 能力 | 工具 | 限制 |
|---|---|---|
| `repository_read` | 文件读取、仓库搜索 | 只读、路径 containment、大小限制 |
| `verification` | 冻结命令按索引执行 | 不能提交任意命令 |
| `git_inspect` | status/diff | 只读 Git |

每次启用/拒绝均写审计，任务间不共享动态状态。
