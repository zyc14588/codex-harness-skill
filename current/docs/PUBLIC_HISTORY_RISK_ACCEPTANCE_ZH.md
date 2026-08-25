# 公开历史风险接受（Owner 决策）

Owner `zyc14588` 于 `2026-08-26T08:51:40+10:00` 批准以下三个互不扩张的决定：

- `PUB-HIST-EMAIL-001`：`A_ACCEPT_PUBLIC_EMAIL_ACCOUNT_IDENTIFIER_EXPOSURE`，分类 `OWNER_ACCEPTED_PUBLIC_EMAIL_IDENTIFIER`；
- `PUB-HIST-PATH-001`：`A_ACCEPT_PUBLIC_HOME_PATH_AND_ACCOUNT_ALIAS`，分类 `OWNER_ACCEPTED_PUBLIC_PATH_IDENTIFIER`；
- `PUB-HIST-GITLINK-001`：`A_ACCEPT_OPAQUE_HISTORICAL_GITLINK_REFERENCES`。

权威 Owner 原件为 `evidence/PUBLIC_HISTORY_OWNER_ACCEPTANCE.json`；接受基线原始审计为 `evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json`，SHA-256 是 `3af7e6be9ad2498bca234e469529098f871d795df9da972c2434ca5e308a3afb`。机器验证输出为 `evidence/PUBLIC_HISTORY_RISK_ACCEPTANCE.json`。

该接受不授权 history rewrite、force-push、删除 refs、掩盖或删除 findings、自动 push/merge/tag/GitHub Release，也不接受凭据、秘密、无关第三方个人信息或未来新增敏感字段。任何当前审计与基线的隐私哈希/次数、三个 gitlink object/path 组合、ZIP 计数或零新增条件不一致，验证器必须拒绝接受。

结果语义为：

```text
result = PASS
findingsDisposition = PASS_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS
historyRewriteRequired = false
confirmedSecrets = 0
unresolvedDistributedLicenseFindings = 0
```

findings 保留在审计中。`PASS` 只表示已列明历史风险由 Owner 接受且没有新增发现；它不把历史内容称为已脱敏，也不将不可访问的外部内容纳入 release provenance。
