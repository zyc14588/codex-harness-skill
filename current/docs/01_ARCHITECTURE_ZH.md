# 0.6.6 最终版本候选架构

## 权限边界

Codex 是规划、合同冻结、逐文件审查、权威验证与集成的唯一总控。Harness/llama.cpp 只执行有界叶子。Bridge 持有状态、Provider key、一次性 capability、预算、隔离、worktree 与审计。

```text
Codex freezes plan/base/DAG/leases/commands
  └─ Worker starts mandatory outer Bubblewrap Harness
       ├─ trusted Adapter → loopback relay → exact Provider route
       ├─ trusted request-state client → exact Adapter-state routes
       └─ in-process tool definitions → tool relay → host Monitor
                                             └─ Bash/Pwsh sibling Bubblewrap
```

## 三种不相容 capability

- Provider bearer：48 hex，仅能认证该 task/attempt 的精确 `/chat/completions`；
- Adapter-state bearer：64 hex，仅能发布 runner snapshot、arm primary mutation 或记录 adapter request；
- tool bearer：64 hex，仅能调用该 task/attempt 的工具 broker。

三个 bearer 一次性从 worker 的匿名 stdin 管道进入受信任的 `harness-sandbox-entry`，不写入 URL、argv、worktree 或 sandbox file。task/attempt ID 是 route identity，不是秘密。Provider route 固定为 JSON `POST /provider/<task>/<attempt>/chat/completions`，Monitor 固定转发到配置基址的 `/chat/completions`。

Harness 外层 Bubblewrap 拥有独立 user/PID/network/mount namespace，只挂载任务 worktree、只读 Git common dir、固定 Harness/Node/Bridge/profile 与内部 socket。模型没有可调用的本地 shell/MCP 子进程；极简 preset 只加载 release-bundled `bridge-brokered-tools.mjs`，安装与启动均比较其精确模板。

## 工具执行

模型初始可见 `bash`/`pwsh`、`str_replace_editor`、`capability_catalog` 与 `capability_enable`，但它们都是受信任的进程内 RPC 定义。

- Bash/Pwsh：Monitor 在宿主侧启动独立 Bubblewrap 兄弟沙箱。环境从空对象构造，无 `DEEPSEEK_*`、`CODEX_HARNESS_*`、socket、secret/state mount 或网络；`/proc` 只见工具沙箱进程。
- editor：Monitor 进行路径 containment、lease、symlink、大小与原子写校验。
- progressive tools：只有冻结合同授权并显式 enable 后才出现；验证命令只能按冻结 index 选择。

模型工具永远拿不到 Provider/Adapter/tool bearer。最终 lease 与 diff 门禁仍 fail closed。

所有 broker 调用都绑定 task/attempt registry lease。attempt 替换、AbortSignal、超时或 Monitor 排空会先撤销 lease，再终止已验证身份的独立进程组；TERM 后仍存活才 KILL。旧 attempt 的延迟回调不能再写工作树或返回成功。Harness 本体、relay 与每个 broker sibling 均被同一宿主资源 profile 包裹。

受控资源 profile 使用固定 realpath/SHA-256 的 `systemd-run --user --scope` 和 `prlimit`。动态探针必须从实际 cgroup v2 与 `/proc` 同时读回 MemoryMax、CPUQuota、TasksMax、IOWeight、RuntimeMaxSec 和 RLIMIT；任一 controller 未委派、值不一致或探针缺失都禁止 controlled use。工作树另按实际 allocated bytes 监控。`audit_only` 仅供候选诊断，不是降级后的受控模式。

editor、目录列表与 repository read 的模型可见输出统一按 UTF-8 字节分页，单页硬上限 49,152 bytes（估算 12,288 tokens），并返回 `offset_bytes`、`max_bytes` 与截断元数据。operator 认证失败审计按来源聚合，采用有界来源状态、最多四段/总计 1 MiB/30 天保留，防止未认证流量造成日志磁盘放大。

## 请求状态与 Thinking Policy

runner visible、assembled、Adapter 与 wire tool snapshot 必须相关一致。Minimal Flash attempt 固定 `thinking=disabled/off`；初次有界变更请求在无 diff 时只强制已披露的核心原生工具。Pro attempt 固定 enabled/high、禁止 `tool_choice`，并要求每轮真实 `reasoning_content` 按 hash/长度/tool-call ID 完整回放。任何遗漏在 Provider I/O、Token 计量与 split-memory 写入之前失败。

## 权威验证

```text
terminal Agent worktree
  → collect canonical binary patch + paths
  → exact Codex review + reviewed fingerprint
  → detached verification worktree at baseCommit
  → git clean -ffdx
  → apply only reviewed.patch
  → reproduce reviewed fingerprint
  → run frozen commands
  → compare verified/current/reviewed fingerprints
  → remove verification worktree
  → only then allow local branch commit
```

Agent worktree 的 ignored/untracked residue 不进入验证树。验证证据绑定 base commit、patch SHA-256、命令结果 fingerprint、排除的 ignored 数量和 cleanup 结果。

## 发布边界

`current/` 是唯一活动源码。`archive/` 只保存 withdrawn/historical material。candidate 不可受控安装。非循环封印状态机把三个身份分开：candidate 永远绑定 implementation commit；GitHub Actions 与 attestation 绑定 qualification commit/tree；`seal_ready` 提交只可加入白名单元数据，并把自身 `sealCommit/sealTree` 保持为 `null`，由 release gate 从干净 checkout 的 `HEAD`/tree 动态推导，禁止提交自包含自身哈希。归档随后只在隔离 staging 中生成 `package-origin.json`。stable 安装还必须验证归档、sidecar、validation JSON 与 attestation chain。任何源码、critical hash、workflow 或未经许可的后实现元数据改变都会使旧证据失效。
