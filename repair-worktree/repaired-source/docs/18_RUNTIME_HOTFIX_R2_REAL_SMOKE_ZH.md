# 0.6.5 runtime hotfix R2 真实 DeepSeek smoke

> 历史且仍受哈希保护的 R2 证据。R3/R4 未修改 Provider/Harness/Broker 执行路径，故将本结果作为继承回归证据保留；R3/R4 没有重新调用真实 Provider，也不把本报告表述为当日 smoke。

执行日期：2026-08-23。结果：`PASS`。脱敏机器证据：`evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`。

## 授权、数据与凭据边界

操作员授权发布前的有界真实 DeepSeek Minimal Flash 与 Pro Thinking 冒烟及相应外部传输/API 费用。测试只使用临时合成 Git 仓库和固定的短文本复制/校验任务，不发送本项目源码、用户仓库内容、credential 或 reasoning 正文。

父信任域从 operator-owned、mode-0600 文件读取凭据；Bubblewrap 内 Harness 只获得一次性任务 token，并通过认证 Unix-socket relay 访问本地 Broker。证据文件为 mode 0600，敏感串扫描未发现 API key、Bearer、prompt seed 或 reasoning 正文。

```text
Harness commit: 141eb6fef83422698aef7a981029e843e8161534
Harness build SHA-256: 6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38
Bubblewrap SHA-256: 0abea81db798ebf6b4742ac0664802d97521547a353c2a0dbdc21d76cbbfd2c0
```

## 结果

- Flash：同一 attempt 4 次 Provider 请求，全部 `thinking=disabled` 且无 `reasoning_effort`；3 次原生工具调用、2 次 mutation force、0 次协议恢复。
- Pro：同一 attempt 4 次 Provider 请求，全部 `thinking=enabled/high` 且无 `tool_choice`；请求回放深度为 0/1/2/3，3 条非空 Provider reasoning requirement 只保存哈希与字节长度，3 次原生工具调用、0 次协议恢复。
- 两任务 changed path 精确，review approved，reviewed/current/verified fingerprint 一致，并各自在隔离分支形成 local commit。
- 两个 worktree 与分支均已清理；临时 smoke 主仓库 HEAD 不变且 clean；没有 merge、push、tag 或创建 release。

该 PASS 只关闭真实 Provider 门禁，不能替代其他门禁；普通源码/provenance 与最终确定性 ZIP/解包复验随后已独立通过。
