# 0.6.5 安全修复候选验证报告

```text
DELIVERABLE_PASS: NO
Version: 0.6.5
Release status: candidate
Controlled use allowed: false
Local deterministic repair gates: PASS
Current real Minimal Flash smoke: BLOCKED_EXTERNAL_AUTHORIZATION_REQUIRED
Current real Pro Thinking smoke: BLOCKED_EXTERNAL_AUTHORIZATION_REQUIRED
Final stable ZIP: NOT_RUN
```

## 已完成的本地验证

| 项目 | 结果 | 证据 |
|---|---|---|
| strict TypeScript + component tests | PASS | 83 项 |
| direct process acceptance | PASS | 计划、工具、审查、验证、进程清理、provider-protocol fail-fast |
| dynamic Flash | PASS | 4 轮全部 disabled，无 reasoning effort |
| dynamic Pro | PASS | 3 轮全部 enabled/high、无 tool choice，replay 深度 0/1/2 |
| replay 失败注入 | PASS | `thinking_replay_state`，Provider 0，Token 0/0，split 不变 |
| security acceptance | PASS | operator auth、Broker、Bubblewrap、最小环境、进程身份、release gate |
| candidate package acceptance | PASS | fresh install、schema 4→7、双回滚、重装、卸载 |
| stdio MCP acceptance | PASS | 安装态协议交互 |
| skill validation | PASS | `Skill is valid!` |

动态门禁使用固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 和真实 managed profile/preset，只把外部 Provider 替换为本地可观测 Broker。因此它验证请求形状、隔离和失败闭锁，但不能替代真实 Provider。

## 尚未完成

当前修订新增了凭据 Broker、强制 Bubblewrap 隔离、进程身份、release gate 和审计修复。2026-08-22 的真实 Provider evidence 在这些变化之前产生，只保留为历史记录，不作为当前稳定门禁。必须重新运行：

- 真实 Minimal Flash 多轮工具 smoke；
- 真实 Pro Thinking 工具调用与 `reasoning_content` 完整回放 smoke；
- 两项通过后的 stable 元数据 seal；
- deterministic ZIP ×2、全新目录解压、manifest、stable gate 和 unpacked package acceptance。

真实烟测只使用合成临时仓库：`README.md` 内容为一个固定单行 seed；提示要求读取、复制、比较该文件，不发送当前源码或用户仓库内容。每个模型最多 8 次 API 调用、100,000 input Token、10,000 output Token，费用字段为每叶 CNY 5 参考告警。仍会产生实际外部 API 请求和费用，故需操作员明确授权。

## 判定

当前只能作为显式 `--audit-candidate` 的审计候选。不得声称 stable、`DELIVERABLE_PASS` 或 controlled use。最终权威状态始终取自 `release-status.json`，而不是历史文档或文件名中的 `STABLE` 字样。
