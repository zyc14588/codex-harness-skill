# 0.6.5 runtime hotfix R4 预封印验证报告

验证日期：2026-08-23。修订：`operator-password-minimum-6-r4-stable`。

本报告记录最终 ZIP 构建前的 R4 资格。最终是否可安装仍以包内 `release-status.json`、`MANIFEST_SHA256.txt` 和 ZIP sidecar 为准。

| 项目 | 结果 |
|---|---|
| TypeScript strict build | PASS |
| unit/component | PASS，90/90 |
| direct acceptance | PASS |
| security acceptance | PASS |
| skill validation | PASS |
| transactional package acceptance | PASS |
| Dashboard desktop 1440×1000 | PASS |
| Dashboard mobile 390×844 | PASS，无横向溢出 |
| 内嵌认证/无原生 prompt | PASS |
| 未认证预算说明/认证后预算字段 | PASS，12 个全局预算字段 |
| operator password boundary | PASS，5 字符拒绝；6 位数字和 6 个中文字符接受 |
| Provider key boundary | PASS，6 字符拒绝，至少 24 字节规则保留 |
| operator password rotation | PASS，旧密码失效、新密码生效 |
| 匿名 HTML/控制台 | PASS，无 secret、无 console error |

实现资格基线为 commit `e9d6a1cb13409223acedf5632000dbca8e703b51`，outer tree `ab03980dc002a43b5ba74ba6d739ae15096d4223`，source tree `da9dcbb11bae97ac91a056a734c3dcdcb127572d`。

Package acceptance 在隔离临时 HOME/XDG/CODEX_HOME 中验证 fresh install、schema 4→7 迁移、同版本和跨版本注入失败回滚、重装、卸载、MCP 注册以及包卫生。没有修改用户当前安装。

R4 没有改动 Provider/Harness/Broker 请求路径，本轮也没有发起真实 Provider 请求：API calls 0、tokens 0、费用 0。operator password 与 Provider key 的下限已分离，Provider key 仍至少 24 字节。R2 的有界真实 DeepSeek 证据保留在 `evidence/09_RUNTIME_HOTFIX_REAL_DEEPSEEK_REDACTED.json`，仅作为继承回归证据，不表述为 R4 重新调用。R4 本地与浏览器机器证据见 `evidence/08_RUNTIME_HOTFIX_CANDIDATE_LOCAL_VALIDATION.json`。
