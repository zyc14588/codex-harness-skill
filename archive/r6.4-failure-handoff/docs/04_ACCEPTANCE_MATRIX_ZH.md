# 修复验收矩阵

## A. Provenance

- [ ] 精确回收 installed runtime 0.6.4；
- [ ] runtime、profile、preset 和 task evidence 全部生成 SHA-256；
- [ ] 确认 Codex MCP 实际指向哪个 runtime；
- [ ] 确认 monitor PID 实际加载哪个模块路径；
- [ ] 确认 managed marker version 和内容。

## B. 静态代码

- [ ] TypeScript strict build；
- [ ] unit tests 全通过；
- [ ] no runtime npm dependencies；
- [ ] request classifier 在 policy 前执行；
- [ ] no secret logging；
- [ ] impossible-state invariant 覆盖；
- [ ] source/dist/version/profile marker 一致。

## C. 动态 minimal tool-plane probe

- [ ] runner scoped tools 包含 `bash` 或 `pwsh`；
- [ ] runner scoped tools 包含 `str_replace_editor`；
- [ ] assembled tools 与 runner snapshot 一致；
- [ ] wire request tools 至少包含一个 core mutation tool；
- [ ] proxy parser 得到相同 tool names；
- [ ] auxiliary request 不触发 mutation force；
- [ ] primary mutation request 触发 force。

## D. Failure attribution

- [ ] composition 缺工具 → `minimal_tool_plane_composition`；
- [ ] runner 有工具但 wire 丢失 → `minimal_tool_serialization_mismatch`；
- [ ] Provider 违反 required → `tool_protocol`；
- [ ] 工具执行但无副作用 → `no_effect`；
- [ ] 所有基础设施故障不改变 split advice。

## E. Deterministic E2E

- [ ] mock auxiliary request；
- [ ] mock primary mutation request；
- [ ] native tool call；
- [ ] strict recovery call；
- [ ] exact changed path；
- [ ] collect/read/review/verify/fingerprint/commit；
- [ ] parallel minimal tasks；
- [ ] input/output Token hard gate；
- [ ] API/cost reference-only alert；
- [ ] install/migration/rollback/uninstall。

## F. 真实机器 E2E

- [ ] 使用固定 Harness commit 和真实 DeepSeek key；
- [ ] 新 taskFamily，避免旧记忆混入；
- [ ] 精确单文件租约；
- [ ] force counter ≥ 1；
- [ ] forced tools 非空；
- [ ] native/recovery evidence 非空；
- [ ] changedPaths 精确一致；
- [ ] JSON 内容验证；
- [ ] review approved；
- [ ] verification PASS；
- [ ] 三 fingerprint 一致；
- [ ] 本地 commit；
- [ ] worktree 清理；
- [ ] main 不变；
- [ ] 不 merge/push/publish。

## G. 发布判定

只有 A–F 全部通过，才能：

```text
RC → stable
```

任何真实机器失败都必须：

```text
FAILED / WITHDRAWN
```
