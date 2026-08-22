# codex-harness-skill 0.6.5 稳定版交付

```text
DELIVERABLE_PASS
Version: 0.6.5
Release status: stable
Controlled use allowed: true
Real Minimal Flash smoke: PASS
Real Pro Thinking smoke: PASS
Failure-injection smoke: PASS
Package acceptance: PASS
Final ZIP unpacked revalidation: PASS
```

一次性交付文件：

```text
deliverables/CODEX_HARNESS_BRIDGE_0_6_5_STABLE.zip
deliverables/CODEX_HARNESS_BRIDGE_0_6_5_STABLE.zip.sha256
deliverables/CODEX_HARNESS_BRIDGE_0_6_5_STABLE.zip.validation.json
```

ZIP SHA-256：

```text
737ea4d5d148544cd1a2a605a1ec32f7de5ed2355f6c9b17b01bbf48344a7eba
```

稳定源码提交：`e2581382415fc167f26d9ce49bb9a6a95a119a04`。外层 evidence 提交见最终回复。

归档直接由 stable commit 通过 `git archive` 生成。全新目录解压后完成 ZIP CRC、路径穿越、symlink、243/243 manifest、release status、skill validator 和完整 9 阶段 package acceptance。没有修改主分支，没有 push、tag 或创建 GitHub Release。
