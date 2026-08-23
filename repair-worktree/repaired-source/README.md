# Codex ↔ DeepSeek Harness Bridge 0.6.5

```text
Version: 0.6.5
Release status: candidate
Install mode: explicit audit only
Controlled use allowed: false
Deliverable status: REPAIR_AWAITING_EXTERNAL_PROVIDER_AUTHORIZATION
```

这是一个由 Codex 总控的本地 MCP Bridge。Codex 冻结计划、依赖、写租约、Token 门禁、审查与验证；DeepSeek Harness 或受控 llama.cpp 只执行有界叶子。Bridge 不自动 merge、push、tag 或创建 GitHub Release。

当前源码已完成 2026-08-23 审计中 F-001–F-015 的本地修复与确定性验证，但还不是稳定版。当前修订必须重新执行真实 DeepSeek Minimal Flash 与 Pro Thinking smoke；该步骤会向外部 DeepSeek API 发送一个仅含单行 README 的合成临时仓库任务并产生费用，因此在操作员明确授权前保持阻塞。2026-08-22 的真实 smoke 只作为历史证据，不充当当前门禁。

## 本次修复

- Monitor 所有 API 使用私有 operator bearer；变更请求同时校验 Origin 与 CSRF。Provider/Harness 内部通信走受任务 token 保护的 Unix socket。
- Provider key 仅由本地 Broker 从 operator-owned、mode-0600 文件读取。Harness 只拿到一次性任务 token。
- 每次 Harness 尝试强制进入固定 SHA 的 Bubblewrap user/PID/network/mount 隔离；只允许写任务 worktree，只读挂载固定 Harness/Node/profile，拒绝仓库 `.env*`，不继承宿主凭据或代理变量。
- llama binary/working directory/参数与 SHA-256 固定；API key 环境变量固定为 `LLAMA_CPP_API_KEY`；子进程采用最小环境；Prompt 仅用 mode-0600 文件传输。
- Minimal Flash 整个 attempt 固定 `thinking.type=disabled` 并删除 `reasoning_effort`。Pro 整个 attempt 固定 enabled/high，始终省略 `tool_choice`，并完整校验和回放 Provider 原始 `reasoning_content`。
- `enabled-thinking Provider tool call omitted non-empty reasoning_content` 被确定性归类为 `provider_protocol`：立即中止 attempt、阻断后续 Provider I/O、验证进程身份后终止进程组，且不污染 split-memory。
- Provider 输入门禁覆盖 canonical 完整请求；DeepSeek V4 单请求固定 1M context/384K output 能力上限；malformed JSON 在本地 400，绝不触达 Provider。
- release gate 拒绝 withdrawn；candidate 必须显式 audit acknowledgement；stable 必须所有门禁精确 PASS 并绑定 lockfile、provenance 和证据哈希。

## 当前门禁

| 门禁 | 当前结果 |
|---|---|
| strict build + unit/component | PASS，83 项 |
| direct process acceptance | PASS |
| 动态真实 Harness + 本地可观测 Provider | PASS，Flash 4 轮、Pro 3 轮 |
| reasoning replay 失败注入 | PASS，Provider 0、Token 0/0、split 不变 |
| Bubblewrap/read/network/PID/credential 隔离 | PASS |
| operator/llama/process/release 安全负向测试 | PASS |
| candidate package acceptance | PASS，含 schema 4→7、双回滚与卸载 |
| skill validation | PASS |
| 当前修订真实 Minimal Flash | BLOCKED_EXTERNAL_AUTHORIZATION_REQUIRED |
| 当前修订真实 Pro Thinking | BLOCKED_EXTERNAL_AUTHORIZATION_REQUIRED |
| stable 确定性 ZIP 与解压复验 | 等真实门禁通过后执行 |

机器可读状态以 `release-status.json` 为准。只要其中不是 `stable`、`controlledUseAllowed=true`、`deliverableStatus=DELIVERABLE_PASS` 且所有 gate 精确为 `PASS`，就不得用于 controlled use。

## Candidate 审计安装

要求 Linux、Node `>=22.12.0`、Git、Python 3、Bubblewrap、Codex CLI，以及固定且干净的 DeepSeek Harness checkout。候选包只能显式审计安装：

```bash
sha256sum -c MANIFEST_SHA256.txt
scripts/install.sh \
  --audit-candidate \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /absolute/path/to/repositories \
  --provider-key-file /absolute/private/provider.key
```

`--provider-key-file` 必须是操作员拥有、非 symlink、group/other 无权限的普通文件。candidate 可显式使用 `--skip-self-tests` 加速重复审计；stable 安装永远不能跳过自测。

## 受控工作流

```text
controller_split_advice
→ controller_plan_create
→ controller_launch_leaf
→ harness_status / harness_collect
→ harness_read_changed_file（每个 changed path）
→ controller_review_task
→ harness_verify
→ reviewed/current/verified fingerprint 一致
→ harness_commit（仅隔离本地分支）
→ controller_finalize_plan
→ harness_cleanup
```

累计 input/output Token 是唯一模型用量硬门禁；API 调用次数和金额仅作参考告警。runtime、scope、Git、安全、来源和输出形状仍是独立硬门禁。

## 证据入口

- `release-status.json`：当前机器状态；
- `SOURCE_PROVENANCE.json`：恢复提交、历史修复链与最终 seal 状态；
- `VALIDATION_REPORT_ZH.md`：当前验收报告；
- `docs/17_SECURITY_AUDIT_REPAIR_MATRIX_ZH.md`：F-001–F-015 修复矩阵；
- `evidence/01_DYNAMIC_PROFILE_FIXTURE_REDACTED.json`：当前动态 Harness/本地 Provider 证据；
- `evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json`：当前 replay 失败注入证据；
- `evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json`：当前 candidate package 证据；
- `evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json` 与 `07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json`：当前本地门禁；
- `evidence/02_REAL_DEEPSEEK_SMOKE_REDACTED.json`：withdrawn rc.1 历史失败；
- `evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json`：2026-08-22 历史 PASS，明确不计入当前修订门禁。
