# 0.6.5 当前修订真实 DeepSeek smoke

当前状态：`BLOCKED_EXTERNAL_AUTHORIZATION_REQUIRED`。

## 为什么历史 PASS 不够

2026-08-22 的双模式真实 smoke 已保存在 `evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json`。它验证过 Flash/Pro 多轮行为，但早于 2026-08-23 新增的 Provider credential Broker、强制 Bubblewrap、进程身份和 release gate，因此只作为历史证据，不计入当前稳定发布。

## 待执行范围

`bridge/dist/real-provider-smoke.js` 将：

- 创建全新的临时 Git 仓库；
- 只写入一行固定 seed 的 `README.md`；
- 分别运行 Minimal Flash 与 Pro Thinking；
- 提示模型用有界工具读取 README、复制到单个租约文件、执行 `cmp`/`git diff --check`；
- 独立 collect、逐文件读取、review、verify、fingerprint、隔离本地 commit 和 cleanup；
- 不发送当前源码、真实用户仓库文件、credential 或 reasoning 正文。

每叶冻结上限：

```json
{
  "maxApiCalls": 8,
  "maxInputTokens": 100000,
  "maxOutputTokens": 10000,
  "maxCostCnyReferenceAlert": 5
}
```

金额是参考告警而非供应商账单硬限制；执行会产生真实 DeepSeek API 请求和实际费用。

## 凭据与隔离

父信任域从 operator-owned、非 symlink、mode-0600 credential 文件读取 key，写入临时私有 Broker secret；Harness 仅得到 48-hex 一次性 task token。每个 attempt 位于固定 SHA 的 Bubblewrap network/PID/mount namespace，通过受 token 保护的 Unix socket relay 访问 Broker。finally 删除 Broker key、任务 worktree、分支与临时根目录。

## 通过标准

- Flash 同一 attempt 至少 4 个 Provider 请求和 2 个真实工具调用；全部 disabled，无 reasoning effort；
- Pro 同一 attempt 至少 2 个 Provider 请求和 1 个真实工具调用；全部 enabled/high、无 tool choice；
- 每条 Provider reasoning requirement 非空且后续完整回放；
- changedPaths 精确、逐文件 approved、verification PASS、三个 fingerprint 一致；
- 隔离 local commit 后 cleanup，smoke main HEAD/状态不变；
- evidence 不含 key、token、prompt 正文或 reasoning 正文。

只有明确授权、实际执行并通过后，才能把本文件、`release-status.json` 和 evidence/03 更新为当前 PASS。
