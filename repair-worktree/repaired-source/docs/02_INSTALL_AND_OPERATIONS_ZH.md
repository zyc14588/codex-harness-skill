# 0.6.5 安装与运维

## 发布状态先决条件

安装器先校验 `MANIFEST_SHA256.txt`，再执行 `scripts/verify-release-gate.mjs`：

- `withdrawn`：无条件拒绝；
- `candidate`：仅在显式 `--audit-candidate` 下安装，且保持 `controlledUseAllowed=false`；
- `stable`：要求 `DELIVERABLE_PASS`、每个 gate 精确 `PASS`、provenance/lockfile/证据 SHA-256 绑定有效，且禁止 `--skip-self-tests`。

当前包是 stable；仍须先验证归档 sidecar、manifest 与 release gate，再按受控模式安装。

## 前置条件

- Linux、Node `>=22.12.0`、Git、Python 3、`sha256sum`、Bubblewrap；
- Codex CLI；
- 固定且干净的 DeepSeek Harness checkout；
- 至少一个明确的绝对仓库允许根；
- operator-owned、非 symlink、mode-0600 Provider key 文件。

稳定受控安装：

```bash
sha256sum -c MANIFEST_SHA256.txt
scripts/install.sh \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /absolute/repository/root \
  --provider-key-file /absolute/private/provider.key
```

安装器固定 Harness commit/build tree 与 Bubblewrap 可执行文件 SHA-256；事务式安装 runtime、schema-v7 config、skill、MCP、minimal profile/preset、私有 Broker key，并启动 monitor。任何失败都恢复先前 runtime、config、skill、profile/preset 和 monitor 状态。

## 私有状态

```text
runtime:        ~/.local/share/codex-harness-bridge/0.6.5
config:         ~/.config/codex-harness-bridge/config.json
state:          ~/.local/state/codex-harness-bridge
operator token: <state>/secrets/operator.token
provider key:   <state>/secrets/provider.key
skill:          $CODEX_HOME/skills/codex-harness
```

secret 目录必须是操作员拥有、mode-0700、非 symlink；secret 文件必须是 mode-0600 普通文件。Harness 进程永远不读取 Provider key。

## Monitor

```bash
~/.local/share/codex-harness-bridge/0.6.5/scripts/doctor.sh
~/.local/share/codex-harness-bridge/0.6.5/scripts/acceptance.sh
~/.local/share/codex-harness-bridge/0.6.5/scripts/monitor.sh status
~/.local/share/codex-harness-bridge/0.6.5/scripts/monitor.sh snapshot
~/.local/share/codex-harness-bridge/0.6.5/scripts/monitor.sh stop
```

Dashboard 只监听 loopback，但 loopback 不是身份边界。浏览器把 operator token 仅放在 `sessionStorage`，API 每次要求 Bearer；mutation 额外校验 Origin 与 CSRF。页面首次缺少令牌时只提示一次，取消或 `401` 后暂停自动认证并显示“输入令牌”按钮；`403` 不再删除仍然有效的 Bearer。CLI snapshot 也使用私有 operator token。

安装器通过 `process.execPath` 固定真实 Node 二进制，而不是记录 `command -v node` 可能返回的 shell 包装器。Doctor 与每次 Bubblewrap 启动前都会验证 managed minimal preset 的 Node 命令与 Bridge 当前运行时完全一致。

## 配置与迁移

Bridge config 当前为 schema v7；安装器支持旧 schema 4–6 → 7，并保留受支持的 roots、预算、价格和 llama 参数。危险的 managed/CLI binary 配置若缺少绝对 realpath 与 SHA-256 会被禁用。

允许传入 Harness/llama 的环境变量仅限：

```text
PATH LANG LC_ALL TERM COLORTERM NO_COLOR
NODE_EXTRA_CA_CERTS SSL_CERT_FILE
```

拒绝 secret-bearing 名称、代理变量、重复项与仓库 `.env*`。llama API key 环境变量固定为 `LLAMA_CPP_API_KEY`；CLI Prompt 只经私有 prompt file。

## 回滚与卸载

同版本覆盖和跨版本升级都由 package acceptance 注入后期注册失败验证回滚。卸载移除活动 MCP/skill/profile/preset 并停止 monitor；版本化 runtime、config、state、日志和任务证据保留，彻底删除需操作员另行明确授权。

## 该异常的处置

出现 `provider_protocol: enabled-thinking Provider tool call omitted non-empty reasoning_content` 时：

1. 当前 immutable attempt 标记为不可重试的基础设施失败；
2. 同 attempt 后续 Provider 请求在本地被拒绝；
3. 不新增 Provider usage，不写 task-shape 负样本；
4. 只在 PID/start-time/PGID/executable hash 全部匹配后终止 Harness 进程组；
5. 保留不含 reasoning 正文与凭据的脱敏终态证据。

不得通过伪造、清空、摘要或删除 `reasoning_content` 历史继续请求。
