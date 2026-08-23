# 0.6.5 runtime hotfix R3 stable 验证报告

验证日期：2026-08-23。

```text
DELIVERABLE_PASS: YES
Version: 0.6.5
Revision: dashboard-auth-budget-ux-r3-stable
Release status: stable
Controlled use allowed: true
All release gates: PASS
```

## 发布门禁

| 项目 | 结果 | 当前修订证据 |
|---|---|---|
| dependency install/audit | PASS | `npm ci`，0 vulnerabilities |
| strict TypeScript build | PASS | src/dist/声明/sourcemap 一致 |
| unit/component | PASS | 89/89 |
| direct process acceptance | PASS | 计划、工具、审查、验证、清理、fail-fast |
| security acceptance | PASS | operator auth、Broker、Bubblewrap、最小环境、进程身份 |
| skill validation | PASS | `Skill is valid!` |
| Dashboard browser QA | PASS | Chrome desktop/mobile、无 dialog/console error/横向溢出 |
| operator password rotation | PASS | 旧密码失效、新密码生效、匿名 HTML 无 secret |
| inherited dynamic pinned Harness | PASS | R2 Flash 4 轮；Pro 3 轮，replay 0/1/2 |
| zero-I/O failure injection | PASS | Provider 0、Token 0/0、split 不变 |
| inherited real Minimal Flash | PASS | R2 4 轮 disabled，3 次原生工具调用 |
| inherited real Pro Thinking | PASS | R2 4 轮 enabled/high，replay 0/1/2/3 |
| ordinary source/provenance | PASS | R3 implementation baseline `221d7a0` |
| package acceptance | PASS | fresh install、schema 4→7、双回滚、重装、卸载 |
| deterministic archive/unpacked | PASS | 双构建字节一致；全新目录重新验收 |

## Provider 证据边界

R3 只修改 Dashboard、operator credential rotation、测试与发布文档，没有修改 Provider 请求构造、Harness profile、Bubblewrap 或 Broker 数据路径。因此本轮没有再次调用真实 Provider：API calls 0、tokens 0、费用 0。固定 Harness commit `141eb6fef83422698aef7a981029e843e8161534` 与 build SHA-256 `6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38` 的 R2 有界真实 Flash/Pro 证据作为未修改路径的继承回归证据保留，未冒充为 R3 重新调用。

脱敏机器证据：

- `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`：R3 当前源码的本地、浏览器、安全与包装门禁；
- `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`：未修改 Provider 路径继承的 R2 有界真实 Flash/Pro 门禁。

## 源码与制品

R3 完整实现资格基线为 commit `221d7a0c83919b3d86e6efa0607117df83c271dd`，outer tree `55501d97d953e6510a2b6d52f91bbfd3c9fe9f7a`，source tree `21e79c45b350be74b3eb0f8ac8b33a11bc308e63`。后续不可自引用的 release metadata、evidence、package lock 与 provenance 由 SHA-256 artifact bindings 和 manifest 保护。

最终制品为 `CODEX_HARNESS_BRIDGE_0_6_5_HOTFIX_R3_STABLE.zip`。构建脚本生成两份确定性 ZIP 并逐字节比较，在全新目录中重新验证 manifest、stable release gate、无 symlink/`node_modules` 卫生以及完整 transactional package acceptance。最终 SHA-256 以归档同目录 `.sha256` 和 `.validation.json` sidecar 为准。

没有执行 merge、push、tag 或 GitHub Release。包内权威状态为 `release-status.json`，文件完整性由 `MANIFEST_SHA256.txt` 与外部 sidecar 共同保护。
