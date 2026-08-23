# 0.6.5 runtime hotfix candidate 验证报告

> 这是外部 Provider 重资格前的阶段性报告，原始结论保留不回写。随后本修订真实 DeepSeek Flash/Pro 已通过，见 `docs/18_RUNTIME_HOTFIX_R2_REAL_SMOKE_ZH.md` 与 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`；最终资格仍以 `release-status.json` 为准。

验证时间：2026-08-23 17:48 AEST（UTC+10）
修订：`known-runtime-errors-r2-candidate`
结论：`LOCAL_AND_DYNAMIC_PASS / EXTERNAL_RELEASE_GATES_PENDING`

## 验证结果

| 门禁 | 结果 |
|---|---|
| npm dependency audit | PASS，0 vulnerabilities |
| TypeScript strict build | PASS |
| unit/component | PASS，87/87 |
| direct process acceptance | PASS |
| security acceptance | PASS |
| skill validation | PASS |
| candidate/stable/withdrawn release-gate tests | PASS |
| package acceptance | PASS |
| 固定真实 managed Harness + 本地可观测 Provider | PASS |
| reasoning replay 失败注入 | PASS，Provider 0、Token 0/0、split 不变 |

## 动态 Harness 证据

- Harness commit：`141eb6fef83422698aef7a981029e843e8161534`，tracked clean；build SHA-256：`6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38`。
- managed composition：stock runner disabled、Bridge runner mounted、session title disabled、minimal preset selected、无 patch warning。
- Minimal Flash：4 个本地 Provider 请求，全部 `thinking=disabled` 且无 `reasoning_effort`；2 次 mutation force，3 次原生工具调用。
- Pro：3 个本地 Provider 请求，全部 `thinking=enabled/high` 且无 `tool_choice`；reasoning replay 深度为 `0/1/2`，2 次原生工具调用。
- replay 缺失注入：在 Provider I/O 前以 `thinking_replay_state` 失败；Provider 调用 0、Token 0/0、split sample 0、leaf scale 1。

## 已知错误重资格

- Dashboard 取消认证或收到 `401` 后不再周期性弹窗；显式按钮恢复认证，`403` 不清除有效 Bearer。
- installer、package acceptance 与 doctor 均确认 managed preset 使用 Bridge 的真实 `process.execPath`，不再使用 Bubblewrap 内不可见的 shell wrapper。
- 通用 DSH managed MCP 初始化/工具同步错误归为 `minimal_tool_plane_composition`。
- split-memory schema 5 隔离 schema 4 启动故障污染，基础设施事件和 `no_effect` 不缩小建议。

## 尚未取得的发布资格

本轮没有调用真实 DeepSeek Provider、没有使用操作员凭据、没有外部网络传输，也没有构建最终确定性 ZIP。真实 Minimal Flash、真实 Pro Thinking、ordinary source/provenance 与最终 ZIP 解压复验仍为 `PENDING`。因此版本继续保持 `candidate`、`controlledUseAllowed=false`、`DELIVERABLE_PENDING`，不得替换现有 stable 或用于 controlled use。

脱敏机器证据：`evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`。
