# 0.6.5 安全修复最终封印验证报告

```text
DELIVERABLE_PASS: NO
Version: 0.6.5
Release status: candidate
Controlled use allowed: false
Local deterministic repair gates: PASS
Current real Minimal Flash smoke: PASS
Current real Pro Thinking smoke: PASS
Final stable ZIP: NOT_RUN
```

## 已完成的本地验证

| 项目 | 结果 | 证据 |
|---|---|---|
| strict TypeScript + component tests | PASS | 83 项 |
| direct process acceptance | PASS | 计划、工具、审查、验证、进程清理、provider-protocol fail-fast |
| dynamic Flash | PASS | 4 轮全部 disabled，无 reasoning effort |
| dynamic Pro | PASS | 3 轮全部 enabled/high、无 tool choice，replay 深度 0/1/2 |
| real Minimal Flash | PASS | 4 轮全部 disabled，3 次原生工具调用，0 次协议恢复 |
| real Pro Thinking | PASS | 4 轮全部 enabled/high、无 tool choice，replay 深度 0/1/2/3；Provider 推理只以 SHA-256/字节长度留证 |
| replay 失败注入 | PASS | `thinking_replay_state`，Provider 0，Token 0/0，split 不变 |
| security acceptance | PASS | operator auth、Broker、Bubblewrap、最小环境、进程身份、release gate |
| candidate package acceptance | PASS | fresh install、schema 4→7、双回滚、重装、卸载 |
| stdio MCP acceptance | PASS | 安装态协议交互 |
| skill validation | PASS | `Skill is valid!` |

动态门禁使用固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 和真实 managed profile/preset，只把外部 Provider 替换为本地可观测 Broker。因此它验证请求形状、隔离和失败闭锁，但不能替代真实 Provider。

## 当前真实 Provider 结论

操作员已明确授权真实 DeepSeek 外部传输与 API 费用。当前修订在固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 上通过：

- Minimal Flash 共 4 次 Provider 请求，attempt 全程 `thinking=disabled` 且无 `reasoning_effort`，完成读取、写入、验证工具链；
- Pro Thinking 共 4 次 Provider 请求，attempt 全程 `thinking=enabled`、`reasoning_effort=high` 且 `tool_choice` 缺失；后三次请求分别完整回放前 1/2/3 个 Provider reasoning 载荷；
- 三个非空 reasoning 载荷均以 Provider 派生 SHA-256 与 UTF-8 长度校验，证据不保存推理正文；
- 两个任务的 reviewed/current/verified 指纹一致，隔离 worktree 与分支已清理，smoke 主仓库 HEAD 不变且未 push。

## 尚未完成

当前只剩 stable 元数据绑定，以及 deterministic ZIP ×2、全新目录解压、manifest、stable release gate 和 unpacked package acceptance。完成前不声明 `DELIVERABLE_PASS`。

## 判定

当前仍只能作为显式 `--audit-candidate` 的审计候选。最终 ZIP 复验通过前不得声称 stable、`DELIVERABLE_PASS` 或 controlled use。最终权威状态始终取自 `release-status.json`。
