# 仓库与 Git 历史披露边界（DEC-002）

Owner 已批准 `A_ACCEPT_REPOSITORY_AND_HISTORY_READ_BOUNDARY`。Harness 可以读取当前任务的完整 worktree 与 Git history；这些 repository/history 内容可以通过受控 Provider Broker 提供给 configured remote model。这是一个 **accepted disclosure boundary**，不是 confidentiality boundary。

批准不扩张宿主读取范围。历史读取工具只能在 Bridge 为当前任务绑定的仓库中运行，必须经过 Broker 与 Bubblewrap；不得挂载或读取宿主其他仓库、`stateRoot`、Monitor socket、Provider/Adapter/Tool bearer、环境凭据或秘密文件。出站网络仍只允许到受控 Provider Broker。

`git_history` 只接受固定的 `log`、`show`、`blob` 操作、受限 revision/path 和显式 `all_refs` 选择。所有模型可见输出采用 UTF-8 安全的字节分页，每页最多 49,152 bytes（估算上限 12,288 tokens），并返回下一页 offset、完整字节数与截断状态。工具调用与进程身份进入任务审计记录。

该选择不能使仓库中的秘密变得可接受：`.env`、凭据、私钥和 bearer 仍不得进入 Git。公开仓库/历史审计及 Owner 风险接受现为 `PASS_WITH_OWNER_ACCEPTED_HISTORICAL_FINDINGS`；历史读取仓库约束、Provider/Adapter/Tool capability 隔离、`stateRoot`/宿主路径/Monitor socket 隔离、49,152-byte 分页上限与负向隔离测试均已验证，因此 `DEC-002.implementationVerified=true`。这不会解除 candidate、主机 cgroup、Provider、GitHub CI 或 branch governance 门禁。
