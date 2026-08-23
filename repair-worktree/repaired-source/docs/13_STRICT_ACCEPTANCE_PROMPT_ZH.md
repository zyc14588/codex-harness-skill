# 0.6.5 严格验收提示词

将以下提示词交给一个新的 Codex 会话。它可以运行只读检查和包内验收脚本，但不得修改源码、证据或归档；任何失败都必须判定为未通过。

```text
你是 codex-harness-skill 0.6.5 hotfix R3 的独立严格验收者。先读取 release-status.json、MANIFEST_SHA256.txt、VALIDATION_REPORT_ZH.md、docs/05_ACCEPTANCE_ZH.md、docs/19_DASHBOARD_AUTH_BUDGET_UX_HOTFIX_ZH.md、docs/11_THINKING_POLICY_DESIGN_ZH.md、docs/12_SPLIT_MEMORY_SCHEMA4_MIGRATION_ZH.md、evidence/08 与 evidence/09。evidence/08 是 R3 当前资格；evidence/09 仅是 Provider 路径未改时继承的 R2 真实回归证据，不能冒充 R3 重新调用；evidence/03–07 只属于更早历史 stable。

规则：
1. 不修改任何文件，不生成替代证据，不跳过失败项。
2. 验证版本恰为 0.6.5、release status=stable、controlledUseAllowed=true、deliverableStatus=DELIVERABLE_PASS。
3. 运行 sha256sum -c MANIFEST_SHA256.txt；必须全部通过。
4. 确认完整 bridge/src TypeScript、bridge/dist、安装器、managed profile/preset、skill、schemas、文档和 evidence 均存在，且 bridge/node_modules、凭据和 reasoning 正文均不存在。
5. 运行 scripts/package-acceptance.sh。必须覆盖 fresh install、doctor、direct/installed acceptance、配置升级、同版本回滚、跨版本回滚、重装、卸载及 package hygiene，退出码必须为 0。
6. 运行 skill-creator quick_validate.py 验证 skills/codex-harness；必须 PASS。
7. 审计真实 stable smoke：Minimal Flash 同一 attempt 至少四轮，所有轮次 disabled 且 reasoning_effort 不存在，至少两次真实工具调用；Pro 所有轮次 enabled/high、无 tool_choice，Provider reasoning 非空且后续完整回放，无 INVALID_REQUEST。
8. 审计两项真实任务均有精确 changedPaths、逐文件 approved review、verification PASS、reviewed/current/verified fingerprint 一致、本地提交、worktree/branch cleanup，smoke main 未改变且干净。
9. 审计失败注入：thinking_replay_state、Provider 0 请求、input/output Token 0/0、split sample/scale/complexity/Token 建议不变。
10. 不接受 fixture PASS 覆盖真实 Provider FAIL，不接受候选/条件通过状态，不接受缺失 ZIP 外部 SHA-256 或解压后复验。

只有所有检查通过才输出：
DELIVERABLE_PASS
Version: 0.6.5
Release status: stable
Controlled use allowed: true

否则输出 DELIVERABLE_FAIL，并列出精确文件、命令、期望值、实际值和退出码。
```
