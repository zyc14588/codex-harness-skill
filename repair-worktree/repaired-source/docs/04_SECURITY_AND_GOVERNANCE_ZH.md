# 安全与治理

## 信任边界

```text
Operator
  └─ private bearer + Origin/CSRF ─→ Monitor control API
Monitor/Broker
  ├─ private Provider key
  └─ one-task token + Unix socket ─→ Bubblewrap relay
Bubblewrap Harness
  └─ isolated loopback relay only ─→ authenticated Broker ─→ Provider
```

匿名 Dashboard HTML 不包含 operator token。Provider key 不进入 Harness config、环境、argv、日志或 evidence；客户端 Authorization 在 Broker 边界被替换。

## 强制 Harness 隔离

每个 Harness attempt 必须经固定 SHA-256 的 Bubblewrap：

- 新 user、PID、network、mount namespace；
- `--die-with-parent`、new session、namespace 内禁用再嵌套 userns；
- 仅任务 worktree 可写；
- Harness、Node、Bridge dist、profile modules 只读；
- 不挂载宿主 home/DSH_HOME 或真实 Provider secret；
- namespace 内仅 relay 可达，宿主/外网不可达；
- namespace 中的 `/proc` 仅可见隔离进程；
- 启动前拒绝 worktree 内 `.env*`；
- Harness 环境从空对象构造，只注入任务 relay 所需值和安全 allowlist。

路径、profile modules、binary 和 socket 目录均经 lstat/realpath/ownership/mode/hash 检查；symlink fail-closed。

## 本地模型

managed server 和 CLI 只能使用 config 中固定的绝对 executable、working directory 与 SHA-256。拒绝 shell/通用解释器。子进程采用最小环境；Prompt 通过 mode-0600 文件传递；专用 API key 名固定为 `LLAMA_CPP_API_KEY`。

生命周期记录 Linux `/proc` start-time、PGID、executable realpath 与 SHA-256。任何身份不匹配都只清理 stale state，不发送信号。进程组 supervisor 在后代清理完成前保持 leader 身份，TERM 后仍存活的后代再经二次身份校验 KILL。

## Provider 协议

每个 attempt 的 Thinking Policy 在进程启动前冻结：

- Minimal Flash：全程 disabled，无 `reasoning_effort`；
- Pro：全程 enabled/high，无 `tool_choice`；
- Pro tool-call assistant 消息必须带 Provider 原始、非空 `reasoning_content`；
- 后续请求必须按 SHA-256/UTF-8 长度/tool-call ID 完整回放。

模式变更、缺失/空/篡改 replay 在 Provider I/O 前拒绝。Provider HTTP 错误只解析有界、脱敏分类信息。该异常属于 `provider_protocol`，会中止 attempt 并阻断后续 I/O。

## 请求与预算

输入估算覆盖 canonical 完整 Provider JSON，包括 messages、tools/schema、top-level 字段和 framing 保守上界。DeepSeek V4 registry 固定单请求 context 1,000,000 Token、output 384,000 Token。累计 input/output Token 仍是唯一模型用量硬门禁；金额和调用次数只告警。malformed JSON 返回本地 400，Provider 计数保持 0。

辅助请求由 nonce-bound 本地 request-state claim 认证，不再根据模型可见 prompt 前缀推断。claim 绑定 task、attempt、request ordinal、请求摘要与用途，且一次性消费。

## Release governance

稳定安装必须满足机器 release gate，不信任文档中的 PASS 字样。CI 在干净 checkout 执行 lockfile 安装、构建、测试、direct acceptance、动态 fixture、secret/.env 扫描与生成产物漂移检查。发布包包含 `package-lock.json`，不包含 `node_modules`、symlink、gitlink、secret 或临时 smoke 目录。

任何 automatic merge/push/tag/GitHub Release 均禁止。
