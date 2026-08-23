# 0.6.5 runtime hotfix R2 stable 验证报告

验证日期：2026-08-23。

```text
DELIVERABLE_PASS: YES
Version: 0.6.5
Revision: known-runtime-errors-r2-stable
Release status: stable
Controlled use allowed: true
All release gates: PASS
```

## 发布门禁

| 项目 | 结果 | 当前修订证据 |
|---|---|---|
| dependency install/audit | PASS | `npm ci`，0 vulnerabilities |
| strict TypeScript build | PASS | src/dist/声明/sourcemap 一致 |
| unit/component | PASS | 87/87 |
| direct process acceptance | PASS | 计划、工具、审查、验证、清理、fail-fast |
| security acceptance | PASS | operator auth、Broker、Bubblewrap、最小环境、进程身份 |
| skill validation | PASS | `Skill is valid!` |
| dynamic pinned Harness | PASS | Flash 4 轮；Pro 3 轮，replay 0/1/2 |
| zero-I/O failure injection | PASS | Provider 0、Token 0/0、split 不变 |
| real Minimal Flash | PASS | 4 轮 disabled，3 次原生工具调用 |
| real Pro Thinking | PASS | 4 轮 enabled/high，replay 0/1/2/3 |
| ordinary source/provenance | PASS | implementation baseline `2ea0bd3`；final packaging baseline `cd97077` |
| package acceptance | PASS | fresh install、schema 4→7、双回滚、重装、卸载 |
| deterministic archive/unpacked | PASS | 双构建字节一致；全新目录重新验收 |

## 真实 Provider 边界

本修订真实 smoke 使用固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 与 build SHA-256 `6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38`。Flash 的 4 个请求全部 disabled 且无 reasoning effort；Pro 的 4 个请求全部 enabled/high、无 tool choice，并完整回放前三条非空 Provider reasoning requirement。凭据只在父信任域读取，Harness 只得到一次性任务 token；证据不保存密钥、prompt 或 reasoning 正文。

脱敏机器证据：

- `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`：当前源码的本地、动态与失败注入门禁；
- `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`：当前源码的有界真实 Flash/Pro 门禁。

## 源码与制品

完整实现资格基线为 commit `2ea0bd3850c8a9cf255f7c3f1dd12dd533a9f97e`。修正一条硬编码旧测试数量的安装日志后，最终普通源码/包装基线为 commit `cd97077ec7abbe42374b62b66655bf317f9956e0`，outer tree `72472caab5e5668ef2ffe8721db9a52097e3e1fc`，source tree `dfee675d6248751f291590bac8e04482950e5cd0`；317 个普通 blob，无 symlink/gitlink。

最终制品为 `CODEX_HARNESS_BRIDGE_0_6_5_HOTFIX_R2_STABLE.zip`。构建脚本生成两份确定性 ZIP 并逐字节比较，在全新目录中重新验证 manifest、stable release gate、无 symlink/`node_modules` 卫生以及完整 transactional package acceptance。最终 SHA-256 以归档同目录 `.sha256` 和 `.validation.json` sidecar 为准。

没有执行 merge、push、tag 或 GitHub Release。包内权威状态为 `release-status.json`，文件完整性由 `MANIFEST_SHA256.txt` 与外部 sidecar 共同保护。
