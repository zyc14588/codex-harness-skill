# Codex ↔ DeepSeek Harness Bridge 0.6.6

```text
Release status: candidate / public-history acceptance implemented; full requalification required
Controlled use: forbidden
Canonical source: current/
```

这是仓库唯一活动源码入口。仓库根只提供治理入口，旧 R6.4 handoff、0.6.5 baseline、R2/R3/R4 归档与旧 smoke 均位于 `archive/`，不能为当前候选续期。

0.6.6 修复了审计发现的 Provider capability 链：Provider、request-state Adapter 与工具 broker 使用三个不同的一次性 bearer；能力通过匿名 stdin 管道交给受信任的隔离入口，URL 只包含非秘密 task/attempt ID。模型可见的 Bash/Pwsh 在宿主监控进程启动的独立 Bubblewrap 兄弟沙箱中执行，没有 Provider/Adapter/tool 环境、监控 socket、宿主状态挂载或网络能力。Provider route 只接受精确的 JSON `POST /chat/completions`。

本轮预发布修复还增加了四个 fail-closed 边界：取消信号贯穿 worker、Harness、relay、broker 与进程组并由 task/attempt registry 终止旧 lease；受控执行必须由固定哈希的 `systemd-run`/`prlimit` 同时证明 cgroup v2 与 RLIMIT 限额；模型可见读取按 UTF-8 字节分页且每页不超过 49,152 bytes；operator 认证审计按来源聚合并受段数、总字节与保留期约束。`audit_only` 资源模式只允许候选审计，不能把 `controlledUseAllowed` 提升为 true。

公开历史中的邮箱账户标识、Owner 自有 home-path alias 与三个不可访问 gitlink 已由 Owner 逐项接受；findings 仍完整保留，历史未被重写或描述为已脱敏。该接受不覆盖任何新增个人信息、凭据或第三方数据。active source、package staging、archive manifest 与 final ZIP 现在分别执行零 gitlink/零 `.gitmodules` 门禁；包与 ZIP 另拒绝 symlink 和嵌套 `.git` metadata。

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

安装器同样只允许显式 audit-candidate 模式；候选的默认安装目录带 implementation commit 前缀，不能占用稳定版 `0.6.6` 目录。在 `release-status.json` 成为严格绑定的 0.6.6 stable 前，不得用于受控安装或生成 stable 归档。

## 发布门禁

每项资格化结果只以 [`release-status.json`](release-status.json) 及其 SHA-256 绑定的当前修订证据为准。发布采用两阶段封印：先在干净的 canonical checkout 上以仓库外 GitHub 证据取得 `seal-ready`，再复制到隔离 staging、写入 `package-origin.json` 并构建归档；canonical source 不得被打包元数据反向修改。根 GitHub Actions 的精确目标提交、受保护 Provider job 与 artifact attestation、branch protection required checks，以及最终 deterministic archive/unpacked revalidation 都必须独立通过。DEC-002 已实现验证；DEC-001 仍须实际配置并 API 核验 required checks/branch governance。任一项未通过时，状态必须保持 candidate；不得从版本号、旧分支或历史报告推断 stable/PASS。
