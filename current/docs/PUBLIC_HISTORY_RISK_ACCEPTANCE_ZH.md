# 公开历史风险接受（Owner 决策）

Owner `zyc14588` 于 `2026-08-26T08:51:40+10:00` 批准以下三个互不扩张的决定：

- `PUB-HIST-EMAIL-001`：`A_ACCEPT_PUBLIC_EMAIL_ACCOUNT_IDENTIFIER_EXPOSURE`，分类 `OWNER_ACCEPTED_PUBLIC_EMAIL_IDENTIFIER`；
- `PUB-HIST-PATH-001`：`A_ACCEPT_PUBLIC_HOME_PATH_AND_ACCOUNT_ALIAS`，分类 `OWNER_ACCEPTED_PUBLIC_PATH_IDENTIFIER`；
- `PUB-HIST-GITLINK-001`：`A_ACCEPT_OPAQUE_HISTORICAL_GITLINK_REFERENCES`。

权威 Owner 原件为 `evidence/PUBLIC_HISTORY_OWNER_ACCEPTANCE.json`；Owner 签署的原始 local-scope baseline 为 `evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json`，SHA-256 是 `3af7e6be9ad2498bca234e469529098f871d795df9da972c2434ca5e308a3afb`，并原样保存为 `evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_LOCAL_SCOPE_LEGACY.json`。新的权威范围 baseline 是 `evidence/PUBLIC_REPOSITORY_PUBLIC_REF_BASELINE.json`，迁移绑定为 `evidence/PUBLIC_HISTORY_BASELINE_SUPERSESSION.json`；机器验证输出为 `evidence/PUBLIC_HISTORY_RISK_ACCEPTANCE.json`。

该接受不授权 history rewrite、force-push、删除 refs、掩盖或删除 findings、自动 push/merge/tag/GitHub Release，也不接受凭据、秘密、无关第三方个人信息或未来新增敏感字段。隐私 identity 只含稳定签名字段。原始 email 上限仍为 64；Owner 明确要求的 `CRED_EPHEMERAL_001_B_MINIMAL_REPAIR` implementation commit `36e78afe5f3c450f7dbacbb2e1ace3fb90acfab9` 为同一已接受 identifier 增加 author/committer 两次记录，因此仅在该 commit 可从 proposed public ref 到达且 distinct identifier signature 未增加时，task-bound 有效上限为 66。home alias 上限仍为 136，减少会记录 delta。任何新 distinct privacy signature、次数越界、绑定 commit 不可达、Gitlink object/path 集变化、新 secret、archive finding 或 distributed-license blocker 都必须拒绝为 `BLOCKED_NEW_PUBLIC_HISTORY_FINDING`。

结果语义为：

```text
result = PASS
findingsDisposition = PASS_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS
historyRewriteRequired = false
confirmedSecrets = 0
unresolvedDistributedLicenseFindings = 0
```

findings 保留在审计中。`PASS` 只表示已列明历史风险由 Owner 接受且没有新增发现；它不把历史内容称为已脱敏，也不将不可访问的外部内容纳入 release provenance。
