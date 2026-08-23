# R6.4 严格验收清单

## 构建

- [ ] TypeScript strict build；
- [ ] `bridge/dist` 从空目录重建；
- [ ] JSON、JSON Schema、Shell 和内联 JavaScript 检查；
- [ ] runtime 不含 npm dependencies / `node_modules`；
- [ ] 60 项单元测试通过。

## Token 门禁

- [ ] input 超限阻止后续请求并生成 marker；
- [ ] output 超限阻止后续请求并生成 marker；
- [ ] API calls 超参考值但任务继续；
- [ ] CNY/USD 超参考值但任务继续；
- [ ] Pro complex 有硬 input/output gates；
- [ ] Web 活动预算调整在下一次检查生效。

## 自适应拆分

- [ ] `controller_split_advice` 无历史时返回原始建议；
- [ ] plan 持久化 `splitDecision`；
- [ ] Token overrun、timeout/failure、fallback/repair、review、verification 各自更新；
- [ ] 相同 task/stage 幂等；
- [ ] 异常后建议缩小 complexity/scale；
- [ ] 稳定低占用成功后保守扩大；
- [ ] 置信度达到门槛后拒绝无理由背离；
- [ ] `controller_split_memory` 可读取画像；
- [ ] Dashboard 显示建议与选择。

## R6.4 minimal 工具协议与空变更修复

- [ ] Bridge 管理的 minimal headless profile 显式禁用 `session-title-llm`；
- [ ] 模拟的无工具 first-prompt title 请求被标记为 `session_title_auxiliary` 并透传，不触发 `minimal_tool_plane`；
- [ ] 标题辅助请求之后的主 Agent 请求仍触发 `minimalMutationForceCount>=1`；
- [ ] Dashboard/任务状态显示辅助请求隔离次数、类型和最近时间；
- [ ] 首个无 diff 的 minimal Flash 变更请求包含 `tool_choice=required`；
- [ ] 同一请求显式禁用 thinking、移除 `reasoning_effort`，且只保留已披露核心变更工具；
- [ ] 一旦 worktree 出现真实 diff，后续请求恢复原始 Harness 请求形状；
- [ ] Pro、standard、analysis/read-only 和空租约请求不触发强制策略；
- [ ] Dashboard/任务状态显示 `minimalMutationForceCount`、策略版本、工具和时间；
- [ ] 精确具名 JSON、XML、bracket 和 labelled 文本工具调用信封可安全恢复；
- [ ] 普通 JSON、带周边说明或模糊文本信封绝不执行；
- [ ] 完整全角 DSML 被恢复为原生 streamed `tool_calls`；
- [ ] 缺少外层起始标记但 invoke 完整时可安全恢复；
- [ ] 代码围栏中的 DSML 示例不执行；
- [ ] 未披露工具、残缺参数或无法确定解析时 fail-closed；
- [ ] 已合法结构化的 tool call 原样透传，不虚增 recovery 计数，并记录 native call 数量与工具名；
- [ ] 有写租约的 mutating leaf 返回单一独立 Markdown Shell 围栏时，安全恢复为原生工具调用并实际落盘；
- [ ] 带周边说明、多围栏、空命令、非变更模式或空租约的 Markdown Shell 不执行；
- [ ] implementation/test/repair 空 diff 以 `no_effect` 失败，不进入 review/verification；
- [ ] `completed_no_changes + changedPathCount=0` 不增加 sample/success，不放大 leaf scale 或 Token 建议；
- [ ] worker PID 首次消失不会抢在终态发布前误判 orphaned；只有宽限期后的第二次死进程观测才允许 orphan；
- [ ] minimal runner 在首个模型请求前核验 Shell、编辑器与渐进式工具；
- [ ] DSML 恢复后实际产生租约内文件、diff、review、verification 和本地提交；
- [ ] `tool_protocol` / `minimal_tool_plane` / `provider_transport` 不缩小拆分画像；
- [ ] R6.0 schema-v1 与 R6.1 schema-v2 旧画像被归档；R6.2/R6.3 schema-v3 基础设施事件不改变 R6.4 advice。

## R5 能力保留

- [ ] 两个互斥 Pro minimal complex leaves 同时 `running`；
- [ ] DAG 未满足时拒绝启动；
- [ ] 并发上限生效；
- [ ] 初始渐进工具只有 catalog/enable；
- [ ] 启用授权能力后收到 tools/list_changed；
- [ ] 未授权能力、越界路径和任意命令被拒绝；
- [ ] profile/preset 安装与卸载只处理 managed 目录。

## 代码接收

- [ ] collect 无越界/symlink/gitlink/index/HEAD 异常；
- [ ] changed files 逐个读取；
- [ ] review decision 已记录；
- [ ] repair 共享 budget group；
- [ ] frozen verification PASS；
- [ ] fingerprints 一致；
- [ ] local commit 仅在 Harness 分支；
- [ ] 不 merge/push；
- [ ] cleanup 保留审计。

## 发布包

- [ ] fresh install；
- [ ] schema v4/v5 → v6 迁移；
- [ ] same-version 和 cross-version rollback；
- [ ] 最终 ZIP 无 traversal、duplicate、symlink；
- [ ] manifest 全文件校验；
- [ ] 两次确定性构建 byte-identical；
- [ ] 从最终 ZIP 解压后重跑全验收。
