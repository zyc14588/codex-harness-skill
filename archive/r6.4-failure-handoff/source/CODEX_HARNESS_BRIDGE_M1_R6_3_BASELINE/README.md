# Codex ↔ DeepSeek Harness Bridge M1-R6.3

版本：`0.6.3`。

本地 MCP Bridge 让 Codex 直接规划、委派、监控、审查并验证 DeepSeek Harness 与 llama.cpp 叶子任务。R6.3 保留并行极简 Harness、渐进式工具披露、自适应拆分记忆、人民币监控和 llama.cpp 路由，并修复真实环境中 minimal Harness **只输出 Markdown Shell 代码块却未执行工具**的问题。

## R6.3 发布阻断修复

真实机器连续验收已经证明三种不同故障：

```text
R6.0：模型输出 DSML/bash 工具意图，但没有真实副作用；任务被反复 repair。
R6.1：单一 Markdown Shell 围栏没有进入工具执行管线，且空变更被错误学习为成功。
R6.2：空变更已正确 fail-closed、记忆也不再污染，但 Flash 仍可把 bash tool-call 序列化为普通文本；恢复器没有覆盖该真实形态。
```

因此 R6.0、R6.1、R6.2 均不得继续用于 minimal Harness 施工。R6.3 不再只在响应结束后猜测工具意图，而是在**请求层**保证首个真实变更动作：

1. **Minimal Flash 强制变更策略**：仅当 `minimal + deepseek-v4-flash + implementation/test/repair + 非空写租约 + 当前 worktree 仍无 diff` 全部成立时，代理将本次请求切换到非思考模式、删除 `reasoning_effort`、把工具目录收窄为当前已披露的 `bash`/`pwsh`/`str_replace_editor`，并写入 `tool_choice="required"`。一旦出现真实 diff，后续请求恢复 Harness 原始请求形状。
2. **严格文本工具调用兼容层**：在 DSML 与独立 Markdown 围栏之外，兼容若干“整个响应就是工具调用”的受控信封，例如具名 JSON、XML `<tool_call>`、`[Calling tool: ...]` 与 `bash tool-call:`。只有任务合同证明必须变更、工具已披露且完整响应可无歧义解析时才恢复；普通 JSON、周边说明和模糊内容绝不执行。
3. **可审计强制策略证据**：任务记录和 Dashboard 显示 `minimalMutationForceCount`、策略版本、被强制披露的工具及最近触发时间；工具恢复和 Provider 原生调用仍分别记录。
4. **空 diff 硬归因**：带写租约的实现、测试或 repair 叶子最终无 diff 时，worker 标记 `failed`，并按具体证据归因为 `tool_protocol` 或 `no_effect`；不进入 review、verification、commit。
5. **拆分记忆 schema v3**：基础设施故障只增加 `infrastructureFailureCount`，不改变叶子规模、复杂度或 Token 建议；只有 `status=completed && changedPathCount>0` 才可能形成执行成功样本。
6. **Worker/monitor 生命周期加固**：保留 readiness 握手、二次 orphan 确认、monitor PID 身份绑定和异步错误收敛。

强制工具请求不是成功证据。最终验收仍只接受租约内 Git diff、逐文件审查、冻结验证和一致 fingerprint。

## 核心原则

```text
Codex = 唯一总控、任务拆分者、审查者和最终验收者
Harness / llama.cpp = 受合同约束的叶子执行器
输入 Token + 输出 Token = 唯一模型用量硬门禁
API 调用次数 + 金额 = 参考告警，不中止任务
```

Bridge 不自动 merge、push 或发布。每个产生变更的叶子仍须经过：

```text
collect → 逐文件读取 → controller_review_task → verify → fingerprint → commit
```

## 自适应拆分记忆

Codex 在创建计划前调用 `controller_split_advice`。Bridge 按仓库、`taskFamily`、executor/model、Harness 模式和任务模式隔离历史。计划冻结 `splitDecision`，记录：

- 记忆 schema 与 revision；
- 有效样本及被忽略的旧 schema 样本；
- 推荐叶子规模和复杂度；
- 推荐输入/输出 Token；
- Codex 最终选择与覆盖理由。

执行、审查、验证和 finalization 分阶段写入记忆，相同 `taskId:stage` 只记录一次。Token 超限、timeout、scope violation、repair、review rejection 和 verification failure 会缩小后续任务；稳定低占用成功可以保守扩大。基础设施异常仅作为运维证据，不参与任务形状学习。

## 模型与拆分策略

| 路径 | 复杂度 | 推荐模式 | 用量门禁 |
|---|---|---|---|
| Harness + `deepseek-v4-pro` | `trivial` / `small` / `medium` / `large` | 优先 `minimal` | 冻结的 input/output Token 硬门禁；Pro complex 不受普通 operator ceiling 限制 |
| Harness + `deepseek-v4-flash` | `trivial` / `small` / `medium` | 优先 `minimal` | input/output Token 硬门禁 |
| llama.cpp | `trivial` / `small` | 结构化完整文件输出 | input/output Token 硬门禁；异常可受控回退 Flash |

`ceilingPolicy=unbounded` 仅表示 Pro complex 不受普通叶子的 operator maximum 约束；每个复杂叶子仍必须冻结有限的 `maxInputTokens` 与 `maxOutputTokens`。

## 并行极简 Harness

同一计划可同时运行多个 Harness worker，前提是依赖已满足、写租约互斥、base commit 相同，并且未超过全局/单仓库并发限制。每个 worker 使用独立 worktree、分支和 budget group。

安装器事务式安装：

```text
$DSH_HOME/profiles/codex-minimal-headless
$DSH_HOME/.agent-presets/codex-bridge-minimal
```

极简 Agent 初始只获得持久 Shell、编辑器和渐进式能力控制工具。只读能力按合同逐步启用，避免把无关工具 Schema 永久放入请求前缀。

## Web Dashboard

默认地址：`http://127.0.0.1:43127`。

- **任务**：活动任务、并行组、依赖、模式、Token、split decision、协议恢复、原生工具调用证据和基础设施异常；
- **费用**：input/output Token 门禁、API/金额参考告警、人民币实时估算、人工对账；
- **本地模型**：自定义 `llama-server` / `llama-cli`、启动参数、启停、自动路由和 Flash fallback；
- **拆分记忆**：有效样本、异常率、基础设施故障、建议规模、复杂度及 Token 门禁。

人民币为默认展示货币，美元默认隐藏；费用为本地配置价格估算，不是供应商账单。

## 安装

```bash
unzip CODEX_HARNESS_BRIDGE_M1_R6_3.zip
cd CODEX_HARNESS_BRIDGE_M1_R6_3

./scripts/install.sh \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /home/zyc14588
```

确认 Harness commit 和构建树未变化时可显式复用：

```bash
./scripts/install.sh \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /home/zyc14588 \
  --no-build-harness
```

安装器验证包 manifest、Harness provenance、极简 profile/preset、58 项单元测试、Markdown/DSML/原生工具调用全进程 E2E、stdio MCP、monitor、Codex 注册和事务回滚。

安装后完全重启 Codex，在目标 Git 仓库中输入：

```text
$codex-harness <开发任务>
```

详细协议见 `docs/`；最终验证状态见 `VALIDATION_REPORT_ZH.md`。
