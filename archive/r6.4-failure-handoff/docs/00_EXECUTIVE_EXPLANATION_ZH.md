# 给项目所有者的说明

## 1. 目前什么是好的

R6.4 并非全部失效。下列能力已经在真实失败中得到证明：

- Bridge 和 Harness provenance 检查能够完成；
- Git worktree、写租约和主工作树隔离有效；
- 空 diff 不会被当作完成；
- 失败时不会进入 repair、review、verification 或 commit；
- worktree 能清理，分支和证据可保留；
- `minimal_tool_plane` 被当作基础设施故障；
- split-memory 不会因为该故障缩小或扩大后续叶子。

这些控制机制不应推倒重写。

## 2. 当前真正阻塞在哪里

失败发生在 Provider 消耗 Token 之前：

```text
Harness 准备请求
→ Bridge proxy 检查请求工具
→ 找不到 bash/pwsh/str_replace_editor
→ minimal_tool_plane
→ 请求没有发给 DeepSeek
```

因此，当前问题不是 DeepSeek 是否服从 `tool_choice=required`，也不是响应恢复器是否能解析 Markdown。Bridge 还没有进入发送强制请求的阶段。

## 3. 为什么 0 Token 很重要

`inputTokens=0`、`outputTokens=0` 表明失败位于本地请求前置检查。这排除了以下根因作为本轮第一根因：

- Provider 只返回普通文本；
- DSML/Markdown 恢复器覆盖不足；
- Provider structured tool call 格式异常；
- Tool call 执行后没有产生副作用。

这些仍可能是后续风险，但必须先让正式 mutation 请求携带可用工具并真正发送出去。

## 4. 为什么 doctor PASS 仍然不够

当前 doctor 主要证明文件、固定 commit、构建树、profile/preset 存在和静态配置。它没有证明：

- 真正创建的 Agent 使用了目标 preset；
- request assembly 中包含 core mutation tools；
- DeepSeek serializer 最终收到非空 `GenerateOptions.tools`；
- Proxy 收到的 `requestBody.tools` 与 Agent 可见工具一致；
- 第一条正式 mutation 请求能到达 Provider。

所以 `bridge_doctor=PASS` 与运行时失败并不矛盾。下一版 doctor 必须加入动态 request-path preflight。

## 5. 下一步应如何修

优先顺序必须是：

1. 回收真实安装的 0.6.4 runtime/profile/preset；
2. 给每个代理请求增加脱敏后的用途与工具目录证据；
3. 区分“Agent 可见工具”“assembled tool schemas”“wire request tools”三个层次；
4. 找到工具在哪一层丢失；
5. 只在已证明是正式 mutation 请求时应用 `tool_choice=required`；
6. 让真实 Harness 产生一个精确租约文件；
7. 再运行 review、verification、fingerprint 和 commit；
8. 最后才重新发布。

## 6. 版本管理建议

不要继续把修复包直接标记为稳定 R6.x PASS。建议下一候选版本先使用：

```text
0.6.5-rc.1
```

只有真实机器 smoke test 全链通过后，才发布 `0.6.5`。
