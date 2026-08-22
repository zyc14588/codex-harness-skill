# 风险登记

| ID | 风险 | 概率 | 影响 | 控制措施 |
|---|---|---:|---:|---|
| R-01 | installed runtime 与源码树不一致 | 高 | P0 | 回收 runtime/profile/preset 并散列；检查 MCP 和 monitor 实际路径 |
| R-02 | auxiliary 分类继续依赖 prompt 启发式 | 高 | P0 | 采用 runner arm 状态与 request ordinal；辅助请求显式审计 |
| R-03 | Agent 可见工具未进入 wire request | 中高 | P0 | 四层工具快照；新增 serialization mismatch 类型 |
| R-04 | `tool_choice=required` 在 thinking 模式不兼容 | 中 | P1 | 仅对正式 mutation request 临时关闭 thinking；保留原请求副本 |
| R-05 | 文本恢复器误执行普通代码示例 | 中 | P0 | 只允许完整响应、已披露工具、明确 mutation 合同；不作为主修复 |
| R-06 | 基础设施故障污染 split-memory | 低（已修） | P1 | 保留 schema v3 attribution 和 non-learnable 规则 |
| R-07 | Doctor 再次静态 PASS、真实请求失败 | 高 | P0 | 增加动态 minimal request-path probe |
| R-08 | 为修工具平面而放宽 scope/Git 门禁 | 中 | P0 | 明确 non-goal；现有门禁不得降级 |
| R-09 | 真实 Provider smoke 被 fixture 替代 | 高 | P0 | stable release 必须有真实机器证据 |
| R-10 | 调试日志泄露 prompt、密钥或工具参数 | 中 | P0 | 只记录字段名、计数、工具名称和 hash；统一脱敏测试 |
| R-11 | 并行 worker 混淆 request/task 归属 | 中 | P1 | task proxy token、request ordinal、budget group 和 task ID 绑定 |
| R-12 | 修复期间重复调用消耗预算 | 中 | P1 | 先本地 mock，再单次真实 smoke；失败不自动 repair |
