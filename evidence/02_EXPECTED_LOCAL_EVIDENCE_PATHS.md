# 本机权威证据路径

Codex 应从用户机器读取，而不是猜测：

```text
Runtime:
/home/zyc14588/.local/share/codex-harness-bridge/0.6.4

Bridge config:
/home/zyc14588/.config/codex-harness-bridge/config.json

默认 DSH_HOME:
/home/zyc14588/.dsh

Managed profile:
/home/zyc14588/.dsh/profiles/codex-minimal-headless

Managed preset:
/home/zyc14588/.dsh/.agent-presets/codex-bridge-minimal

Task id:
plan-1787365388387-r6-4-minimal-aux-isolation-smoke
```

任务目录的位置取决于 `config.json` 中的 `stateRoot`。可先读取配置，再使用：

```bash
find "<stateRoot>" -type f -path '*/plan-1787365388387-r6-4-minimal-aux-isolation-smoke/task.json' -print
```

不得复制以下秘密材料进代码仓库或交付包：

```text
DEEPSEEK_API_KEY
Authorization header
credentials.yaml
.env 中的密钥
原始未脱敏 API 请求头
```
