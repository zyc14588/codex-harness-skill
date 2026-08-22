# 安全与治理

## 1. 不可绕过门禁

Token-only budget policy不影响以下硬门禁：

- Harness commit/build provenance；
- 原始仓库干净启动；
- 固定 base commit；
- DAG、并发配额和互斥写租约；
- `.git`、路径穿越、symlink、gitlink、`.gitmodules`；
- worker 不得 stage/commit/merge/rebase/cherry-pick/push/tag；
- HEAD/index 漂移；
- runtime timeout、取消、orphan；
- Codex 逐文件审查；
- reviewed/current/verified fingerprint；
- 冻结验证命令；
- 禁止自动 merge/push。

## 2. Token 门禁与参考指标

硬门禁只有：

```text
cumulative input tokens
cumulative output tokens
```

API calls、CNY/USD estimate、runtime ratio 用于监控、告警和拆分学习，不直接授予或撤销模型执行权限。金额人工对账只修正展示，不修改 usage 或 Token gate。

## 3. 拆分记忆可信边界

记忆是启发式工程控制，不是正确性证明。Codex仍须检查当前仓库和任务合同。防护措施：

- 按仓库和任务族隔离；
- stage-specific 幂等；
- 有界 recent events；
- 低样本不强制；
- override 必须显式留证；
- 不保存 prompt/response 正文、API Key 或代理 token；
- scope/Git 安全失败不能被后续成功抵消。

## 3.1 工具协议恢复安全边界

工具协议恢复不是任意文本执行器。DSML 仅在完整、确定、已披露工具的条件下恢复；Markdown Shell 恢复还必须同时证明请求是 Bridge 生成的 mutating bounded leaf、写租约非空、整个响应只有一个独立 Shell 围栏。

- 响应含完整、可确定解析的 invoke/parameter 结构；
- 工具名存在于该 Provider 请求的 `tools` 目录；
- 参数可解析为有界 JSON object；
- 调用数量和参数总量未超过 Bridge 限制；
- DSML 标记不位于 Markdown 代码围栏；
- Markdown Shell 的 `bash/pwsh` 工具已在请求目录中披露；
- Markdown Shell 围栏没有周边说明、额外围栏或其他歧义内容。

任何残缺、重复参数、未披露工具、不支持媒体类型或歧义响应均 fail-closed。恢复命令与模型原生 Shell 工具调用具有相同权限边界；最终安全性仍由任务租约、工具 guard、sandbox、Git 门禁和 Codex 审查共同决定。

## 4. 极简模式工具

渐进工具服务器只监听 stdio，由任务 token/record 绑定。能力必须同时满足：

- 叶子合同允许；
- 任务仍活动；
- 参数和路径在界限内；
- verification 只能调用冻结命令索引；
- Git 工具只读。

动态工具披露不是权限提升；它只是延迟公开已授权工具 Schema。

## 5. 网络与沙箱

Bridge 阻断 Harness 标准搜索端点，并在任务合同中禁止网络工具，但 `workspace-write` 不是完整网络/进程隔离。处理敌对仓库或秘密环境时应额外使用容器/VM、最小凭据和网络策略。

## 6. 并发风险

Git worktree 管理操作通过仓库锁串行，模型施工可并行。并发叶子必须避免：

- 相同/父子租约；
- 隐式共享生成文件；
- 同时修改锁文件、schema registry 或全局配置；
- 未冻结接口就并行实现两端。

无法证明独立时，应使用依赖边串行执行。
