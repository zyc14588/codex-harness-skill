# Codex 严格验收提示词：0.6.5 候选修复

你是独立验收者。不要修改任何文件。不要相信施工会话的总结；只接受源码、运行证据、Git diff、日志和可复现命令。

## 必验项目

1. **来源与一致性**：source、dist、source map、package/plugin/renderer/marker/MCP/runtime version 一致；说明 0.6.4 runtime 如何恢复；不含秘密。
2. **根因闭环**：能解释 `0 Token + forceCount=0 + minimal_tool_plane`；不依赖扩大文本执行启发式。
3. **请求工具平面**：使用真实 managed profile/preset 运行动态 mock probe，核对 runner scoped、assembled、wire、proxy 四层 tools。
4. **请求分类**：auxiliary 在 policy 前分类；primary mutation 触发 force；impossible-state test 存在。
5. **门禁**：input/output Token 唯一硬门禁；API/cost 只参考；infrastructure failure 不改变 split advice；无 diff 不 review/verify/commit；scope/Git/fingerprint 不退化。
6. **Deterministic tests**：clean build、unit、process E2E、stdio MCP、install/migration/rollback/reinstall/uninstall、package hygiene、deterministic ZIP ×2、unpack revalidation。
7. **真实机器 smoke**：必须看到真实 Harness + DeepSeek Provider 证据：forceCount、forcedTools、native/recovery、exact changedPath、approved review、PASS verification、equal fingerprints、local commit、cleanup、main unchanged。

没有真实 smoke，最高只能是：

```text
PASS_WITH_CONDITIONS / REAL_MACHINE_PENDING
```

## 输出格式

```text
Result: PASS / FAIL / PASS_WITH_CONDITIONS
P0 blockers
P1 findings
P2 observations
Executed commands and exit codes
Evidence paths and hashes
Real-machine smoke verdict
Release recommendation
```

发现任何 P0 即 FAIL。不得边验收边修复。
