# 公开仓库与完整历史审计（DEC-001）

## 结论

当前结论是 `BLOCKED_PUBLIC_HISTORY_REMEDIATION`，不能把仓库已为 public 解释成发布资格 PASS。机器权威结果由 `scripts/public-repository-history-audit.mjs` 生成到 `evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json`；报告只保存哈希和结构定位，不回显秘密或个人值。

阻断项有两类：

1. `PUBLIC_HISTORY_PERSONAL_INFORMATION`：可达历史和归档中存在本机 home account 标识；commit author/committer metadata 中存在个人邮箱。两者仅以 match SHA-256、字节数、次数和有限 locator 记录。
2. `UNSAFE_SYMLINK_OR_GITLINK_IN_HISTORY`：历史 tree 中存在 `160000` gitlink。当前 HEAD 没有 symlink/gitlink，但缺失的外部对象内容、许可证和来源不能由本仓库完整证明。

未经 Owner 对破坏性历史修复的额外明确授权，不执行 history rewrite、force push、远端 ref 删除或发布物删除。即使未来修复远端历史，也不能撤回已经发生的公开披露。

## 覆盖范围

审计器逐项覆盖：当前 tracked worktree 的实际字节、untracked 文件、ignored path inventory、全部本地 refs、所有可达 commits/objects/blobs（包括已删除文件）、commit author/committer metadata、历史 tree mode、archive/evidence/log/prompt 路径、ZIP member 内容与 traversal、超大对象和 LICENSE/COPYING 路径。ignored 内容不属于 Git 发布集合，因此只盘点路径而不读取内容。

当前轮次确认所有可达 text blobs 均进入模式扫描；二进制按类型单独处理，ZIP 解包成员继续扫描。最终精确数量以 machine evidence 为准，因为实现提交和元数据提交会改变 worktree/ref 计数。

## 材料分类

- secrets/credentials：未确认私钥、Provider/OpenAI key、GitHub PAT、AWS key 或 Slack token；源代码中的示例规则和安全术语不作为凭据命中。
- personal information：确认存在，阻断。包括 local home account 和个人 commit-email metadata；报告不含原值。
- confidential/unreleased：存在 repair prompts、failure handoff、evidence、logs 和历史 release/withdrawn archives 等项目内部 provenance；未确认第三方 confidentiality/NDA 标记。它们只能在个人信息和来源阻断清除后作为项目公开 provenance 再评估。
- copyright/licensing：当前仓库含 LICENSE，扫描到的 ZIP 无损坏或 path traversal；历史 gitlink 的外部内容与许可证来源不可在本仓库闭合，因此仍阻断。
- 条件可公开材料：source code、documentation/prompts、hash-redacted evidence/logs、通过完整性验证的 archives。该分类不覆盖命中的个人信息，也不替代第三方许可证复核。

## 重新取得资格的条件

需要先形成经 Owner 明确批准的历史修复方案，处理个人 metadata/home path 与历史 gitlink provenance；在所有受影响 refs、归档和公开远端完成可验证修复后，重新运行同一全量审计。只有 `blockers=[]` 且结果为 `PASS_PUBLICATION_ELIGIBILITY_AUDIT`，DEC-001/DEC-002 的稳定发布门禁才可通过。
