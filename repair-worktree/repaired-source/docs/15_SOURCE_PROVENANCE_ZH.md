# 0.6.5 源码 provenance

机器可读权威记录为 `SOURCE_PROVENANCE.json`。

## 恢复与历史链

```text
da1cfd2e74980ee325b5f4bfedf361d24c3d0d2c
  tree f828d31ccdec395e4caa9a96198996e424907ec7
  exact installed 0.6.4 recovery

b481c798c64e7566ee359f97480b3f8d794e0954
  tree 98508e80c5a8fad3947ce548cb82e83ae5e84cee
  managed minimal tool-plane repair

d30d9ac678f143e7bb14ea11a55e8b7cdd7152c8
  tree 98270b306374d1e8deced749bf73db4dc3e1f2ba
  withdrawn real Provider failure evidence（只读保留）

ea81ec6f91a0c13b0a6167581baf34e28be66d05
  tree fe981d7646108ebe9a36f6e37773287338d1cf6d
  current audit-repair working-tree baseline
```

`b481c79` 和 `d30d9ac` 均由恢复历史直接解析；撤回提交未被重写或删除。安全修复实现提交为 `f1d4864be8eb1ad3982fef81d6856e71f2b18385`，tree 为 `c3a17b397d03ad68497007c513bde8ff2a83f97e`；metadata 提交为 `e27d729a7b2205667cddf3cf3aa4f8006950c449`。完整内层历史在转换前用 `git bundle verify` 验证。

外层无 URL gitlink 已从索引移除，源码以普通 tracked files 纳入外层 repair/evidence 分支。在原 stable 封印中，real-provider gate、artifact bindings 与 ZIP 解压复验均通过，最后一个完整预封印验证提交为 `80aa1f70276a32a8792f6a8c49d35b62f8be46af`，tree 为 `b14f90f28c29e1264b64efd9240ac35b7a060cf3`；其后的 stable metadata/manifest seal 通过文件哈希绑定，避免在 provenance 文件内制造自引用 commit。

## Runtime hotfix R2 重资格链

本修订从外层 stable seal `ae5b46c0b86ac6dae830fb0080d8a47c08fae0f2` 建立本地分支 `release/0.6.5-hotfix-r2`。完成实现、本地/动态门禁与本修订真实 Provider smoke 后，普通源码基线封存为：

```text
commit:      2ea0bd3850c8a9cf255f7c3f1dd12dd533a9f97e
outer tree:  750daed76f271e4aeea2991af1c9f5da750cd0c8
source tree: e0f30105928291e1d076a3cd1fb1c58ff0a65f74
```

该 source tree 有 317 个普通 blob（303 个 mode 100644、14 个 mode 100755），symlink/gitlink 为 0。本修订真实 Provider 证据为 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`，SHA-256 为 `bb023ca725b56f55a0539f5bdbd245ec6accf75869ff11d199be1033b6bc54b0`。provenance、release status 与 manifest 的后续封印 metadata 无法自引用 commit，因此由文件哈希和 `MANIFEST_SHA256.txt` 绑定。

当前阶段 ordinary-source authority 已恢复；`workingTreeSealed` 仍为 false，直到两次确定性 ZIP 与全新目录解包验收完成。

## 固定 Harness

```text
Harness commit: 141eb6fef83422698aef7a981029e843e8161534
apps/cli/lib SHA-256: 6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38
```

安装器验证 commit、tracked cleanliness 和 build tree SHA-256；Bubblewrap binary 也独立固定 realpath/hash。

## 构建与交付

- TypeScript 5.8.3、`@types/node` 22.15.0；
- 完整 src、dist、声明文件与 sourcemap；
- `bridge/package-lock.json` 纳入包与 stable artifact binding；
- `bridge/node_modules` 不纳入包；
- deterministic ZIP 拒绝 symlink/special file，并归一化顺序、mtime 与 mode；
- `MANIFEST_SHA256.txt` 覆盖除自身外的所有普通文件；
- 不自动 merge、push、tag 或创建 GitHub Release。

最终 stable seal 已绑定上述 final repair commit/tree、当前 Provider evidence、package lock、provenance 和安全/安装证据；ordinary-source authority、真实 Provider 与最终归档门禁均未被跳过。
