# 首先阅读：0.6.6 Owner Decisions 实施候选

唯一活动源码是 `current/`。旧 handoff、withdrawn ZIP、旧 PASS 报告与历史 smoke 均位于 `archive/`，只能作为历史证据，不能作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
deliverableStatus=PUBLIC_HISTORY_ACCEPTED_LOCAL_QUALIFICATION_PASS_EXTERNAL_AND_HOST_BLOCKED
branch=repair/0.6.6-public-history-owner-acceptance-r2
implementationCommit=cabf226a8b385732d2249a8af920d20f641aa2a6
candidatePath=0.6.6-candidate-cabf226a8b38
finalArchive=null
```

四项 Owner Decision 均已冻结。完整工作树、全部 refs 与全部可达历史审计已按 `zyc14588` 在 `2026-08-26T08:51:40+10:00` 的精确接受决定通过：32 个提交中的 64 次 Owner 邮件标识、136 次 Owner 主目录别名和 3 个不透明历史 Gitlink 均为已接受历史发现，无需改写历史。活动源码、候选包、归档 staging 与最终 ZIP 门禁强制零 Gitlink、零 `.gitmodules`。DEC-002、DEC-003、DEC-004 已通过本地实现验证；DEC-001 仅因 required-check branch governance 未配置或核验而未完成。

精确实现修订已通过 21 个本地资格化步骤、147 个唯一测试与 8 次门禁执行；独立负向 smoke 又重复执行 34 个测试。覆盖完整 process E2E、固定 Harness 动态 fixture、stdio MCP、安全验收、公开历史接受、零 Gitlink 结构门禁、Manifest，以及 candidate 安装/迁移/回滚/重装/卸载。

当前仍为 candidate，`controlledUseAllowed=false`。本机对四个 Owner profile 均完成动态探测，但缺少已委派 cgroup v2 I/O controller；可逆主机重配置方案已就绪，但未执行提权命令、未修改系统文件。真实 Provider 门禁在读取凭据和进行网络 I/O 前停止，请求数与输入/输出 token 均为 0。仓库已核验为 public，但默认分支 `main` 未配置 branch protection、required checks 或 ruleset。当前分支未推送，exact-tip CI 与 protected Provider artifact/attestation 未运行；没有 merge、push、tag、GitHub Release、主机变更或最终 ZIP。

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
