# 安装与运维

## 1. 前置条件

- Linux；
- Node.js `>=22.12`；
- Git、Python 3、`tar`、`sha256sum`、`timeout`；
- Codex CLI；
- DeepSeek Harness Git checkout；
- 使用 `--build-harness` 时需要 pnpm。

## 2. 安装与升级

```bash
./scripts/install.sh \
  --harness-root /home/zyc14588/deepseek-harness \
  --allowed-root /home/zyc14588
```

常用参数：

```text
--no-build-harness      复用现有 apps/cli/lib
--dsh-home PATH         指定 Harness 用户数据根
--enable-llama-cpp      开启本地简单叶子自动路由
--disable-llama-cpp     关闭本地路由
--monitor-port PORT     改 Dashboard 端口
--allow-dirty-harness   明确接受 tracked dirty checkout
```

安装是事务式的。失败时恢复旧 runtime、config、Codex skill/MCP、monitor，以及 Bridge 管理的极简 profile/preset。

## 3. 配置迁移

安装器接受 schema v1–v6，输出 schema v6：

- 所有 budget 固定 `gatePolicy=input_output_tokens`；
- `enforcement=hard`；
- API calls/cost 保留为参考字段；
- Pro complex 使用 `ceilingPolicy=unbounded`，但仍有有限 input/output Token gates；
- 增加并发、极简模式和 split-memory 设置；
- 保留自定义价格、llama.cpp binary/args 和 operator 参数。

旧 `advisory` 值不会继续产生非阻断 Token 语义；R6 对所有模型执行路径都硬执行 input/output Token gates。

从 R6.0/R6.1/R6.2 升级到 R6.3 时，配置 Schema 仍为 v6；安装器会替换 Bridge 管理的 minimal preset/profile。拆分记忆使用内部 schema v3：旧 schema-v1/v2 画像不再生效，首次 advice 会报告被忽略样本数，首次写入同一画像的新事件时旧文件会归档到 `legacy/`。无需人工删除旧证据。

## 4. 监控

日常无需手动启动。Codex MCP 任务会按需启动 monitor。

```bash
~/.local/share/codex-harness-bridge/0.6.3/scripts/monitor.sh status
~/.local/share/codex-harness-bridge/0.6.3/scripts/monitor.sh snapshot
~/.local/share/codex-harness-bridge/0.6.3/scripts/monitor.sh stop
```

Dashboard：`http://127.0.0.1:43127`。

Web 可调整默认/最大/Pro complex Token gates和活动 budget group 覆盖。修改只影响下一次预算检查，不改写既有 usage。API 调用数和金额字段仍可配置，用于告警和容量观察。

## 5. 拆分记忆运维

记忆默认启用。Codex 可用：

```text
controller_split_advice   创建计划前读取建议
controller_split_memory   查看仓库全部画像
```

Web 的任务/费用区域显示相关画像。画像是本地工程运行证据，不是模型训练数据，也不上传。

R6.3 会自动隔离 R6.0 schema-v1 与 R6.1/R6.2 旧画像。只有在确实需要人为清空全部任务族经验时，才应先停止活动任务，再备份并删除：

```text
<stateRoot>/split-memory/<repo-key>/
```

不要在活动 worker 执行期间修改单个 profile JSON。

## 6. llama.cpp

Dashboard 可选择：

- `external_server`；
- Bridge 管理的自定义 `llama-server`；
- 每任务自定义 `llama-cli`。

本地模型仅接收 `trivial/small` 精确文件叶子。合格的连接、进程、timeout 或结构化输出异常可恢复文件快照后回退 `deepseek-v4-flash`。Token 超限、scope/Git 安全失败和取消不得 fallback。

## 6.1 R6.3 minimal 实机冒烟验收

升级并重启 Codex 后，先创建一个只写一个精确 JSON 文件的 `minimal + deepseek-v4-flash` 叶子。验收必须同时看到：

```text
changedPaths = [精确目标文件]
review = approved
verification = PASS
reviewedFingerprint = verifiedFingerprint
```

若任务状态出现 `toolProtocolRecoveryCount > 0`，说明 Provider 返回了可安全恢复的 DSML、Markdown Shell 或需要规范化的结构化调用；应核对 `toolProtocolRecoveryKinds` 和 `toolProtocolRecoveredTools`，并以实际 diff 证明工具确已执行。若 recovery count 为 0，则必须看到 `toolProtocolNativeCallCount > 0`，或者有其他可信的真实工具执行证据。若出现 `toolProtocolFailure`、`minimal_tool_plane` 或 `no_effect`，停止并保留证据，不得用 repair 反复消耗预算。

## 7. 诊断、验收、卸载

```bash
~/.local/share/codex-harness-bridge/0.6.3/scripts/doctor.sh
~/.local/share/codex-harness-bridge/0.6.3/scripts/acceptance.sh
~/.local/share/codex-harness-bridge/0.6.3/scripts/uninstall.sh
```

卸载移除 Codex MCP、skill 和 Bridge 管理的极简 profile/preset，停止 monitor；保留 versioned runtime、config、state、logs 和证据。
