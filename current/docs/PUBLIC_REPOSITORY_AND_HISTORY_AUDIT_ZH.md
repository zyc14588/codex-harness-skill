# 公开仓库与完整历史审计（DEC-001）

机器权威结果为 `evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT.json`。当前结论是 `PASS_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS`：发现被完整保留并由 Owner 明确接受，不表示历史已被重写、邮箱已被脱敏，或不可访问的外部 gitlink 内容已完成许可证核验。

## 覆盖与计数口径

- 接受基线覆盖 32 个 reachable commits；邮箱账户标识出现在这 32 个提交的 author/committer metadata 中，共 64 次。
- 发现 6 个唯一历史 ZIP。旧值 `3,288` 是同一 ZIP blob 在历史对象与当前 worktree 重叠检查时累加的成员次数；`1,776` 是对 ZIP blob 去重后六个唯一 ZIP 的成员总数。二者不得混用。
- Owner 自有 home-path/account alias 共出现 136 次，并存在于六个 ZIP 中。审计未发现额外真实姓名、第三方个人信息、凭据或项目秘密。该 alias 可与邮箱/公开账号关联，Owner 已接受这一关联。
- confirmed secrets、额外 personal-information candidates、LFS pointers、ZIP path traversal、archive integrity、当前声明依赖许可证未闭合项均为 0。

## Owner 接受的标识

`PUB-HIST-EMAIL-001` 的分类是 `OWNER_ACCEPTED_PUBLIC_EMAIL_IDENTIFIER`。邮箱标识仍在公开 Git history 中，形状为 `9-digit account identifier at qq.com`；不得描述成 `email redacted in Git history`。Owner 接受继续公开，因此不单独为该标识要求 history rewrite。

`PUB-HIST-PATH-001` 的分类是 `OWNER_ACCEPTED_PUBLIC_PATH_IDENTIFIER`。哈希与 Owner 本人的本机 account alias 一致；接受范围不包括任何第三方个人信息、额外敏感字段、凭据或秘密。若以后出现此范围之外的发现，审计必须 fail-closed 为 `BLOCKED_NEW_PUBLIC_HISTORY_FINDING`。

## 三个历史 gitlink

每项均为 `mode=160000`、`.gitmodules absent`、external URL absent、target inaccessible；目标 Git object/tree 不在本仓库，六个 ZIP 也没有目标路径树或嵌套 `.git` metadata。这里只能断言外部目标内容未由本仓库或最终包分发，不能断言目标许可证合规已经核验。

| ref | commit | path | object id |
| --- | --- | --- | --- |
| `refs/heads/main` | `bd707c75e7c730773fec3f7716847942f9bf27a5` | `repair-worktree/rc1-real-smoke-repo` | `05773fb6bee92b6f58f0aae6556b014103eebd24` |
| `refs/heads/main` | `bd707c75e7c730773fec3f7716847942f9bf27a5` | `repair-worktree/repaired-source` | `d30d9ac678f143e7bb14ea11a55e8b7cdd7152c8` |
| `refs/heads/evidence/0.6.5-stable` | `dd4714a52aaef93f4645f4f7b3aded491aa95b0b` | `repair-worktree/repaired-source` | `e2581382415fc167f26d9ce49bb9a6a95a119a04` |

三项同时分类为：

- `ACCEPTED_OPAQUE_HISTORICAL_REFERENCE`
- `EXTERNAL_CONTENT_NOT_DISTRIBUTED`
- `EXCLUDED_FROM_RELEASE_PROVENANCE`

## 当前与交付边界

Owner 接受的只是历史 opaque references。活动 `current/` 必须为零 mode-160000、零 `.gitmodules`；candidate/package staging 还必须为零 symlink、零 nested `.git`；final ZIP 必须通过独立 archive-mode gate。发布 provenance 与许可证清单只覆盖实际分发内容。

DEC-001 仍未整体完成：公开历史与风险接受已 PASS，仓库 visibility 已核验为 public，当前/包/归档结构门禁已实现并通过负测；但 GitHub default branch 的 required status checks / branch governance 尚未实际配置并经 API 核验。因此 `DEC-001.implementationVerified=false`。
