# 首先阅读：0.6.6 发布前修复候选

唯一活动源码是 `current/`。旧 handoff、baseline、withdrawn ZIP、旧 PASS 报告和历史 smoke 全部位于 `archive/`，只能作为历史证据，不能作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
qualificationStage=FINAL_VERSION_CURRENT_REVISION_QUALIFICATION
deliverableStatus=REPAIR_IMPLEMENTED_EXTERNAL_OWNER_AND_ARCHIVE_GATES_PENDING
branch=repair/0.6.6-pre-release-audit-r1
implementationCommit=62406f99b7caa8ecb3c8b6deb0d457973f3f9b34
finalArchive=null
```

本轮已完成 fail-closed 精确 gate 集合、两阶段 seal、Brokered Tool 端到端取消与 Host process registry、Harness/Tool sibling 资源 profile、protected Provider artifact/attestation 工作流、认证审计轮换与聚合、模型可见读取分页与输出上限。绑定当前实现的本地完整资格化和负向 smoke 均通过。

这不构成稳定版通过。本机缺少已委派的 cgroup v2 I/O controller，真实 Provider smoke 因受控资源门禁在 Provider I/O 前失败，实际发送请求数为 0。当前修复分支已根据用户明确授权推送；最终治理 tip 的 exact-tip strict CI 结论与 protected Provider artifact attestation 仍待完成。2026-08-25 的只读核验确认仓库仍为 private，当前分支的 branch-protection 与仓库 rulesets API 均因 GitHub 方案返回 HTTP 403。DEC-001 至 DEC-004 尚未由所有者批准，seal-ready、最终 deterministic ZIP 与解包复验也尚未执行。

前一修复分支的成功 CI run `32677107669` 只属于历史 observational evidence，不得用于当前 seal。没有生成 stable ZIP，没有 merge、push、tag 或 GitHub Release。

从这里开始：

```bash
cd current
node scripts/verify-release-gate.mjs --root . --audit-candidate
cd bridge
npm ci
npm run build
npm test
```

机器可读状态以 `current/release-status.json` 为准，来源绑定以 `current/SOURCE_PROVENANCE.json` 为准，待决事项见 `current/docs/OWNER_DECISIONS.json`。自动 merge、push、tag 和 release 均被禁止；本次分支 push 仅依据用户本轮明确授权执行。
