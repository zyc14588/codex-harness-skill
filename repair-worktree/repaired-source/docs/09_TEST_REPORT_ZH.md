# 0.6.5 runtime hotfix R2 测试报告

报告状态：`DELIVERABLE_PASS / stable`。历史 stable 的 evidence/03–07 保留但不参与本修订的 stable 绑定；本修订使用 evidence/08 与 evidence/09。

| 层级 | 结果 |
|---|---|
| strict build + unit/component | PASS，87 项 |
| direct process E2E | PASS |
| pinned Harness + local observable Provider | PASS |
| reasoning replay failure injection | PASS，Provider 0、Token 0/0 |
| security acceptance | PASS |
| stdio MCP acceptance | PASS |
| package acceptance | PASS，源码、预封印解包态与最终 stable 解包态 |
| skill validation | PASS |
| real DeepSeek Minimal | PASS，4 轮、3 次原生工具调用 |
| real DeepSeek Pro | PASS，4 轮、replay 0/1/2/3 |
| deterministic ZIP/unpacked gate | PASS |

## 关键覆盖

- Dashboard 取消/401 后停止令牌自动重弹，显式按钮恢复认证；403 不删除有效 Bearer；
- installer 固定 `process.execPath`，doctor 与 Bubblewrap 启动前校验 managed preset Node；
- managed MCP 同步失败归类 `minimal_tool_plane_composition`；
- split-memory schema 5 隔离 schema 1–4，基础设施与 `no_effect` 不缩小任务建议；
- operator Bearer、Origin/CSRF、私有 secret 文件与 UDS task token；
- Bubblewrap read/network/PID/mount 隔离、Provider key 不可见、`.env*` 拒绝；
- Flash attempt immutable disabled；Pro enabled/high、无 tool choice、完整 reasoning replay；
- `provider_protocol` 首次闭锁，canonical 请求估算与 malformed JSON Provider 0；
- candidate/stable/withdrawn release gate 与当前证据 SHA-256 bindings；
- fresh install、schema 4→7、同版本/跨版本回滚、重装、卸载、包卫生。

## 证据与包验收

`evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json` 绑定 87 项回归、direct/security/skill/package、动态真实 Harness 和零 I/O 失败注入。`evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json` 绑定本修订真实 Flash/Pro，且不包含 credential、prompt 或 reasoning 正文。

`scripts/package-acceptance.sh` 在临时 HOME/XDG/CODEX_HOME 中验证安装、doctor、installed tests、stdio MCP、迁移、双回滚、重装与卸载。最终 ZIP 解包后重新执行同一验收；`bridge/node_modules`、symlink 与 secret 均不进入包。
