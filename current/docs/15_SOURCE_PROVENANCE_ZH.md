# 0.6.6 最终版本候选源码 provenance

机器权威文件为仓库根与本目录的 `SOURCE_PROVENANCE.json`。唯一活动源码是 `current/`。

历史审计基线 `release/0.6.5-hotfix-r4` 的 HEAD 为 `10a70fc0e59ad93fce387c6a1660596d9f01ad7f`，tree 为 `3468eb8ce22bec2a00df4f126619bdf7ee739ba3`；其 stable 声明已在本地 commit `1c7dd48e2e39c642f8b8bf63d384166208004a5a` 撤回。本轮 owner-decision 与 R2 remediation 从已接受的仓库基线 HEAD `587513fe45f25b9235eb0d430161d675be2adfa7`、tree `beef11892852f0097f7db6be9a8e8dd82fa2e246` 开始，施工分支为 `repair/0.6.6-owner-decisions-and-r2-remediation`。此前修复分支及其远端 run 只作历史输入，不能为本分支续期。

旧 R6.4 handoff、旧 baseline、withdrawn R2/R3/R4 归档和 fixture 已移至 `archive/`。没有 nested Git metadata 作为 canonical source；`current/` 的普通 tracked files 是唯一实现权威。

固定 Harness commit 为 `141eb6fef83422698aef7a981029e843e8161534`，build tree SHA-256 为 `6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38`。

精确 implementation commit/tree 不写入同一实现提交内的自引用文档，而是在提交完成后记录到机器权威 `release-status.json` 与 `SOURCE_PROVENANCE.json`。只要当前修订的本地资格化、Flash、Pro、负向 smoke、required 资源 profile、受保护实际 CI/attestation、分支保护、四项 owner 决策和归档复验未全部完成，release status 就必须保持 candidate。0.6.5 及前一 0.6.6 分支的 Provider/CI 证据只作历史，不可为本修订续期。禁止自动 push、merge、tag 或 GitHub Release。
