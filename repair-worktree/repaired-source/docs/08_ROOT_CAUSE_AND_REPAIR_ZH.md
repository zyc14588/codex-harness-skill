# 0.6.5 根因与修复报告

## 历史第一根因：0.6.4 managed runner 未生效

0.6.4 的 Cordis patch 试图在 stock `headless-runner` 上替换 `name`。Harness 把 `name` 当作身份守卫，发现 mismatch 后跳过整条 patch。有效配置仍运行 stock runner，Bridge preset 和 scoped tools 未进入请求，mutation 请求以空工具面到达代理。

rc.1 采用正确组合：禁用 stock runner，再插入独立 ID 的 Bridge runner；doctor 审核真实 dump-config，五层工具目录和 native tool call 随后通过真实 smoke。

## 发布阻断主根因：rc.1 在同一 attempt 切换 thinking

rc.1 的 minimal mutation policy 是逐请求策略。无 diff 时它把请求改为 Flash/disabled；出现 diff 后直接返回原始请求对象，第三轮恢复为 enabled/high/auto。前两轮 assistant tool-call 历史来自 disabled 模式，没有 Provider 要求的 reasoning replay。DeepSeek 在第三轮返回：

```text
INVALID_REQUEST: The reasoning_content in the thinking mode must be passed back to the API.
```

失败还被旧 split-memory 错归因为 task shape。增加预算、删除工具历史、补空 reasoning 或用 mock PASS 覆盖都不能修复协议状态，因此均被禁止。

## 最小可靠修复

1. worker 创建 attempt 时冻结 `deepseek-v4-flash → disabled/off` 或 `deepseek-v4-pro → enabled/high`。
2. Minimal Flash 即使已有 diff 也保持 disabled，并从 Provider wire 省略 `reasoning_effort`。
3. Pro 每轮省略 `tool_choice`；从真实 Provider 工具响应捕获 reasoning 哈希、长度和 tool-call IDs。
4. 后续请求在 Provider 前校验完整历史 assistant message 和原 reasoning；缺失、空或篡改均 fail-closed。
5. Provider 协议、thinking state/replay 和既有工具/传输/no-effect 统一归为 infrastructure。
6. split-memory 升到 schema 4，隔离 schema 1–3；规范化默认 Flash key；零样本基础设施画像保留当前提议预算。

## 修复过程中发现并关闭的次级根因

- 动态 Pro 首轮仍由 Harness 默认选择 Flash：runner 改为使用 Bridge-owned attempt model/effort。
- deterministic fake Harness 仍发旧 generic request shape：只修夹具，不放松 production preflight。
- direct acceptance 仍断言旧 policy version：更新精确期望。
- 默认 Flash 与显式 Flash 生成不同 memory key：统一规范化。
- infrastructure-only profile 虽 sample=0，仍把失败任务预算用于 advice：sample=0 时使用当前候选提议。
- 失败注入任务未转 terminal 导致 cleanup 失败：断言后显式保存预期失败终态。

每项失败都先保留 `.repair/evidence`，再增加稳定复现、实施最小修复并从窄测试跑回完整门禁。

## 当前因果证明

- 回归 83 项全部通过；
- dynamic Flash 4 轮全 disabled，dynamic Pro replay 深度 0/1/2；
- replay 缺失在 Provider 前失败，调用 0、Token 0/0、split 不变；
- 当前动态真实 Harness + 本地可观测 Broker 中，Flash 4 轮全 disabled，Pro 3 轮全 enabled/high/no tool-choice 并回放 0/1/2；
- 2026-08-22 的历史真实 Flash/Pro smoke 只保留在 Git 历史；2026-08-23 当前安全边界下的 Flash/Pro smoke 已作为当前 stable gate 通过；
- 当前修订的真实双模式 smoke 仍需操作员明确授权；
- package acceptance 覆盖安装、升级、回滚、重装和卸载。

因此主因不是 Token 不足或任务过大，而是 attempt 内协议模式不一致；当前修订已在 Provider 边界前建立不可变、可审计、失败封闭的状态机，并通过真实 smoke、artifact bindings 与归档门禁，已升级为 stable。
