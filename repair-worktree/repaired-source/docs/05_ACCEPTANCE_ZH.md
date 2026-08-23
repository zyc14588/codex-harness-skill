# 0.6.5 stable 严格验收清单

Runtime hotfix R4 已完成 stable 封印。本清单是给独立审计者逐项重跑的空白清单，不以勾选框代替证据；权威机器状态取自 `release-status.json`。evidence/08 是 R4 当前本地/浏览器/包资格，evidence/09 是 Provider 路径未修改时继承的 R2 有界真实回归证据。

## 构建

- [ ] TypeScript strict build；
- [ ] `bridge/dist` 从空目录重建；
- [ ] JSON、JSON Schema、Shell 和内联 JavaScript 检查；
- [ ] runtime 不含 npm dependencies / `node_modules`；
- [ ] 当前 90 项单元/组件测试全部通过。

## Dashboard 认证与费用治理

- [ ] 首次打开不产生原生 `prompt`，页面内显示操作员认证；
- [ ] 未认证费用页解释全局/任务预算字段需要登录，并禁用身份变更操作；
- [ ] 认证后显示 12 个全局预算字段以及任务预算字段或明确空状态；
- [ ] “设置 → 操作员认证”可轮换至少 6 个 Unicode 字符、无空白的密码；
- [ ] 5 字符被拒绝、6 位数字和 6 个中文字符被接受，Provider API key 仍要求至少 24 字节；
- [ ] 轮换后旧密码 401、新密码立即有效，响应与匿名 HTML 不回显 secret；
- [ ] desktop/mobile 无 console error，390×844 无横向溢出。

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

## 0.6.5 显式请求状态机、工具协议与空变更

- [ ] Bridge 管理的 minimal headless profile 显式禁用 `session-title-llm`；
- [ ] stock runner disabled、Bridge runner 以独立 ID mounted，dump 无 mismatch/skip；
- [ ] auxiliary purpose 由 runner 在 adapter 入口记录，并在 policy 前透传；
- [ ] runner visible、assembled、adapter、wire 与 proxy parsed 工具列表相同；
- [ ] runner 缺 core 归因 composition；runner 有 core 但 wire 缺失归因 serialization；
- [ ] 标题辅助请求之后的主 Agent 请求仍触发 `minimalMutationForceCount>=1`；
- [ ] Dashboard/任务状态显示辅助请求隔离次数、类型和最近时间；
- [ ] 首个无 diff 的 minimal Flash 变更请求包含 `tool_choice=required`；
- [ ] Minimal Flash 同一 attempt 的每个请求均为 disabled，Provider wire 均省略 `reasoning_effort`；
- [ ] Pro 同一 attempt 的每个请求均为 enabled/high 且没有 `tool_choice`；
- [ ] Pro assistant tool-call message 保留真实非空 reasoning，后续请求按 SHA-256/长度完整回放；
- [ ] 一旦 worktree 出现真实 diff，可停止 mutation `tool_choice=required` 强制，但 Flash thinking 仍在整个 attempt 保持 disabled；
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
- [ ] tool/thinking/replay/provider/transport/no-effect infrastructure 不缩小拆分画像；
- [ ] split-memory schema-v1/v2/v3/v4 被隔离并归档；schema 5 零样本基础设施画像不改变当前 advice。

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
- [ ] schema v4/v5/v6 → v7 安全迁移；
- [ ] same-version 和 cross-version rollback；
- [ ] 最终 ZIP 无 traversal、duplicate、symlink；
- [ ] manifest 全文件校验；
- [ ] 两次确定性构建 byte-identical；
- [ ] 从最终 ZIP 解压后重跑全验收。
