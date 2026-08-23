# 0.6.5 原 stable 修订真实 DeepSeek smoke

> 历史封印报告：这里的“当前修订”只指此前封印的 0.6.5 stable，不能复用本报告给后续源码续期。Runtime hotfix R2 已另行通过并记录在 `docs/18_RUNTIME_HOTFIX_R2_REAL_SMOKE_ZH.md` 与 evidence/09。

当前状态：`PASS`。执行日期：2026-08-23。脱敏机器证据为 `evidence/03_REAL_DEEPSEEK_0_6_5_STABLE_REDACTED.json`。

## 授权与发送范围

操作员明确授权真实 DeepSeek Minimal Flash + Pro smoke、相关外部传输和 API 费用。脚本创建全新的临时 Git 仓库，只写入一行固定 seed 的 `README.md`，提示模型用有界工具读取、复制并比较该文件。没有发送当前项目源码、用户仓库文件、credential 或 reasoning 正文。

每叶冻结上限：

```json
{
  "maxApiCalls": 8,
  "maxInputTokens": 100000,
  "maxOutputTokens": 10000,
  "maxCostCnyReferenceAlert": 5
}
```

金额是参考告警而非供应商账单硬限制；累计 input/output Token 仍是模型用量硬门禁。

## 凭据与隔离

父信任域从 operator-owned、非 symlink、mode-0600 credential 文件读取 key，写入临时私有 Broker secret；Harness 仅得到 48-hex 一次性 task token。每个 attempt 位于固定 SHA 的 Bubblewrap network/PID/mount namespace，通过受 token 保护的 Unix socket relay 访问 Broker。finally 删除 Broker key、任务 worktree、分支与临时根目录。

```text
Harness commit: 141eb6fef83422698aef7a981029e843e8161534
Harness build SHA-256: 6a294d72c51e6570852acaf73458cda98f555bd53c9c7ff0b49c568e7cf88a38
Bubblewrap SHA-256: 0abea81db798ebf6b4742ac0664802d97521547a353c2a0dbdc21d76cbbfd2c0
```

## Minimal Flash 结果

- 同一 attempt 共 4 个 Provider 请求，满足最低 4 轮；
- 全部 `thinking.type=disabled`，全部省略 `reasoning_effort`；
- 3 次原生结构化工具调用，0 次文本/DSML 恢复；
- changed path 精确为 `real-flash-multiturn.txt`；
- review approved，reviewed/current/verified fingerprint 一致；
- 隔离 local commit 完成后 worktree 与 branch 均已清理。

## Pro Thinking 结果

- 同一 attempt 共 4 个 Provider 请求；
- 全部 `thinking.type=enabled`、`reasoning_effort=high`，全部省略 `tool_choice`；
- 请求回放深度依次为 0/1/2/3；
- 三条 tool-call reasoning requirement 均为 Provider 返回的非空载荷，后续请求逐条完整回放；
- 证据只保存 Provider 派生 SHA-256、UTF-8 字节长度、序号与回放次数，不保存 reasoning 正文；
- 3 次原生结构化工具调用，0 次协议恢复；
- changed path 精确为 `real-pro-thinking.txt`，review/verify/fingerprint 全部一致；
- 隔离 local commit 完成后 worktree 与 branch 均已清理。

## 仓库与发布边界

smoke 临时主仓库的 HEAD 前后一致且 clean；Bridge 未 merge、push、tag 或创建 release。此真实门禁与 artifact bindings、确定性 ZIP 双构建及解压复验共同构成当时的 stable 封印。
