# STRICT R2 根 Manifest 根因报告

## 结论

根 `MANIFEST_SHA256.txt` 的失败不是单纯“文件过期”，而是范围模型、格式和门禁链路同时存在缺口：旧生成器按某次工作目录中的物理目录树递归，既不以 Git index 定义 tracked 集合，也不绑定 executable mode；根 CI 又没有验证根 Manifest。根 Manifest 最后停留在提交 `91f8d493c52e972bafd0fc19f0e50a927c35448a`，而后续实现提交 `62406f99b7caa8ecb3c8b6deb0d457973f3f9b34`、资格化元数据提交 `0c8eadbcf91da90aeb2133961d597ecc590a9c36` 和治理提交 `587513fe45f25b9235eb0d430161d675be2adfa7` 均未重新生成根 Manifest。

修复分支从强制记录的实际 HEAD `587513fe45f25b9235eb0d430161d675be2adfa7` 创建。该 HEAD 的 repository tree 是 `beef11892852f0097f7db6be9a8e8dd82fa2e246`。

## 1. 旧根 Manifest 的生成入口

仓库历史中没有根级生成器。与根 Manifest 格式、排序、排除行为完全一致的唯一持久化入口是 `current/scripts/update-manifest.mjs`；根文件需要从仓库顶层以等价于下列方式调用：

```text
node current/scripts/update-manifest.mjs .
```

Git 只能保存结果，不能证明操作者当时输入的 shell 命令，因此这里将“最后由该命令生成”限定为可由仓库内容证明的生成链路归因，而不是伪造不可得的终端日志。证据如下：

- `git log -- MANIFEST_SHA256.txt` 显示根 Manifest 最后一次变更在 `91f8d49`；
- 当时及当前仓库均无其他根 Manifest 生成器；
- 根 Manifest 的路径集合包含 `.github/`、`archive/`、`current/` 和根治理文件，且排序、双空格分隔与该脚本输出一致；
- 旧 CI 只在默认工作目录 `current/` 中执行 `node scripts/update-manifest.mjs .`，所以只防止 `current/MANIFEST_SHA256.txt` 漂移，不会更新或验证根 Manifest。

## 2. 旧生成器实际绑定的范围

当旧脚本以仓库顶层 `.` 为参数时，它绑定的是“生成当时物理 checkout 中可递归看到的整个仓库”，不是只绑定 `current/`，也不是只绑定旧 failure handoff。根 Manifest 中同时存在以下路径可直接证明这一点：

- `.github/workflows/ci.yml`；
- `archive/r6.4-failure-handoff/**`；
- `archive/releases/**`；
- `current/**`，包括 `current/MANIFEST_SHA256.txt`；
- `AUDIT_FINDINGS.json`、`REPAIR_CONTRACT.yaml`、根 provenance 和根 release status。

但“物理 checkout 递归”不等于“整个 tracked repository”。旧脚本使用 `readdir`/`lstat`，排除名为 `.git`、`node_modules` 的目录和 `.DS_Store`，并依赖运行时的 `localeCompare`。它不知道哪些文件被 Git 跟踪，可能纳入 untracked 文件，也可能因目录名白名单式排除而漏掉合法 tracked 文件；它还完全不读取 Git mode、stage、symlink 或 gitlink 类型。

## 3. mismatch 分类与外部门禁数字的可复现性

STRICT R2 的外部结论称 `116` 个 SHA-256 mismatch。按照任务要求先记录实际 HEAD 后，在干净的 `587513f` 上逐条用原始文件 bytes 重放，实际可复现 `91` 个 mismatch。分类规则互斥，合计严格等于 91：

| 类别 | 可复现数量 | 路径边界/原因 |
| --- | ---: | --- |
| 实现源码变化 | 31 | `current/bridge/src/**`、`current/config/**`、`current/harness/**`、`current/schemas/**`、`current/scripts/**`；来自 `62406f9` 的资源控制、broker、负向测试、安装与 release gate 修复 |
| dist 重新构建 | 40 | `current/bridge/dist/**` 中已有文件被 TypeScript build 重写 |
| evidence/provenance 变化 | 5 | 三份 current qualification/smoke evidence，以及根/current `SOURCE_PROVENANCE.json` |
| 治理文档变化 | 14 | root/current README、release status、audit/repair contract、current docs/skill 和根 workflow |
| 其他 | 1 | `current/MANIFEST_SHA256.txt`；它是 current 范围的生成物，不属于上述四类 |

91 个可复现路径的逐项集合可由以下确定关系复核：旧 Manifest 中仍存在、当前文件仍存在、记录 digest 不等于当前原始 bytes 的 SHA-256。它也恰好等于 `91f8d49..587513f` 的 91 个 modified path；新增 path 不应被误计为 hash mismatch，而应计为 missing。

外部数字 `116` 无法在任务指定的实际 HEAD 上逐项归类：`116 - 91 = 25` 个 path 没有出现在当前 mismatch 集合，也没有随任务提供可验证的外部门禁明细或 attestation。报告保留该外部失败事实，但不会虚构这 25 个 path 的类别。若要把外部 116 逐项追溯，必须提供当时 exact commit/index tree 与门禁的路径级输出；该证据不能由多次重写 Manifest 替代。

## 4. missing path 根因与数字核对

外部门禁称遗漏 `48` 个 tracked path。在实际 HEAD 上：

- `git ls-files -s -z` 给出 841 个 index entry，全部为允许的普通文件 mode；
- 唯一合法排除项是根 `MANIFEST_SHA256.txt`，所以预期 Manifest entry 为 840；
- 旧 Manifest 有 818 条、818 个唯一 path、0 duplicate、0 extra；
- 因此该 HEAD 上可复现的 missing 必然是 `840 - 818 = 22`，不是 48。

22 个遗漏均在根 Manifest 最后更新后由 `62406f9` 新增：

- 15 个新 `current/bridge/dist/**` 生成文件；
- 6 个实现文件：`brokered-tool-registry.ts`、`resource-controls.ts`、三份对应专项测试和 `prepare-stable-package.mjs`；
- 1 个治理文件：`current/docs/OWNER_DECISIONS.json`。

外部 `48` 与当前可复现 `22` 相差 26。由于旧 Manifest 没有 extra 或 duplicate，要在同一规则下得到 missing=48，预期 tracked 集合至少必须有 866 个 covered path，即总 index 至少 867 项；实际只有 841 项。故剩余 26 个 path 不属于当前记录的 HEAD/index，不能被诚实地补写原因或名称。最可能的证据需求是取回外部门禁运行时的 exact index/tree，而不是假定其与当前 HEAD 相同。

旧生成器漏掉当前 22 项的直接原因，是根 Manifest 没有在新增 tracked 文件后运行，并且 CI 只更新 current Manifest。结构性原因则是根范围没有由 Git index 和精确集合比较定义：即使这次手工重算，也无法防止下次新增 tracked path 后再次静默遗漏。

## 5. root 与 current Manifest 的权威边界

两者不是互相替代或递归委托：

- 根 Manifest 的权威集合：repository top-level Git index 中的所有 tracked 普通文件，唯一排除根 Manifest 自身；因此 `current/MANIFEST_SHA256.txt` 作为普通 tracked bytes 被根 Manifest 覆盖。
- `current/MANIFEST_SHA256.txt` 的权威集合：可安装/打包的 `current/` 内容，路径相对于 `current/`，排除它自身；它不定义根 archive、workflow 或治理文件是否存在。
- root verifier 不从 current Manifest 推断 root path 集合；current verifier也不得以 `../` 越出 current。

新的测试矩阵明确验证：root Manifest 包含 current Manifest，本身不自引用；current Manifest 只表达 current-relative path。这样内层清单可以服务安装包校验，外层清单独立绑定整个 tracked repository。

## 6. 自引用与 provenance 循环分析

旧根 Manifest 没有把根 `MANIFEST_SHA256.txt` 写入自身，所以没有直接自引用。它覆盖 `current/MANIFEST_SHA256.txt`，这是单向嵌套，不构成循环。

在 `587513f` 上，根和 current 的 `SOURCE_PROVENANCE.json`、根和 current 的 `release-status.json` 均未保存当前根 Manifest digest。`current/evidence/00_REPAIR_BASELINE_2026-08-24.json` 保存的是历史 failure-handoff Manifest digest，不是当前根 Manifest digest。因此当前不存在 live `provenance → root manifest digest → provenance` 循环。

新设计强制保持如下有向关系：

```text
Git index 中的 tracked repository files（排除根 Manifest 自身）
    → 根 MANIFEST_SHA256.txt
    → repository-external seal / artifact attestation（未来外部门禁）
```

任何被根 Manifest 覆盖的 tracked provenance、release status 或 evidence 均不得反向保存根 Manifest digest。将来如需封印根 Manifest，只能由仓库外 artifact attestation/sidecar 保存 digest；不能靠反复改写 provenance 和 Manifest 直到偶然“稳定”。

## 修复后的机制

新入口为：

- `scripts/update-root-manifest.mjs`；
- `scripts/verify-root-manifest.mjs`；
- 共享实现 `scripts/root-manifest-lib.mjs`；
- 11 项故障注入矩阵 `scripts/root-manifest.test.mjs`。

输入严格来自 `git ls-files -s -z`。解析使用 NUL record boundary 和原始 path bytes；只允许 stage 0 的 `100644`/`100755`，symlink、gitlink、冲突 stage、特殊 mode、无效 UTF-8、换行/NUL/控制或格式字符、反斜杠和非 canonical relative path 全部 fail closed。排序使用 `Buffer.compare` 的稳定字节序。每条格式为：

```text
<raw-file-bytes-sha256>  <git-mode>  <utf8-repository-relative-path>
```

verifier 分别检查 path 集合精确相等、重复、自引用、稳定顺序、原始 bytes digest、Manifest mode↔index mode 和 worktree executable bit↔index mode；它还计算根 Manifest digest 并拒绝任何 covered file 反向保存该 digest。任何 missing、extra、duplicate、mismatch、mode drift、反向 digest 引用或不支持类型均为 FAIL。
