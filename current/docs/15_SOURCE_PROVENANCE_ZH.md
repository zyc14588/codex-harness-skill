# 0.6.6 最终版本候选源码 provenance

机器权威文件为仓库根与本目录的 `SOURCE_PROVENANCE.json`。唯一活动源码是 `current/`。

审计基线 `release/0.6.5-hotfix-r4` 的 HEAD 为 `10a70fc0e59ad93fce387c6a1660596d9f01ad7f`，tree 为 `3468eb8ce22bec2a00df4f126619bdf7ee739ba3`；其 stable 声明已在本地 commit `1c7dd48e2e39c642f8b8bf63d384166208004a5a` 撤回。当前施工分支为 `repair/0.6.6-provider-capability-and-release-integrity`。

旧 R6.4 handoff、旧 baseline、withdrawn R2/R3/R4 归档和 fixture 已移至 `archive/`。没有 nested Git metadata 作为 canonical source；`current/` 的普通 tracked files 是唯一实现权威。

固定 Harness commit 为 `141eb6fef83422698aef7a981029e843e8161534`，build tree SHA-256 为 `6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38`。

当前 implementation commit/tree 尚未封存，因此 release status 必须保持 candidate。0.6.5 的真实 Provider 证据只作历史，不可为本修订续期；安全关键路径已经改变，必须从封存后的当前 revision 重跑 Flash、Pro 与负向 smoke。禁止自动 push、merge、tag 或 GitHub Release。
