# 0.6.5 runtime hotfix R4 测试报告

报告状态：`DELIVERABLE_PASS / stable`。R4 使用 evidence/08 绑定 6 字符密码边界、当前 Dashboard、密码轮换、本地安全、浏览器和包级资格；evidence/09 是 Provider 请求路径未修改时继承的 R2 有界真实回归证据，不表述为 R4 重跑。

| 层级 | 结果 |
|---|---|
| strict build + unit/component | PASS，90 项 |
| desktop/mobile browser QA | PASS |
| operator password rotation | PASS |
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
- 原生 `prompt` 被内嵌认证表单替代，费用页在认证前解释预算字段条件，认证后显示全局字段和任务预算/空状态；
- 设置页可安全轮换 operator password，旧密码立即失效、私有文件原子替换、并发陈旧请求闭锁；
- operator password 5 字符拒绝、6 位数字和 6 个中文字符接受；Provider API key 的 24 字节下限不变；
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

`evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json` 绑定 90 项回归、direct/security/skill/package 和桌面/移动浏览器验证。`evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json` 绑定 R2 的真实 Flash/Pro，且不包含 credential、prompt 或 reasoning 正文；R4 Provider 请求路径未变，本轮 API calls/tokens/cost 均为 0。

`scripts/package-acceptance.sh` 在临时 HOME/XDG/CODEX_HOME 中验证安装、doctor、installed tests、stdio MCP、迁移、双回滚、重装与卸载。最终 ZIP 解包后重新执行同一验收；`bridge/node_modules`、symlink 与 secret 均不进入包。
