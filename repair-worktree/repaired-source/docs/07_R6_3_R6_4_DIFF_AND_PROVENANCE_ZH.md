# R6.3 → 已安装 R6.4 差异与来源报告

## 权威来源

- 0.6.3 比较基线：交接包 `source/CODEX_HARNESS_BRIDGE_M1_R6_3_BASELINE`。
- 0.6.4 修复基线：本机已安装目录 `/home/zyc14588/.local/share/codex-harness-bridge/0.6.4` 的只读回收副本。
- 回收时间：`2026-08-22T03:06:24Z`。
- 独立修复仓库初始提交：`da1cfd2e74980ee325b5f4bfedf361d24c3d0d2c`。

已安装 runtime 与回收副本的相对路径树哈希均为：

```text
555edb6c760d2c30e7e943755b6519c86d6a160c9e04d0aea504ceb7d95c849f
```

已安装 managed profile 与回收副本的树哈希均为：

```text
9143512bb2d6856675e79a9ac360076fe3db4ec6ac38b292e7cd67db60103a0d
```

已安装 managed preset 与回收副本的树哈希均为：

```text
95099e8928f0a1d35413fa94c52667fb2db5267d0f59b6b507743f181db4ba8b
```

逐文件 `diff -qr` 对上述三对目录均无输出。MCP 注册实际指向 `0.6.4/bridge/dist/index.js`。失败时 monitor PID 记录为 `126153`，`daemonPath` 指向同一 runtime 的 `bridge/dist/monitor-daemon.js`，monitor 日志也报告版本 `0.6.4`；进程在失败清理后已停止。

## 源码与 sourcemap

已安装 0.6.4 包含完整 `bridge/src`、`bridge/dist` 和 `.map`。sourcemap 的 `sources` 正确指回对应 TypeScript 文件，例如：

```text
dist/monitor.js.map → ../src/monitor.ts
dist/test/minimal-mutation-policy.test.js.map → ../../src/test/minimal-mutation-policy.test.ts
```

sourcemap 不含 `sourcesContent`，但同一安装包含被引用的 TypeScript 源文件；候选构建必须重新执行 strict TypeScript build，并以构建后源码、dist 和 sourcemap 一致性作为门禁。

## 0.6.3 与 0.6.4 的静态差异

`git diff --no-index --stat` 结果为 54 个文件变化、729 行新增、363 行删除。核心变化包括：

- 版本字段从 0.6.3 更新为 0.6.4；
- minimal mutation policy 从 `minimal-flash-required-v1` 更新为 `minimal-flash-required-v2`；
- 新增 session title 辅助请求启发式分类与 bypass 遥测；
- managed profile 声明禁用 `session-title-llm`；
- direct acceptance 和文档新增 auxiliary isolation 断言；
- 单元测试由 58 项增加到 60 项。

因此 0.6.4 变化确实存在于已安装 runtime；本次失败不是“0.6.4 代码完全未部署”。

## 有效组合的确定性失败证据

在只读回收件的临时副本上运行真实固定 Harness CLI：

```text
dsh --profile codex-minimal-headless --dump-config
```

CLI 给出以下警告：

```text
patch: name mismatch for "headless-runner"
(expected "@deepseek-ai/dsh-headless", got "./bridge-headless-runner.mjs"), skipping
```

有效配置保留了 stock `@deepseek-ai/dsh-headless` runner；Bridge 的 `bridge-headless-runner.mjs` 没有挂载。该自定义 runner 中的 preset mount 和 `visibleTools` preflight 因而从未执行。有效配置虽禁用了 process-global core tools，却没有用 Bridge runner 为新 Agent 挂载 `codex-bridge-minimal`，最终正式 Agent 请求的 wire tool catalog 为空。

根因分类确定为：

```text
profile_or_preset_composition_failure
```

当前没有证据支持把 `stale_or_mixed_installation` 作为第一根因。后续动态 profile probe 仍须逐层记录 runner visible、assembled、adapter input、wire 和 proxy parsed tools，防止修正 patch 后出现第二个序列化缺陷。
