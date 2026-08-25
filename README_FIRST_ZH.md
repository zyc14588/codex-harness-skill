# 首先阅读：0.6.6 Owner Decisions 实施候选

唯一活动源码是 `current/`。旧 handoff、withdrawn ZIP、旧 PASS 报告与历史 smoke 均位于 `archive/`，只能作为历史证据，不能作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
deliverableStatus=OWNER_DECISIONS_IMPLEMENTED_LOCAL_PASS_EXTERNAL_BLOCKED
branch=repair/0.6.6-owner-decisions-and-r2-remediation
implementationCommit=2ea556dc35d3695be3c5b7bad1b3dc86f07156c5
candidatePath=0.6.6-candidate-2ea556dc35d3
finalArchive=null
```

四项 Owner Decision 均已按 `zyc14588` 在 `2026-08-26T01:22:12+10:00` 的决定冻结。DEC-003 分级资源 profile 与 DEC-004 commit-suffixed candidate 生命周期已通过本地实现验证；DEC-001 因完整工作树、全部 refs 与全部可达历史审计发现脱敏个人信息和历史 Gitlink 而保持阻断；DEC-002 以该公开历史审计 PASS 为前置条件，因此也保持 `implementationVerified=false`。

精确实现修订已通过 14 个本地资格化步骤、241 个测试、完整 process E2E、固定 Harness 动态 fixture、stdio MCP、安全验收、专项负向 smoke，以及 candidate 安装/迁移/回滚/重装/卸载。根与 `current/` Manifest 在最终元数据封存时重新生成并严格校验。

这不构成 stable 或 controlled-use PASS。本机对四个 Owner profile 均完成动态探测，但缺少已委派 cgroup v2 I/O controller；真实 Provider 门禁在读取凭据和进行网络 I/O 前停止，请求数为 0。仓库已核验为 public，但默认分支 `main` 未配置 branch protection、required checks 或 ruleset。当前实现未推送，exact-tip CI 与 protected Provider artifact/attestation 未运行；没有 merge、push、tag、GitHub Release 或最终 ZIP。

从这里开始：

```bash
cd current
node scripts/verify-release-gate.mjs --root . --audit-candidate
cd bridge
npm ci
npm run build
npm test
```

机器状态以 `current/release-status.json` 为准；来源绑定见 `current/SOURCE_PROVENANCE.json`；Owner 决策见 `current/docs/OWNER_DECISIONS.json`；公开历史审计见 `current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json`。自动 merge、push、tag 和 release 均被禁止；远端变更必须另获用户明确授权。
