# 0.6.5 runtime hotfix R3 预封印验证报告

验证日期：2026-08-23。修订：`dashboard-auth-budget-ux-r3-stable`。

本报告记录最终 ZIP 构建前的 R3 资格。最终是否可安装仍以包内 `release-status.json`、`MANIFEST_SHA256.txt` 和 ZIP sidecar 为准。

| 项目 | 结果 |
|---|---|
| TypeScript strict build | PASS |
| unit/component | PASS，89/89 |
| direct acceptance | PASS |
| security acceptance | PASS |
| skill validation | PASS |
| transactional package acceptance | PASS |
| Dashboard desktop 1440×1000 | PASS |
| Dashboard mobile 390×844 | PASS，无横向溢出 |
| 内嵌认证/无原生 prompt | PASS |
| 未认证预算说明/认证后预算字段 | PASS，12 个全局预算字段 |
| operator password rotation | PASS，旧密码失效、新密码生效 |
| 匿名 HTML/控制台 | PASS，无 secret、无 console error |

实现资格基线为 commit `221d7a0c83919b3d86e6efa0607117df83c271dd`，outer tree `55501d97d953e6510a2b6d52f91bbfd3c9fe9f7a`，source tree `21e79c45b350be74b3eb0f8ac8b33a11bc308e63`。

Package acceptance 在隔离临时 HOME/XDG/CODEX_HOME 中验证 fresh install、schema 4→7 迁移、同版本和跨版本注入失败回滚、重装、卸载、MCP 注册以及包卫生。没有修改用户当前安装。

R3 没有改动 Provider/Harness/Broker 请求路径，本轮也没有发起真实 Provider 请求：API calls 0、tokens 0、费用 0。R2 的有界真实 DeepSeek 证据保留在 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`，仅作为未修改执行路径的继承回归证据，不表述为 R3 重新调用。R3 本地与浏览器机器证据见 `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`。
