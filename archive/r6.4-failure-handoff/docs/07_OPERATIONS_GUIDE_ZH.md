# 操作指南

## 1. 解压与校验

```bash
unzip CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1.zip
cd CODEX_HARNESS_BRIDGE_R6_4_FAILURE_HANDOFF_R1
./scripts/verify-package.sh
```

## 2. 回收本机证据

```bash
./scripts/capture-installed-r6-4.sh \
  --task-id plan-1787365388387-r6-4-minimal-aux-isolation-smoke
```

默认输出 `recovered-local/`，权限为 owner-only。提交到 Git 前必须人工检查是否含敏感信息。

## 3. 检查输入

```bash
./scripts/inspect-repair-inputs.sh
```

重点观察 installed runtime version、profile/preset marker version、`session-title-llm` 状态、`auxiliary` classifier、`minimal mutating leaf has no disclosed core mutation tool` 所在控制流，以及 task evidence 中的 request/tool telemetry。

## 4. 启动 Codex

```bash
codex
```

粘贴 `prompts/00_CODEX_MASTER_REPAIR_PROMPT_ZH.md` 全文。

## 5. 施工后验收

使用全新 Codex 会话，只粘贴 `prompts/01_CODEX_STRICT_ACCEPTANCE_PROMPT_ZH.md`。验收人员不得修改文件；发现问题即 FAIL。

## 6. 最终审计

验收 PASS 后再使用 `prompts/02_CODEX_POST_REPAIR_AUDIT_PROMPT_ZH.md`。审计结果、真实 smoke 证据、release ZIP 和 SHA-256 应一次性打包交付。
