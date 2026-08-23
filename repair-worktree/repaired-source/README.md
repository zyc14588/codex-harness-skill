# Codex ↔ DeepSeek Harness Bridge 0.6.5

```text
Version: 0.6.5
Release status: candidate
Install mode: audit-only
Controlled use allowed: false
Deliverable status: DELIVERABLE_PENDING
```

这是一个由 Codex 总控的本地 MCP Bridge。Codex 冻结计划、依赖、写租约、Token 门禁、审查与验证；DeepSeek Harness 或受控 llama.cpp 只执行有界叶子。Bridge 不自动 merge、push、tag 或创建 GitHub Release。

此前封印的 0.6.5 stable 归档完成了 2026-08-23 审计与真实 Provider 门禁；本工作树在封印后修复了 Dashboard 令牌循环、Bubblewrap 内 Node 包装器不可见、managed MCP 启动错误归因和 schema-v4 split-memory 污染。当前 candidate 已通过 87 项本地回归、direct/package/security/skill、固定真实 managed-Harness + 本地 Provider、0-I/O 失败注入，以及本修订真实 DeepSeek Flash/Pro 门禁。普通源码/provenance 与最终归档尚未封印，因此仍不得替换已安装 stable 或用于 controlled use。

## 本次修复

- Monitor 所有 API 使用私有 operator bearer；变更请求同时校验 Origin 与 CSRF。Provider/Harness 内部通信走受任务 token 保护的 Unix socket。
- Provider key 仅由本地 Broker 从 operator-owned、mode-0600 文件读取。Harness 只拿到一次性任务 token。
- 每次 Harness 尝试强制进入固定 SHA 的 Bubblewrap user/PID/network/mount 隔离；只允许写任务 worktree，只读挂载固定 Harness/Node/profile，拒绝仓库 `.env*`，不继承宿主凭据或代理变量。
- llama binary/working directory/参数与 SHA-256 固定；API key 环境变量固定为 `LLAMA_CPP_API_KEY`；子进程采用最小环境；Prompt 仅用 mode-0600 文件传输。
- Minimal Flash 整个 attempt 固定 `thinking.type=disabled` 并删除 `reasoning_effort`。Pro 整个 attempt 固定 enabled/high，始终省略 `tool_choice`，并完整校验和回放 Provider 原始 `reasoning_content`。
- `enabled-thinking Provider tool call omitted non-empty reasoning_content` 被确定性归类为 `provider_protocol`：立即中止 attempt、阻断后续 Provider I/O、验证进程身份后终止进程组，且不污染 split-memory。
- Provider 输入门禁覆盖 canonical 完整请求；DeepSeek V4 单请求固定 1M context/384K output 能力上限；malformed JSON 在本地 400，绝不触达 Provider。
- release gate 拒绝 withdrawn；candidate 必须显式 audit acknowledgement；stable 必须所有门禁精确 PASS 并绑定 lockfile、provenance 和证据哈希。
- Dashboard 认证取消或 `401` 后停止自动重弹并显示显式认证按钮；`403` 不再清除有效 Bearer。
- installer 使用 `process.execPath` 固定真实 Node；doctor 与 Bubblewrap 启动前拒绝与 Bridge runtime 不一致的 managed preset 命令。
- DSH managed MCP 同步失败归为 `minimal_tool_plane_composition`；split-memory schema 5 隔离可能受污染的 schema 4，`no_effect` 不再缩小任务建议。

## 当前门禁

| 门禁 | 当前结果 |
|---|---|
| strict build + unit/component | PASS，87 项 |
| direct process acceptance | PASS |
| 动态真实 Harness + 本地可观测 Provider | PASS，Flash 4 轮、Pro 3 轮 |
| reasoning replay 失败注入 | PASS，Provider 0、Token 0/0、split 不变 |
| Bubblewrap/read/network/PID/credential 隔离 | PASS |
| operator/llama/process/release 安全负向测试 | PASS |
| package acceptance | PASS |
| skill validation | PASS |
| 当前修订真实 Minimal Flash | PASS，4 轮、3 次原生工具调用 |
| 当前修订真实 Pro Thinking | PASS，4 轮、replay 0/1/2/3 |
| candidate 确定性 ZIP 与解压复验 | PENDING |

机器可读状态以 `release-status.json` 为准。只要其中不是 `stable`、`controlledUseAllowed=true`、`deliverableStatus=DELIVERABLE_PASS` 且所有 gate 精确为 `PASS`，就不得用于 controlled use。

## 历史 Stable 安装说明

以下命令属于此前封印归档；当前工作树是 audit-only candidate，未经重新封印不得按 stable 路径安装。

要求 Linux、Node `>=22.12.0`、Git、Python 3、Bubblewrap、Codex CLI，以及固定且干净的 DeepSeek Harness checkout：

```bash
sha256sum -c MANIFEST_SHA256.txt
scripts/install.sh \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /absolute/path/to/repositories \
  --provider-key-file /absolute/private/provider.key
```

`--provider-key-file` 必须是操作员拥有、非 symlink、group/other 无权限的普通文件。stable 安装永远不能使用 `--skip-self-tests` 跳过确定性自测。

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
- `CANDIDATE_VALIDATION_REPORT_ZH.md` 与 `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`：当前 runtime hotfix candidate 的本地、动态 Harness 与失败注入验证；
- `docs/18_RUNTIME_HOTFIX_R2_REAL_SMOKE_ZH.md` 与 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`：本修订有界真实 DeepSeek Flash/Pro 重资格证据；
- `SOURCE_PROVENANCE.json`：恢复提交、历史修复链与最终 seal 状态；
- `VALIDATION_REPORT_ZH.md`：当前验收报告；
- `docs/17_SECURITY_AUDIT_REPAIR_MATRIX_ZH.md`：F-001–F-015 修复矩阵；
- `evidence/01_DYNAMIC_PROFILE_FIXTURE_REDACTED.json`：此前 stable 的动态 Harness/本地 Provider 证据；
- `evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json`：此前 stable 的 replay 失败注入证据；
- `evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json`：此前 stable 封印的 package prerequisite 证据；最终解压安装验收另由历史 ZIP validation sidecar 绑定；
- `evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json` 与 `07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json`：此前 stable 的本地门禁证据；
- `evidence/02_REAL_DEEPSEEK_SMOKE_REDACTED.json`：withdrawn rc.1 历史失败；
- `evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json`：2026-08-23 此前 stable 修订的历史真实 Provider PASS；不作为本修订的重资格证据。
