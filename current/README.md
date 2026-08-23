# Codex ↔ DeepSeek Harness Bridge 0.6.6

```text
Release status: candidate / final-version qualification in progress
Controlled use: forbidden
Canonical source: current/
```

这是仓库唯一活动源码入口。仓库根只提供治理入口，旧 R6.4 handoff、0.6.5 baseline、R2/R3/R4 归档与旧 smoke 均位于 `archive/`，不能为当前候选续期。

0.6.6 修复了审计发现的 Provider capability 链：Provider、request-state Adapter 与工具 broker 使用三个不同的一次性 bearer；能力通过匿名 stdin 管道交给受信任的隔离入口，URL 只包含非秘密 task/attempt ID。模型可见的 Bash/Pwsh 在宿主监控进程启动的独立 Bubblewrap 兄弟沙箱中执行，没有 Provider/Adapter/tool 环境、监控 socket、宿主状态挂载或网络能力。Provider route 只接受精确的 JSON `POST /chat/completions`。

权威 verification 不再在 Agent 施工树运行。Codex review 封存标准 binary patch 与 fingerprint，Bridge 从 `baseCommit` 创建新的 detached worktree，执行 `git clean -ffdx`，只应用 reviewed patch，再运行冻结命令。ignored/untracked poison 不会进入验证树；通过后仍要求 current/reviewed/verified fingerprint 一致才允许本地提交。

操作员默认凭据仍是 256-bit 随机令牌。人工密码采用 NFC，至少 12 个字符，拒绝空白、Cc/Cf、双向控制和零宽字符；认证失败具有指数退避与不含凭据的 0600 审计。弱 6 字符兼容模式未启用。

## 候选验证

在本目录执行：

```bash
cd bridge
npm ci
npm run build
npm test
```

候选 release gate 必须显式确认非交付状态：

```bash
node scripts/verify-release-gate.mjs --root . --audit-candidate
```

安装器同样只允许显式 audit-candidate 模式；在 `release-status.json` 成为严格绑定的 0.6.6 stable 前，不得用于受控安装或生成 stable 归档。

## 尚未满足的外部门禁

RC 基线的完整 regression 与 transactional package/rollback 已通过；最终版本字节的同修订证据仍在生成。当前 revision 的真实 Flash/Pro smoke、根 GitHub Actions 实际 PASS run、branch protection required checks 与最终 deterministic archive/unpacked revalidation 尚未全部完成。权威状态只看 [`release-status.json`](release-status.json)，不得从版本号或历史报告推断 stable/PASS。
