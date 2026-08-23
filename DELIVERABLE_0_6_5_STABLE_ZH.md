# codex-harness-skill 0.6.5 安全审计修复稳定版交付

```text
DELIVERABLE_PASS
Version: 0.6.5
Hotfix: security-audit-repair-r1
Release status: stable
Controlled use allowed: true
Real Minimal Flash smoke: PASS
Real Pro Thinking smoke: PASS
Failure-injection smoke: PASS
Security acceptance: PASS
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
0dc60c0d9ada0045cffec95a3ec7d74cfb9e292af197603943e8a2d9a2f7b640
```

最后一个完整预封印验证提交为 `80aa1f70276a32a8792f6a8c49d35b62f8be46af`，tree 为 `b14f90f28c29e1264b64efd9240ac35b7a060cf3`。最终 outer stable-seal 提交见 `git log -1` 与交付回复；provenance 不在自身内容中制造自引用 commit。

归档由 `scripts/build-deliverable.sh` 生成：两次确定性 ZIP byte-identical；最终 ZIP 为 763805 bytes、309 个普通文件 entry。全新目录解压后完成 308/308 manifest、stable release gate、无 symlink/`node_modules` 卫生，以及完整 9 阶段 transactional package acceptance。真实 DeepSeek smoke 使用固定 Harness 与 Bubblewrap/credential Broker，只发送合成临时仓库任务，脱敏证据不含密钥或 reasoning 正文。

没有 merge main，没有 push、tag 或创建 GitHub Release。
