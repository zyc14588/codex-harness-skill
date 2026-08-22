# Codex ↔ DeepSeek Harness Bridge M1-R6.4

版本：`0.6.4`。

本地 MCP Bridge 让 Codex 直接规划、委派、监控、审查并验证 DeepSeek Harness 与 llama.cpp 叶子任务。R6.4 保留并行极简 Harness、渐进式工具披露、自适应拆分记忆、人民币监控和 llama.cpp 路由，并修复 R6.3 在真实 Harness 中将**无工具的会话标题辅助请求误判为首次施工请求**的问题。

## R6.4 发布阻断修复

真实机器验收显示，R6.3 在真正的 minimal Agent 请求到达 Provider 前失败：Harness 的 first-prompt session-title 插件会把完整任务重新封装为一个 `max_tokens=64`、无 `tools` 的辅助模型请求。该请求包含原始任务文本，但 DeepSeek HTTP wire 不携带内部 `purpose=session-title`，R6.3 因此看到 bounded-leaf 标记后错误执行 mutation preflight，并以 `minimal_tool_plane` 拒绝。

R6.4 使用两层修复：

1. **Headless profile 禁用 LLM 标题生成**：Bridge 管理的 `codex-minimal-headless` profile 显式禁用 `session-title-llm`。一次性受控施工不需要会话标题，移除该调用也减少无价值 Token。
2. **代理层辅助请求隔离**：即使外部 profile 或未来组合仍产生标题请求，代理会按 Harness 固定系统提示、无工具目录和小输出上限识别 `session_title_auxiliary`，只记录隔离遥测，不检查 worktree、不设置 `tool_choice`、也不写入基础设施失败。
3. **真正施工请求仍严格强制**：随后携带 `bash`/`pwsh`/`str_replace_editor` 的主 Agent 请求在无 diff 时进入 `tool_choice=required`、临时关闭 thinking，并记录 `minimalMutationForceCount`。若主请求确实缺少核心工具，仍以 `minimal_tool_plane` 失败关闭。
4. **可审计证据**：任务状态和 Dashboard 新增 `minimalMutationAuxiliaryBypassCount`、类型及最近时间；强制请求、Provider 原生工具调用和文本恢复仍分别记录。
5. **空 diff 与拆分记忆规则保持不变**：有写租约的施工叶子无 diff 时失败；`tool_protocol`、`minimal_tool_plane`、`provider_transport`、`no_effect` 只计基础设施故障，不改变任务规模、复杂度或 Token 建议。

R6.0、R6.1、R6.2、R6.3 均不得继续用于 minimal Harness 施工。强制策略或模型摘要不是成功证据；最终仍只接受租约内 Git diff、逐文件审查、冻结验证和一致 fingerprint。

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
unzip CODEX_HARNESS_BRIDGE_M1_R6_4.zip
cd CODEX_HARNESS_BRIDGE_M1_R6_4

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

安装器验证包 manifest、Harness provenance、极简 profile/preset、60 项单元测试、Markdown/DSML/原生工具调用全进程 E2E、stdio MCP、monitor、Codex 注册和事务回滚。

安装后完全重启 Codex，在目标 Git 仓库中输入：

```text
$codex-harness <开发任务>
```

详细协议见 `docs/`；最终验证状态见 `VALIDATION_REPORT_ZH.md`。
