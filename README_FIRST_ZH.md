# 首先阅读：0.6.6 Public Ref Scope 修复候选

唯一活动源码是 `current/`。旧 handoff、withdrawn ZIP、旧 PASS 报告与历史 smoke 均位于 `archive/`，只能作为历史证据，不能作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
deliverableStatus=LOCAL_QUALIFICATION_PASS_PUSH_APPROVAL_REQUIRED
branch=repair/0.6.6-public-ref-scope-fix-r1
implementationCommit=3b061da84f3eb0c055c4766b3897dfdb61b07caa
candidatePath=0.6.6-candidate-3b061da84f3e
finalArchive=null
```

四项 Owner Decision 均已冻结。公开历史审计范围现在只来自远端通告的 `refs/heads/*` 与 `refs/tags/*`，并可在资格审查时显式加入唯一 proposed public ref；本地分支、remote-tracking refs、stash、pull refs、replace refs、grafts、浅克隆状态和全局 Git 配置均不能改变审计集合。迁移证据保留了旧 local-scope 基线、5-ref public-remote 基线及二者的精确 supersession 差异。

远端 public-remote 基线覆盖 5 个公开 ref、32 个可达提交、60 次 Owner 邮件标识、91 次 Owner 主目录别名及 3 个精确历史 Gitlink。加入实现 ref 后覆盖 6 个 ref、33 个提交、62/64 次邮件标识与 91/136 次路径标识；隐私签名集合和 Gitlink 集合均未新增。活动源码、候选包、归档 staging 与最终 ZIP 门禁仍强制零 Gitlink、零 `.gitmodules`，无需改写历史。

精确实现修订已通过 21 个本地资格化步骤、161 个唯一测试与 8 次门禁执行；独立负向 smoke 又重复执行 34 个测试。覆盖完整 process E2E、固定 Harness 动态 fixture、stdio MCP、安全验收、14 项要求的 ref-scope/隐私/Gitlink 回归、公开历史接受、双层 Manifest，以及 candidate 新装/迁移/回滚/重装/卸载。

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
