# 2026-08-23 安全审计修复矩阵

> F-001–F-015 的原始封印证据保留为历史；runtime hotfix R2 已独立重跑本地/动态、失败注入和真实 Provider 门禁，来源与最终归档门禁以 `release-status.json` 为准。

本矩阵对应外部审计 F-001–F-015。状态表示实现与本地确定性验证；真实 Provider 与最终 stable seal 已按 `release-status.json` 的独立门禁通过。

| Finding | 修复 | 验证 |
|---|---|---|
| F-001 | operator Bearer；mutation Origin/CSRF；llama executable/working-dir/hash allowlist；固定 key env；最小环境 | `security-acceptance.sh`、monitor/llama/process tests |
| F-002 | Provider key 留在 Broker；task token + UDS；强制 Bubblewrap read/network/PID/mount 隔离；拒绝 `.env*` | `harness-isolation.test.ts` |
| F-003 | attempt 级 immutable policy；Flash 全程 disabled；Pro enabled/high、无 tool choice；完整 replay | thinking tests、动态真实 Harness fixture |
| F-004 | 恢复并固定 `b481c79`/`d30d9ac` commit/tree；已把无 URL gitlink 转成外层普通 tracked files，内层历史经完整 bundle 验证 | `SOURCE_PROVENANCE.json`、outer index mode audit |
| F-005 | bounded/redacted Provider HTTP normalizer；typed `provider_protocol`/credential/transport | `provider-policy.test.ts` |
| F-006 | infrastructure failure union/单一分类器；任何 infrastructure 不计 task-shape；schema 1–4 隔离 | split-memory tests |
| F-007 | 严格 Flash/Pro/replay Mock、动态 Harness、多轮 direct E2E、provider fail-fast | 87 项 component + direct + dynamic |
| F-008 | 对 canonical 完整请求作保守输入估算，含 tools/schema/framing | provider-policy tests |
| F-009 | V4 registry 固定 1M context/384K output；单请求 clamp | provider-policy tests |
| F-010 | withdrawn 拒绝；candidate 显式 audit；stable 全 PASS + SHA bindings；stable 禁 skip | release-gate tests、package acceptance |
| F-011 | PID/start-time/PGID/executable realpath/hash 身份；group leader supervisor；验证后信号 | process-identity/group/lifecycle tests |
| F-012 | prompt-file only；safe env allowlist；固定 `LLAMA_CPP_API_KEY` | config/llama/security acceptance |
| F-013 | Provider JSON 严格解析，本地 400，Provider 0 | harness isolation integration |
| F-014 | nonce-bound 一次性 request-state claim，绑定 task/attempt/ordinal/body hash/purpose | minimal-request-state tests |
| F-015 | README/LICENSE、CI、release status、lockfile、manifest、provenance、确定性打包脚本 | release/security/package gates |

## 原始异常的闭锁链

```text
Provider enabled-thinking tool call
→ non-empty reasoning_content 缺失
→ provider_protocol（确定性、不可重试）
→ task/attempt infrastructure abort
→ same-attempt Provider I/O block
→ verified Harness process-group termination
→ redacted evidence retained
→ Provider usage unchanged after fault
→ split-memory task-shape unchanged
```

对应实现主要位于 `thinking-policy.ts`、`monitor-daemon.ts`、`worker.ts`、`infrastructure-failure.ts` 与 `process-identity.ts`；端到端回归为 `provider-protocol-fail-fast.test.ts`。

## 当前重资格状态

本地修复矩阵没有用 fixture 冒充真实 Provider。操作员授权后，本修订真实 Minimal/Pro smoke 已独立通过并写入 `evidence/09`；旧 `evidence/03` 不参与当前 stable 绑定。普通源码/provenance、两次确定性 ZIP 字节比较及解压复验完成前，状态继续保持 candidate。
