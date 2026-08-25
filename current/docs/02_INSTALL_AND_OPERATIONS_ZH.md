# 0.6.6 候选安装与运维

当前是 audit candidate，不是可交付 stable。`release-status.json` 的 `controlledUseAllowed=false` 与当前 candidate `deliverableStatus` 是权威状态；旧分支 PASS 不为本修订续期。

## 本地候选检查

```bash
cd current/bridge
npm ci
npm run build
npm test
cd ..
node scripts/verify-release-gate.mjs --root . --audit-candidate
```

只有审计/测试环境可向安装器传 `--audit-candidate`。普通安装必须拒绝 candidate；禁止 `--skip-self-tests` 绕过 stable 门禁。未显式指定路径时，候选 runtime 使用 commit 区分：

```text
~/.local/share/codex-harness-bridge/0.6.6-candidate-<implementationCommit12>
```

后缀必须是 `release-status.json` 所绑定真实 implementation commit 的前 12 位小写十六进制；metadata-only seal commit 不得充当 candidate identity。MCP 注册、doctor、Dashboard、日志和 evidence 同时记录完整 implementation commit。

只有完整 stable gate 与归档链通过后才能使用 `~/.local/share/codex-harness-bridge/0.6.6`。

安装器事务式更新 runtime、schema-v7 config、skill、MCP 与 managed profile/preset；失败必须恢复旧版本。profile 中的 broker plugin 与 preset 必须和包内模板一致，不存在 MCP/local subprocess tool plane。

## 凭据

- Provider key：operator-owned、regular non-symlink、0600、至少 24 bytes；
- operator token：首次安装生成 32 random bytes（64 hex）；
- 人工 operator password：NFC、至少 12 Unicode characters、至多 16384 UTF-8 bytes，无 whitespace/Cc/Cf/bidi/zero-width；
- 认证失败：per-client exponential backoff、`Retry-After` 与 0600 credential-free audit。

匿名 Dashboard、日志、snapshot、task evidence 与归档不得含凭据。弱 6 字符兼容模式未启用。

## 运行与清理

安装后常用入口：

```text
<runtime>/scripts/doctor.sh
<runtime>/scripts/acceptance.sh
<runtime>/scripts/monitor.sh status|snapshot|stop
```

`doctor.sh` 必须报告 `executionMode`、`controlledUseAllowed` 和实际 `hostResourceProfile`。stable/controlled use 要求 resource enforcement 为 `required`，且 user systemd manager、cgroup v2 memory/cpu/pids/io controller 以及固定哈希的 `systemd-run`、`prlimit` 全部可用。缺任一项都应失败；`audit_only` 成功只表示诊断可运行。

取消任务或停止 Monitor 时，系统会撤销 broker lease、终止 Harness/relay/tool 的进程组并等待排空。若发现取消后仍有写入，必须保留证据、停止受控使用并按安全事件处理。认证审计默认最多四段、合计 1 MiB、保留 30 天；轮转/权限异常同样由 doctor/acceptance 阻止晋级。

卸载只移除活动注册并停止 monitor；版本化 runtime、config/state 与证据默认保留。彻底删除需要操作员另行明确授权。

## stable 晋级前

必须完成 fresh install、schema migration、same/cross-version rollback、reinstall/uninstall、资源耗尽与取消负测、确定性 ZIP 双构建、解包 manifest/build/test/install 重验、当前 Flash/Pro/negative smoke、绑定 qualification commit/tree 的根 GitHub Actions 与受保护 Provider attestation，以及实际启用的 branch protection required checks。`seal_ready` 只允许白名单元数据，`releaseTarget.sealCommit/sealTree` 保持 `null`，seal 身份由干净 checkout 动态推导。`docs/OWNER_DECISIONS.json` 的 DEC-001 至 DEC-004 还须由可归属 owner 明确批准并纳入实现提交。任一缺失继续保持 candidate。
