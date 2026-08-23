# 0.6.5 原 stable 封印验证报告（历史证据）

> 当前工作树已产生封印后的 runtime hotfix，机器可读状态为 candidate。下列结果只绑定此前 stable 归档，不构成当前 candidate 的重资格证据；当前 candidate 的独立本地/动态验证见 `CANDIDATE_VALIDATION_REPORT_ZH.md` 与 `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`。

```text
DELIVERABLE_PASS: YES
Version: 0.6.5
Release status: stable
Controlled use allowed: true
Local deterministic repair gates: PASS
Current real Minimal Flash smoke: PASS
Current real Pro Thinking smoke: PASS
Final stable ZIP: PASS
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
| package acceptance | PASS | fresh install、schema 4→7、双回滚、重装、卸载；最终 ZIP 解压后再次 PASS |
| stdio MCP acceptance | PASS | 安装态协议交互 |
| skill validation | PASS | `Skill is valid!` |

动态门禁使用固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 和真实 managed profile/preset，只把外部 Provider 替换为本地可观测 Broker。因此它验证请求形状、隔离和失败闭锁，但不能替代真实 Provider。

## 当前真实 Provider 结论

操作员已明确授权真实 DeepSeek 外部传输与 API 费用。当前修订在固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 上通过：

- Minimal Flash 共 4 次 Provider 请求，attempt 全程 `thinking=disabled` 且无 `reasoning_effort`，完成读取、写入、验证工具链；
- Pro Thinking 共 4 次 Provider 请求，attempt 全程 `thinking=enabled`、`reasoning_effort=high` 且 `tool_choice` 缺失；后三次请求分别完整回放前 1/2/3 个 Provider reasoning 载荷；
- 三个非空 reasoning 载荷均以 Provider 派生 SHA-256 与 UTF-8 长度校验，证据不保存推理正文；
- 两个任务的 reviewed/current/verified 指纹一致，隔离 worktree 与分支已清理，smoke 主仓库 HEAD 不变且未 push。

## 最终归档

`CODEX_HARNESS_BRIDGE_0_6_5_STABLE.zip` 已执行 deterministic ZIP ×2 并逐字节一致；全新目录解压后的 manifest、stable release gate、无 symlink/`node_modules` 卫生和 transactional package acceptance 均 PASS。归档 SHA-256 以同目录 `.sha256` 和 `.validation.json` sidecar 为准。

## 判定

当前结果为 `stable`、`controlledUseAllowed=true`、`DELIVERABLE_PASS`，所有机器 gate 精确为 `PASS`。没有执行 merge、push、tag 或 GitHub Release；最终权威状态取自 `release-status.json`，归档完整性取自 manifest 与 sidecar。
