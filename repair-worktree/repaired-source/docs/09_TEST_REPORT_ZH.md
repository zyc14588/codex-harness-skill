# 0.6.5 安全修复测试报告

> 历史封印报告：以下结果绑定此前 0.6.5 stable，不是封印后 runtime hotfix candidate 的重资格结果。当前状态以 `release-status.json` 为准。

报告状态：`DELIVERABLE_PASS / stable`。

| 层级 | 结果 |
|---|---|
| strict build + unit/component | PASS，83 项 |
| direct process E2E | PASS |
| real pinned Harness + local observable Provider | PASS |
| reasoning replay failure injection | PASS |
| security acceptance | PASS |
| stdio MCP acceptance | PASS |
| package acceptance | PASS，预封印与最终 ZIP 解压态 |
| skill validation | PASS |
| 当时封印代码 + real DeepSeek Minimal | PASS，4 轮、3 次原生工具调用 |
| 当时封印代码 + real DeepSeek Pro | PASS，4 轮、replay 0/1/2/3 |
| stable deterministic ZIP/unpacked gate | PASS |

## 关键覆盖

- operator Bearer、Origin/CSRF、私有 secret 文件与 UDS task token；
- Bubblewrap read/network/PID/mount 隔离、Provider key 不可见、`.env*` 拒绝；
- llama binary/hash/env/prompt-file 与强进程身份；
- Flash 四轮 immutable disabled；Pro enabled/high、无 tool choice、replay 0/1/2；
- `provider_protocol` 首次 422、同 attempt 后续 I/O 阻断、进程组终止；
- canonical 请求估算、1M/384K clamp、malformed JSON Provider 0；
- infrastructure taxonomy 与 schema-4 split memory 不污染；
- candidate/stable/withdrawn release gate；
- fresh install、schema 4→7、同版本与跨版本回滚、重装、卸载、包卫生。

## Package acceptance

`scripts/package-acceptance.sh` 已在预封印源码与最终 ZIP 解压态验证安装态 doctor、direct acceptance、83 项 installed tests、stdio MCP、迁移、双回滚、重装和卸载。`package-lock.json` 被打包，`node_modules`、symlink 和 secret 均不被打包。

## 真实 Provider 边界

`evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json` 是 2026-08-23 当时封印修订的 PASS：Flash 全程 disabled；Pro 全程 enabled/high、无 tool choice，完整回放前三条非空 Provider reasoning requirement。证据不包含密钥、token、prompt 或 reasoning 正文。执行参数、隔离边界与请求级结论见 `docs/10_REAL_DEEPSEEK_SMOKE_ZH.md`。
