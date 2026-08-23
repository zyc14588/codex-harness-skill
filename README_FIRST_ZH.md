# 首先阅读：0.6.6 最终版本资格化候选

唯一活动源码是 `current/`。旧 handoff、baseline、withdrawn ZIP、旧 PASS 报告和历史 smoke 全部在 `archive/`，不得作为安装或发布入口。

当前权威状态：

```text
releaseStatus=candidate
controlledUseAllowed=false
qualificationStage=FINAL_VERSION_CURRENT_REVISION_QUALIFICATION
deliverableStatus=FINAL_VERSION_QUALIFICATION_IN_PROGRESS
realProviderSmoke=pending
```

Provider/Adapter/tool capability 分域、Host 侧工具兄弟 Bubblewrap、clean reviewed-patch verification、ignored poisoning、operator 认证以及 RC 基线完整 regression/安装回滚矩阵均已通过本地验证。活动版本面现已固定为 `0.6.6`，但这只是为了在最终版本字节上生成同修订资格证据；最终版完整重跑、当前 revision Flash/Pro、GitHub Actions 实际 run、branch protection 与最终归档尚未全部完成。

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
