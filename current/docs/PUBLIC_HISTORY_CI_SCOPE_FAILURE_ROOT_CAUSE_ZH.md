# exact-tip CI 32925075747 公开历史审计范围失败根因

## 结论

失败提交 `d1b27f03e5ec577adab5c53126327d8c5f5f1ff3` 没有通过删除 finding 修复。根因是旧审计把“运行机器当前拥有的全部 Git refs”误当成“GitHub 当前公开历史”，同时把随 ref/commit 可达范围变化的 `occurrenceCount` 放进 Owner-accepted finding identity。修复后的权威历史输入只来自 `git ls-remote --heads --tags origin`，并在独立临时 bare repository 中验证和扫描该公开 ref 闭包；pre-push 只能通过显式 proposed ref/commit 扩展该范围。

## 失败提交中的四个本地全范围查询

对失败提交执行以下只读检查：

```text
git show d1b27f03e5ec577adab5c53126327d8c5f5f1ff3:scripts/public-repository-history-audit.mjs
```

可确认当时的 `auditPublicRepository` 依次使用：

1. `git for-each-ref --format=%(refname)%09%(objectname)`；
2. `git rev-list --all`；
3. `git rev-list --objects --all`；
4. `git log --all --format=...`，并另用一次 `git log --all --format=%T` 枚举 tree。

这些查询都以当前开发仓库的 ref namespace 为输入；它们不是 origin 公告的公开 ref 集，也没有区分 local-only、remote-tracking 或 stash。

## Owner-accepted legacy baseline 实际混入的 refs

Owner 原始接受所绑定的 baseline 是 `current/evidence/PUBLIC_REPOSITORY_HISTORY_AUDIT_BASELINE_2026-08-26.json`，原始字节 SHA-256 为 `3af7e6be9ad2498bca234e469529098f871d795df9da972c2434ca5e308a3afb`。其中 16 个 ref 明确包含三类非权威公开视图：

- local-only heads：除当时真正存在于 origin 的公开分支外，还包括 `refs/heads/evidence/0.6.5-stable`、两个仅本地 hotfix head、多个同一提交的 repair 别名 head，以及 owner-decision 施工 head；
- remote-tracking refs：`refs/remotes/origin/HEAD`、`refs/remotes/origin/main`、一个 release 与两个 repair tracking refs；它们只是公开 refs 的本地重复视图；
- `refs/stash`：`5964720b48de7a1575640f3335a3863dd1b904fa`，它从来不是 GitHub 公开 head 或 tag。

因此 legacy baseline 的 `refs=16` 是开发机状态快照，不是公开仓库边界。

## GitHub Actions clean clone 为什么不同

`strict-ci` 在新的 hosted runner 上由 `actions/checkout` 建立 clean clone。这个 clone 不会拥有开发机的 local-only heads 或 `refs/stash`；remote-tracking ref 的名称和数量由 checkout 的 fetch/refspec 行为决定，也不等于开发机长期累积的 namespace。即使两边检出的 exact commit 和对象内容相同，`for-each-ref` 与四个 `--all` 查询的根集合仍可不同，继而改变 reachable commits、对象 locator、representative refs 与 occurrence counts。

公开性不能由这种运行机器状态推导。origin 的 heads/tags 公告才是 CI、开发机和 clean clone 共同可复验的边界。

## `occurrenceCount` 被错误地当成 finding identity

失败提交中的 `privacySignature` 序列化了：

```text
rule, matchSha256, matchedUtf8Bytes, domain, identityClass, occurrenceCount
```

随后 `exactFindingSet` 对当前与 baseline 的这些序列化值排序并要求字节完全相等。因此，同一个已批准邮箱标识或同一个已批准本地 home alias，只要 ref/commit scope 令出现次数变化，就会被报告为：

```text
privacy findings changed outside the Owner-accepted baseline
```

这是 identity 建模错误。稳定 identity 只能是：

- email：`rule + matchSha256 + matchedUtf8Bytes + domain + identifierShape`；
- home path：`rule + matchSha256 + matchedUtf8Bytes + identityClass`。

`occurrenceCount`、representative locators、ref count 与 commit count 都是观察量，不是标识身份。

## 修复边界

修复不改写历史、不删除或掩盖任何 finding，也不扩大 Owner acceptance。新实现执行以下闭包：

```text
origin public heads/tags
  -> 验证 ls-remote 公告
  -> fetch 到全新临时 bare repository
  -> 逐 ref 验证实际 OID 与 annotated-tag peeled commit
  -> fsck 与 missing-object closure 验证
  -> 只扫描这些 refs 可达的 commits、trees 与 blobs
  -> 删除临时 repository
```

`public-remote` 只包含当前 origin heads/tags；`proposed-public-ref` 只在其上增加明确给出的 proposed ref name 与 exact local commit。global/system Git config、replace refs、grafts、alternate object databases、source shallow 边界、local heads、remote-tracking refs 和 stash 均不能扩张审计范围。

Owner 比较仍保留原始批准上限：email author/committer occurrences 为 64，home-path alias occurrences 不超过 136。`CRED_EPHEMERAL_001_B_MINIMAL_REPAIR` 明确要求的新 implementation commit `36e78afe5f3c450f7dbacbb2e1ace3fb90acfab9` 且禁止 history rewrite，因此同一已接受 email identifier 的 author/committer 两次记录只形成绑定该 commit 的 task-bound 有效上限 66；不得推广到其他 commit 或 identifier。减少会记录负 delta，并明确解释为 ref-scope 去重，而不是 history rewrite。任何新 distinct identifier、超过 66、新 secret、新 Gitlink object/path、archive integrity finding 或 distributed-license blocker 都以 `BLOCKED_NEW_PUBLIC_HISTORY_FINDING` 终止。
