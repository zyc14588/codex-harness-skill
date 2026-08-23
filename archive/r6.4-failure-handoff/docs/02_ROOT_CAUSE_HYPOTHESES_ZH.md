# 根因假设与验证顺序

下列内容是需要 Codex 用精确 0.6.4 runtime 和真实证据验证的假设，不应被当作已证实事实。

## H1：R6.4 修复没有真正进入 installed runtime

**迹象**：实际行为与 0.6.3 preliminary policy 完全一致；auxiliary bypass 遥测为 0。

**验证**：

```bash
rg -n 'auxiliary|session-title-llm|minimalMutationForceCount|minimal mutating leaf' \
  /home/zyc14588/.local/share/codex-harness-bridge/0.6.4
```

对比 source map、dist JS、profile/preset marker version 和文件 hash。

## H2：Managed profile/preset 在升级时仍是旧内容

**迹象**：runtime 版本显示 0.6.4，但实际 profile 可能未包含标题禁用或新 runner。

**验证**：

- 检查 `.codex-harness-bridge-managed.json`；
- 检查 `cordis.patch.yml`；
- 检查 `bridge-headless-runner.mjs`；
- 使用 Harness dump-config 查看有效组合；
- 对比安装包模板与已安装文件 hash。

## H3：正式 mutation 请求本身没有工具

**迹象**：即使辅助请求完全禁用，真正的 mutation request 也可能在 adapter 组装前丢失 preset scope。

**验证**：在四个边界记录工具名称：

```text
runner scoped tools
assembled request tools
DeepSeek serializer input tools
proxy wire tools
```

如果 runner 有工具而 wire 无工具，问题在 request assembly/adapter；如果 runner 本身无工具，问题在 preset/profile composition。

## H4：Proxy 的工具解析器与真实 request schema 不匹配

**迹象**：`allowedToolNamesFromRequest()`只识别 `tools[].function.name`。真实代理请求若采用 Responses API、其他兼容层或不同字段结构，会被解析为空。

**验证**：保存脱敏的 request shape：

```text
endpoint
content-type
顶层字段名
tools 数量
每项 type/name 的字段路径
model
max_tokens
message roles
```

禁止保存消息正文、密钥或 Authorization。

## H5：辅助请求分类顺序错误

**迹象**：R6.4 声称加入辅助隔离，但 preliminary policy 仍先执行。

**验证**：检查代码控制流，确保：

```text
classify request purpose
→ auxiliary: bypass and record
→ mutation: inspect tool plane and apply policy
```

而不是：

```text
apply policy
→ failure
→ classify auxiliary（永远到不了）
```

## H6：会话标题请求仍然存在

**迹象**：此前 Harness 基础组合包含 LLM title generator；R6.4 声称关闭，但没有 bypass telemetry。

**验证**：

- 有效配置中 `session-title-llm` 是否 disabled；
- 是否还有其他 auxiliary LLM provider；
- 第一个请求的 max token、消息形态和 purpose；
- runner 在 followup 前后各有多少 Provider 请求。

## 推荐验证顺序

```text
H1 → H2 → H4 → H3 → H5 → H6
```

原因：先证明运行的究竟是什么代码，再分析请求结构和工具丢失位置，避免在错误源码上修补。
