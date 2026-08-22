# R6.4 技术审计

## 1. 审计范围

本审计基于：

- 用户提供的 R6.0–R6.4 真实验收结果；
- 本包内完整 `0.6.3` 源码基线；
- 用户机器已安装 `0.6.4` 的终态遥测；
- DeepSeek Harness 固定 commit `47f943859bef60e4160492346772ded9b24f765a` 的官方实现约束。

精确 `0.6.4` 源码不在当前会话环境内，因此涉及 R6.4 具体实现行号的结论必须由 Codex读取本机 installed runtime 后确认。

## 2. 高置信度事实

### F-001：失败发生在 Provider 前

证据：

```text
input/output Token = 0/0
minimalMutationForceCount = 0
infrastructureFailureKind = minimal_tool_plane
```

结论：Proxy 没有生成并发送已应用的强制 mutation 请求。

### F-002：策略失败原因是请求目录中没有核心工具

错误为：

```text
minimal mutating leaf has no disclosed core mutation tool
```

在 0.6.3 基线中，`applyMinimalMutationPolicy()` 只从 OpenAI-compatible `requestBody.tools[*].function.name` 读取工具，并只接受：

```text
bash
pwsh
str_replace_editor
```

如果当前请求被识别为有界 mutation leaf、worktree 无 diff，但上述工具一个也没有，就返回 `reason`，Monitor 随即写入 `minimal_tool_plane` 并返回 502。

### F-003：0.6.3 基线的 preliminary policy 顺序可直接产生相同遥测

基线 Monitor 先使用空 changed-path 列表调用 policy：

```text
preliminaryPolicy = applyMinimalMutationPolicy(latest, parsed, [], model)
```

只要该调用返回 `reason`，后续就会进入 worktree 检查并再次失败。此时：

- force counter 尚未递增；
- Provider 尚未收到请求；
- Token 为 0；
- 任务被归为 `minimal_tool_plane`。

这与 R6.4 的真实遥测完全同形。由此可推断至少有一种情况成立：

1. R6.4 installed runtime 仍保留了这一执行顺序；
2. R6.4 的辅助分类位于 preliminary policy 之后；
3. 本机实际运行的是混合/陈旧 runtime；
4. 正式 mutation 请求本身就没有工具，因此分类也无法解决。

### F-004：静态工具可见性与 wire 工具目录不是同一个事实

Bridge 管理的 headless runner 可以通过 `ctx.tools.schemas(agent)`看到 Agent 作用域工具；DeepSeek adapter 则只有在 `GenerateOptions.tools` 非空时才把工具序列化进 wire request。

因此必须分别记录：

```text
A. Agent scoped visible tools
B. system-prompt/request assembly tools
C. DeepSeek wire request tools
D. Monitor proxy parsed tools
```

目前只看到 D 为空，无法证明工具在哪一层丢失。

## 3. P0 缺陷

### P0-1：请求用途没有形成可靠、可审计的权威标记

R6.4 期望隔离 auxiliary request，但最终遥测：

```text
auxiliaryBypassCount = 0
minimalMutationForceCount = 0
```

这说明辅助分类没有提供有效证据。可能是：

- 该代码未安装；
- profile/preset 是旧版；
- 分类条件与真实请求不匹配；
- 分类发生在 policy 失败之后；
- 真实失败请求不是辅助请求，而是正式 mutation 请求缺工具。

在没有原始请求结构证据前，不应继续用更多 prompt 文本启发式判断用途。

### P0-2：Doctor 没有覆盖实际模型请求工具平面

Doctor PASS 却无法保证第一次正式请求包含 mutation tools。下一版必须增加动态 preflight：

```text
创建 Bridge minimal Agent
→ 记录 scoped tools
→ 触发受控 mock mutation step
→ 捕获 adapter/wire tools
→ 确认 proxy 可解析 core tool
```

### P0-3：发布验收允许 deterministic fixture 替代真实协议路径

过去多个版本在 fixture 中 PASS，但真实 Provider/Harness 连续失败。根因是 fixture 输出形态由实现者控制，没有覆盖真实 Harness 组装、DeepSeek adapter、proxy 和 Provider 的组合行为。

下一版 release gate 必须区分：

```text
deterministic package acceptance
real-machine provider acceptance
```

前者不能授予 stable release 状态。

## 4. P1 缺陷

### P1-1：精确源码与 installed runtime provenance 不完整

当前会话只保留了 0.6.3 完整源码，而用户运行的是 0.6.4。必须回收并散列：

- installed runtime；
- managed profile；
- managed preset；
- renderer marker；
- Codex MCP 注册路径；
- monitor PID 指向的实际模块路径。

### P1-2：Profile migration 的语义验收不足

安装器能够覆盖 Bridge-managed profile/preset，但需要证明：

- marker version 已更新；
- `session-title-llm` 的目标状态确实出现在有效组合中；
- headless runner 使用的 preset ID 正确；
- preset 的 native presentation 和 core tools 实际挂载；
- `dsh --profile ... --dump-config` 与运行时一致。

仅检查目录存在和 managed marker 不足。

### P1-3：Impossible state 缺少 invariant

R6.4 验收明确禁止：

```text
minimalMutationForceCount = 0
同时 infrastructureFailureKind = minimal_tool_plane
```

但真实运行仍出现该状态。下一版应定义更精确状态：

```text
minimal_tool_plane_preflight
minimal_tool_serialization_mismatch
minimal_mutation_policy_applied
```

并对不可能组合在单测和运行时 invariant 中直接失败。

## 5. 正确能力

以下能力通过真实失败得到验证，必须原样保留：

- Token input/output 是唯一硬用量门禁；
- API 次数与费用只产生参考告警；
- 基础设施故障不写入有效 split-memory 样本；
- 无 diff 不能进入 review/verification/commit；
- Git 主工作树、worktree、分支和清理门禁有效；
- worker summary 不能覆盖 Git diff 事实。
