# 交接包构建与验证报告

## 构建身份

```text
Bundle: CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1
Purpose: R6.4 真实失败后的 Codex 修复交接
Included source baseline: 0.6.3
Exact target source included: no
Release artifact: no
```

## 已执行验证

```text
顶层逐文件 SHA-256 manifest        PASS
JSON parse                          PASS
YAML parse                          PASS
Shell syntax                        PASS
capture script --help               PASS
Package symlink scan                PASS
.git/node_modules exclusion         PASS
Known-secret pattern scan           PASS
0.6.3 baseline unit tests           58 / 58 PASS
```

源码测试中存在明确标记的假凭据：

```text
acceptance-secret-not-persisted
fake-acceptance-key
```

它们只用于 deterministic acceptance，不是真实密钥。扫描排除了这两个固定测试值，未发现真实 API key 或 Bearer credential 形态。

## 重要限制

本报告验证的是交接包完整性与包含的 0.6.3 基线源码，不是 R6.4 修复成功证明。精确 R6.4 runtime/profile/preset 必须在用户机器上通过 `scripts/capture-installed-r6-4.sh` 回收后，才能由 Codex继续施工。
