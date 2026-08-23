# 0.6.6 候选安全与治理

## Provider capability

Provider key 永远只在 Monitor 中读取。Harness 只接收一次性的 Adapter Provider bearer；URL 仅含非秘密 task/attempt ID。Provider、request-state 与 tool bearer 长度/用途各异，任何交叉使用返回 403。Relay 与 Monitor 都拒绝 query、fragment、额外 suffix、非 POST、非 JSON 和不受支持的顶层 schema；失败请求不会触达上游。

模型可调用工具不拥有任何 bearer。Bash/Pwsh 由 Host Monitor 在独立 Bubblewrap sibling 中执行，clearenv、private PID/network namespace，不挂载 socket/state/secret。`/proc/*/environ`、argv、文件、Unix socket、loopback relay 与 direct Provider 均不能恢复 capability。

任务 worktree 的读取不是 confidentiality boundary：Bash/editor/repository tools 可读取 worktree 内文件，并可能把工具输出交给远程模型；`contextFiles` 和渐进披露只控制提示与工具可见性，不保证其它仓库文件保密。操作员只能对允许远程 Provider 处理其内容的仓库启用 Harness。未来需要机密分区时应采用 filtered workspace，而不能依赖 prompt。

## Git 与验证

启动冻结 base commit、branch、leases，并拒绝相交 symlink/gitlink/environment paths。Agent 不能 stage/commit。Codex review 必须覆盖全部 changed paths；binary patch 与 fingerprint 封存后，在新的 detached clean worktree 权威验证。ignored poison、cache 与 node_modules 不复制。只有 current/reviewed/verified fingerprint 一致、HEAD/index/lease/symlink/gitlink/cleanup 全通过才可本地提交。

## Operator 与进程

Dashboard API 要求 private bearer；mutation 另要求同源 Origin、CSRF 与 JSON。operator 失败认证使用指数退避并审计，不记录 bearer。人工密码 NFC 至少 12 字符，拒绝 Cc/Cf/bidi/zero-width。Provider key 与 operator token 均要求 owner、0600、regular non-symlink。

Harness、Bubblewrap 与 llama binaries/build trees 使用 realpath、owner/mode、commit/SHA-256 与 Linux process identity 门禁。PID/PGID 重用或 executable hash 不匹配时不发送信号。

## 发布

稳定状态不能靠文档声明。release gate 必须从当前树重算 source/lock/critical/evidence/archive bindings，确认 evidence 晚于 implementation commit 且 smoke generation commit/tree 正是当前 critical path。根 workflow 以 full SHA pin actions。未取得实际 CI run 与 branch protection 证据时保持 candidate；禁止自动 push、merge、tag 或 GitHub Release。
