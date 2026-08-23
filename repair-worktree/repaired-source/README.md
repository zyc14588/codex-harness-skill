# Codex ↔ DeepSeek Harness Bridge 0.6.5

```text
Version: 0.6.5
Release status: stable
Install mode: controlled
Controlled use allowed: true
Deliverable status: DELIVERABLE_PASS
```

这是一个由 Codex 总控的本地 MCP Bridge。Codex 冻结计划、依赖、写租约、Token 门禁、审查与验证；DeepSeek Harness 或受控 llama.cpp 只执行有界叶子。Bridge 不自动 merge、push、tag 或创建 GitHub Release。

Runtime hotfix R4 在 R3 Dashboard 修复之上，按操作员要求把新密码下限调整为至少 6 个 Unicode 字符，同时保持无空白、16384 UTF-8 字节上限、Bearer/Origin/CSRF、原子 mode-0600 持久化和并发闭锁。Provider API key 仍要求至少 24 字节。R4 已通过 90 项回归、strict/direct/package/security/skill、桌面与移动浏览器验证、普通源码/provenance、确定性双构建与全新目录解包验收。Provider/Harness 请求执行路径未修改，因此 R2 的有界真实 DeepSeek 证据仅作为继承回归证据保留。旧归档均保留为历史，R4 使用独立名称。

## 本次修复

- Monitor 所有 API 使用私有 operator bearer；变更请求同时校验 Origin 与 CSRF。Provider/Harness 内部通信走受任务 token 保护的 Unix socket。
- Provider key 仅由本地 Broker 从 operator-owned、mode-0600 文件读取。Harness 只拿到一次性任务 token。
- 每次 Harness 尝试强制进入固定 SHA 的 Bubblewrap user/PID/network/mount 隔离；只允许写任务 worktree，只读挂载固定 Harness/Node/profile，拒绝仓库 `.env*`，不继承宿主凭据或代理变量。
- llama binary/working directory/参数与 SHA-256 固定；API key 环境变量固定为 `LLAMA_CPP_API_KEY`；子进程采用最小环境；Prompt 仅用 mode-0600 文件传输。
- Minimal Flash 整个 attempt 固定 `thinking.type=disabled` 并删除 `reasoning_effort`。Pro 整个 attempt 固定 enabled/high，始终省略 `tool_choice`，并完整校验和回放 Provider 原始 `reasoning_content`。
- `enabled-thinking Provider tool call omitted non-empty reasoning_content` 被确定性归类为 `provider_protocol`：立即中止 attempt、阻断后续 Provider I/O、验证进程身份后终止进程组，且不污染 split-memory。
- Provider 输入门禁覆盖 canonical 完整请求；DeepSeek V4 单请求固定 1M context/384K output 能力上限；malformed JSON 在本地 400，绝不触达 Provider。
- release gate 拒绝 withdrawn；candidate 必须显式 audit acknowledgement；stable 必须所有门禁精确 PASS 并绑定 lockfile、provenance 和证据哈希。
- Dashboard 使用内嵌“操作员认证”表单，不再调用原生 `prompt`；未认证费用页明确说明预算字段需要登录，认证后显示全局预算和任务预算/空状态。
- “设置 → 操作员认证”支持至少 6 个 Unicode 字符的 operator password；5 字符拒绝，6 位数字和 6 个中文字符接受。旧密码立即失效，新密码不回显，文件保持 mode-0600，并发陈旧请求 fail closed。
- operator password 的放宽不影响 Provider API key；运行时仍对 Provider key 执行至少 24 字节校验。
- installer 使用 `process.execPath` 固定真实 Node；doctor 与 Bubblewrap 启动前拒绝与 Bridge runtime 不一致的 managed preset 命令。
- DSH managed MCP 同步失败归为 `minimal_tool_plane_composition`；split-memory schema 5 隔离可能受污染的 schema 4，`no_effect` 不再缩小任务建议。

## 当前门禁

| 门禁 | 当前结果 |
|---|---|
| strict build + unit/component | PASS，90 项 |
| Dashboard desktop/mobile browser QA | PASS，无原生 dialog、无控制台错误、无移动横向溢出 |
| operator credential rotation | PASS，5 字符拒绝、6 字符接受、旧密码失效、新密码生效 |
| direct process acceptance | PASS |
| 动态真实 Harness + 本地可观测 Provider | PASS，Flash 4 轮、Pro 3 轮 |
| reasoning replay 失败注入 | PASS，Provider 0、Token 0/0、split 不变 |
| Bubblewrap/read/network/PID/credential 隔离 | PASS |
| operator/llama/process/release 安全负向测试 | PASS |
| package acceptance | PASS |
| skill validation | PASS |
| 继承的 R2 真实 Minimal Flash | PASS，4 轮、3 次原生工具调用；R4 请求路径未变 |
| 继承的 R2 真实 Pro Thinking | PASS，4 轮、replay 0/1/2/3；R4 未重跑 |
| stable 确定性 ZIP 与解压复验 | PASS，双构建字节一致 |

机器可读状态以 `release-status.json` 为准；当前所有 gate 精确为 `PASS`。任何后续修改都会使 manifest、artifact bindings 与外部 sidecar 失效，必须重新封印。

## Stable 安装说明

只从 `CODEX_HARNESS_BRIDGE_0_6_5_HOTFIX_R4_STABLE.zip` 解包目录安装，并先校验同目录 SHA-256 sidecar 与包内 manifest。

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
- `docs/20_OPERATOR_PASSWORD_MINIMUM_R4_ZH.md` 与 `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`：R4 的 6 字符密码边界、本地浏览器、安全与包装资格；
- `docs/19_DASHBOARD_AUTH_BUDGET_UX_HOTFIX_ZH.md`：R3 Dashboard 认证和预算 UI 的历史修复记录；
- `docs/18_RUNTIME_HOTFIX_R2_REAL_SMOKE_ZH.md` 与 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`：Provider/Harness 路径未修改时继承的 R2 有界真实 DeepSeek 回归证据；
- `SOURCE_PROVENANCE.json`：恢复提交、历史修复链与最终 seal 状态；
- `VALIDATION_REPORT_ZH.md`：当前验收报告；
- `docs/17_SECURITY_AUDIT_REPAIR_MATRIX_ZH.md`：F-001–F-015 修复矩阵；
- `evidence/01_DYNAMIC_PROFILE_FIXTURE_REDACTED.json`：此前 stable 的动态 Harness/本地 Provider 证据；
- `evidence/04_FAILURE_INJECTION_0_6_5_STABLE.json`：此前 stable 的 replay 失败注入证据；
- `evidence/05_PACKAGE_ACCEPTANCE_0_6_5_STABLE.json`：此前 stable 封印的 package prerequisite 证据；最终解压安装验收另由历史 ZIP validation sidecar 绑定；
- `evidence/06_SKILL_VALIDATION_0_6_5_STABLE.json` 与 `07_SECURITY_ACCEPTANCE_0_6_5_STABLE.json`：此前 stable 的本地门禁证据；
- `evidence/02_REAL_DEEPSEEK_SMOKE_REDACTED.json`：withdrawn rc.1 历史失败；
- `evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json`：2026-08-23 此前 stable 修订的历史真实 Provider PASS；不作为本修订的重资格证据。
