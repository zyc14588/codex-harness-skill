# 首先阅读：0.6.6 最终版本资格化候选

唯一活动源码是 `current/`。旧 handoff、baseline、withdrawn ZIP、旧 PASS 报告和历史 smoke 全部在 `archive/`，不得作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
qualificationStage=FINAL_VERSION_CURRENT_REVISION_QUALIFICATION
deliverableStatus=QUALIFIED_CANDIDATE_EXTERNAL_GATES_PENDING
realProviderSmoke=pass
```

Provider/Adapter/tool capability 分域、Host 侧工具兄弟 Bubblewrap、clean reviewed-patch verification、ignored poisoning、operator 认证、最终版完整 regression/安装回滚矩阵、负向 smoke，以及当前 revision Flash/Pro 均已通过并绑定实现提交 `adcd07a6ee7904cd70b3cdc8a57c896dc1f12628`。只读 GitHub 核验显示目标分支/提交不在远端、Actions run 列表为空，私有仓库 branch-protection API 因方案限制返回 HTTP 403；最终归档因此未生成，状态继续是 candidate。

从这里开始：

```bash
cd current
node scripts/verify-release-gate.mjs --root . --audit-candidate
cd bridge
npm ci
npm run build
npm test
```

禁止自动 push、merge、tag 或 GitHub Release。`version=0.6.6` 不等于 `releaseStatus=stable`；只有严格矩阵全部通过，才可将状态提升为 stable 并生成最终 ZIP。
