# Provider protocol attempt fail-fast 热修订

> 历史修订报告：此文档记录此前 stable 封印前的 fail-fast 修复。后续 runtime hotfix R2 的独立重资格状态以 `release-status.json` 为准。

修订：`provider-protocol-fail-fast-r1`
基线：Bridge `0.6.5`
日期：2026-08-23

## 问题与根因

Pro enabled-thinking 响应包含原生工具调用时，Provider 必须同时返回真实、非空的 `reasoning_content`。原 Bridge 已能识别缺失并记录 `provider_protocol`，但只向 Harness 返回普通 502。Harness 因而把它当作可重试错误并继续同一对话，产生额外 Provider 请求；任务即使后来形成 diff，也因 sticky infrastructure failure 在终态被拒绝。

## 修复语义

1. 首次违规响应仍按 Provider 返回的真实 usage 精确记账一次，然后返回非重试型 HTTP 422；
2. `provider_protocol` 等确定性 attempt 协议状态一旦落盘，同 attempt 的后续代理请求会在读取请求体、追加 usage 或发起 Provider I/O 前返回 422；
3. worker 轮询任务状态，观察到确定性 attempt 协议故障后向 Harness 进程组发送终止信号，并保留最终 Git/scope、usage、execution-attempt 与 split-memory 证据；
4. 即使 Harness 在竞态中以 0 退出，execution attempt 仍记录为 `failed`；
5. `provider_transport` 保持可恢复，`no_effect` 仍只在执行结束后判定；
6. Bridge 不生成、补空、总结、剥离或修改 Provider reasoning。

## 验证

- strict TypeScript build：PASS；
- unit/component：PASS，83 项；
- loopback Provider fault injection：PASS，首次请求 422、Provider 调用 1 次、usage 1 次、后续同 attempt Provider 调用 0 次；
- direct acceptance：PASS，worker 在 8 秒内终止故意驻留的 fake Harness，任务与 attempt 均失败且 diff 为空；
- stable package acceptance 与安装态 fault injection：PASS。

2026-08-22 的真实 Provider smoke 只留在历史中，未被该热修订冒充为当时证据。操作员授权后，2026-08-23 当时封印修订的真实 Flash/Pro smoke、最终 ZIP 与解压复验均 PASS；这些结论不覆盖后续源码。Runtime hotfix R2 已用 evidence/08、09 与独立最终归档重新取得资格。
